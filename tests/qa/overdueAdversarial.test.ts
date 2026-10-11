/**
 * qa/overdueAdversarial.test.ts —— QA 独立对抗性验证：欠账四策略数学（PRD §4.4.4 / §6.3 硬约束 #5）。
 * 规则 4：重排即债务清零 —— 每个 overdue hit 恰好一条 mutation。
 * 规则 6：展期不得突破 2026-12-05。
 * PRD §4.4.4-B：compress 日额度上浮【至时间校验上限】（= maxDailyHits 封顶）。
 */
import { describe, expect, it } from 'vitest';
import { applyStrategy, computeOverdue, previewStrategy } from '../../src/scheduler/overdue';
import { maxDailyHits, planRounds, planFinishDate } from '../../src/scheduler/expand';
import { validatePlan } from '../../src/scheduler/validate';
import { defaultPlanParams } from '../../src/config/constants';
import type { HitRecord, PlanParams, Tier, ValidationInput } from '../../src/scheduler/types';

const START = '2026-10-11';
const DEADLINE = '2026-12-05';

function mkInput(over: Partial<PlanParams> = {}, counts = { 3: 1050 }): ValidationInput {
  return {
    params: defaultPlanParams('fallback', {
      tierRounds: { 1: 0, 2: 0, 3: 2, 4: 0 },
      startDate: START,
      deadlineDate: DEADLINE,
      sprintStartDate: DEADLINE,
      ...over,
    }),
    tierCounts: counts,
    steadyWords: [],
  };
}

let seq = 0;
function overdueHit(over: {
  scheduledDate: string;
  wordId?: string;
  tier?: Tier;
  status?: HitRecord['status'];
  roundNo?: number;
}): HitRecord {
  seq += 1;
  return {
    id: `h${seq}`,
    planId: 'p1',
    wordId: over.wordId ?? `w${seq}`,
    tier: over.tier ?? 3,
    roundNo: over.roundNo ?? 1,
    listNo: 0,
    scheduledDate: over.scheduledDate,
    modality: 'visual',
    status: over.status ?? 'overdue',
  };
}

function mkOverdue(n: number, before: string): HitRecord[] {
  return Array.from({ length: n }, (_, i) =>
    overdueHit({ scheduledDate: before, wordId: `w${i % 1050}` }),
  );
}

function assertDebtCleared(outcome: ReturnType<typeof applyStrategy>, overdue: HitRecord[]) {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  const ids = outcome.hitMutations.map((m) => m.hitId);
  expect(new Set(ids).size).toBe(overdue.length); // 无遗漏、无重复
  expect(ids.sort()).toEqual(overdue.map((h) => h.id).sort()); // 每个 overdue hit 恰好一条 mutation
  for (const m of outcome.hitMutations) {
    expect(['reschedule', 'defer']).toContain(m.action);
    if (m.action === 'reschedule') {
      expect(m.newScheduledDate).toBeDefined();
      expect(m.newScheduledDate! <= DEADLINE).toBe(true); // 任何重排不越 deadline
    }
  }
}

// ===== 欠账检测 =====

describe('computeOverdue 阈值判定', () => {
  it('count 仅统计 pending/overdue 且 scheduled_date < today；done/deferred 不计', () => {
    const hits = [
      overdueHit({ scheduledDate: '2026-10-10', status: 'overdue' }),
      overdueHit({ scheduledDate: '2026-10-09', status: 'pending' }),
      overdueHit({ scheduledDate: '2026-10-08', status: 'done' }),
      overdueHit({ scheduledDate: '2026-10-07', status: 'deferred' }),
      overdueHit({ scheduledDate: '2026-11-01', status: 'pending' }), // 未来，不算
    ];
    const s = computeOverdue(hits, '2026-10-20', 100);
    expect(s.count).toBe(2);
    expect(s.threshold).toBe(200);
    expect(s.mustReschedule).toBe(false);
  });

  it('count > 2×dailyHits → 强制重排', () => {
    const hits = mkOverdue(201, '2026-10-10');
    expect(computeOverdue(hits, '2026-10-20', 100).mustReschedule).toBe(true);
    expect(computeOverdue(mkOverdue(200, '2026-10-10'), '2026-10-20', 100).mustReschedule).toBe(false);
  });

  it('连续 ≥3 天未学且 count>0 → 强制重排（idle=3 恰好触发）', () => {
    const hits = mkOverdue(5, '2026-10-10');
    expect(computeOverdue(hits, '2026-10-20', 100, '2026-10-17').mustReschedule).toBe(true);
    expect(computeOverdue(hits, '2026-10-20', 100, '2026-10-18').mustReschedule).toBe(false);
    expect(computeOverdue(hits, '2026-10-20', 100, '2026-10-20').mustReschedule).toBe(false);
  });
});

// ===== 策略一：extend =====

describe('extend（展期）', () => {
  it('有余量的小计划：展期成功且不突破 deadline，债务清零', () => {
    const input = mkInput(undefined, { 3: 400 });
    const today = '2026-11-20';
    const overdue = mkOverdue(10, '2026-11-15');
    const outcome = applyStrategy('extend', input, overdue, undefined, today);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.newFinishDate <= DEADLINE).toBe(true);
      expect(outcome.newFinishDate).toBe(planFinishDate(outcome.newPlan, input.tierCounts));
    }
    assertDebtCleared(outcome as never, overdue);
  });

  it('近全窗口计划（finish=12-04，仅 1 天余量）：跨 2 天的展期 → DeadlineExceeded', () => {
    const input = mkInput(undefined, { 3: 1050 });
    // finish = 2026-12-04（窗口从 10-11 起 55 天），deadline 12-05 仅剩 1 天余量
    expect(planFinishDate(input.params, input.tierCounts)).toBe('2026-12-04');
    const overdue = mkOverdue(60, '2026-11-15'); // delta = ceil(60/39) = 2 → 12-06 > deadline
    const outcome = applyStrategy('extend', input, overdue, undefined, '2026-11-20');
    expect(outcome).toMatchObject({ ok: false, error: 'DeadlineExceeded' });
    if (!outcome.ok) expect(outcome.message).toContain('2026-12-05');
    // 预览层也要如实标注
    const preview = previewStrategy('extend', input, overdue, '2026-11-20');
    expect(preview.deadlineExceeded).toBe(true);
  });

  it('preview 与 apply 的 extend 增量天数一致（ceil(overdue/dailyHits)）', () => {
    const input = mkInput(undefined, { 3: 400 });
    const overdue = mkOverdue(31, '2026-11-15');
    const base = validatePlan(input);
    const delta = Math.max(1, Math.ceil(overdue.length / Math.max(1, base.dailyHits)));
    const preview = previewStrategy('extend', input, overdue, '2026-11-20');
    const finish = planFinishDate(input.params, input.tierCounts);
    expect(preview.newFinishDate).toBe(addDaysISO(finish, delta));
  });
});

function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ===== 策略二：compress =====

describe('compress（压缩）—— PRD §4.4.4-B「日额度上浮至时间校验上限」', () => {
  const HORIZON_TODAY = '2026-10-31'; // 第 1 轮第 21 天

  it('正常欠账量：摊入窗口后日额度 ≤ maxDailyHits，债务清零', () => {
    const input = mkInput(undefined, { 3: 1050 });
    const overdue = mkOverdue(600, '2026-10-20');
    const maxDaily = maxDailyHits(input.params); // floor(60×60/12) = 300
    expect(maxDaily).toBe(300);
    const preview = previewStrategy('compress', input, overdue, HORIZON_TODAY);
    expect(preview.newDailyHits).toBeLessThanOrEqual(maxDaily);
    const outcome = applyStrategy('compress', input, overdue, undefined, HORIZON_TODAY);
    assertDebtCleared(outcome as never, overdue);
  });

  it('超阈值欠账（12000 条）：日额度必须仍被 maxDailyHits 封顶（PRD「上浮至…上限」）', () => {
    const input = mkInput(undefined, { 3: 1050 });
    const overdue = mkOverdue(12000, '2026-10-20');
    const maxDaily = maxDailyHits(input.params);
    expect(maxDaily).toBe(300);
    // 无封顶时摊入 35 天 → ceil(12000/35)+39 = 382 > 300，PRD 明确上浮上限为时间校验上限
    const preview = previewStrategy('compress', input, overdue, HORIZON_TODAY);
    expect(preview.newDailyHits).toBeLessThanOrEqual(maxDaily);
    const outcome = applyStrategy('compress', input, overdue, undefined, HORIZON_TODAY);
    if (outcome.ok) expect(outcome.newDailyHits).toBeLessThanOrEqual(maxDaily);
  });

  it('compress 不改变总工期（deadlineExceeded 恒 false，newFinishDate 不变）', () => {
    const input = mkInput(undefined, { 3: 1050 });
    const overdue = mkOverdue(300, '2026-10-20');
    const preview = previewStrategy('compress', input, overdue, HORIZON_TODAY);
    expect(preview.deadlineExceeded).toBe(false);
    expect(preview.newFinishDate).toBe(planFinishDate(input.params, input.tierCounts));
  });

  it('摊入日期全部落在 [today, deadline] 区间', () => {
    const input = mkInput(undefined, { 3: 1050 });
    const overdue = mkOverdue(500, '2026-10-20');
    const outcome = applyStrategy('compress', input, overdue, undefined, HORIZON_TODAY);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      for (const m of outcome.hitMutations) {
        if (m.action === 'reschedule') {
          expect(m.newScheduledDate! >= HORIZON_TODAY).toBe(true);
          expect(m.newScheduledDate! <= DEADLINE).toBe(true);
        }
      }
    }
  });
});

// ===== 策略三：drop_round =====

describe('drop_round（降轮）', () => {
  it('R=3 层：砍最后一轮 → tierRounds 3→2，被砍轮 hit 降 deferred，其余摊入，债务清零', () => {
    const input = mkInput({ tierRounds: { 1: 0, 2: 0, 3: 3, 4: 0 } }, { 3: 1050 });
    const overdue = [
      ...mkOverdue(40, '2026-10-20'),
      ...Array.from({ length: 20 }, () =>
        overdueHit({ scheduledDate: '2026-10-20', roundNo: 3 }),
      ),
    ];
    const outcome = applyStrategy('drop_round', input, overdue, undefined, '2026-10-31');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.newPlan.tierRounds[3]).toBe(2);
      const dropped = outcome.hitMutations.filter((m) => m.reason.includes('移除'));
      expect(dropped.length).toBe(20);
      for (const m of dropped) expect(m.newStatus).toBe('deferred');
    }
    assertDebtCleared(outcome as never, overdue);
  });

  it('R=2 层（保底轮数）：applyStrategy 以可理解的错误拒绝，而非产出坏计划', () => {
    const input = mkInput(undefined, { 3: 1050 });
    const overdue = mkOverdue(10, '2026-10-20');
    let msg = '';
    try {
      applyStrategy('drop_round', input, overdue, undefined, '2026-10-31');
      expect.unreachable('R=2 时不应成功');
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain('minimum 2 rounds');
  });

  it('preview 对 R=2 层的 drop_round 不崩溃且不改变轮次', () => {
    const input = mkInput(undefined, { 3: 1050 });
    const overdue = mkOverdue(10, '2026-10-20');
    expect(() => previewStrategy('drop_round', input, overdue, '2026-10-31')).not.toThrow();
    const p = previewStrategy('drop_round', input, overdue, '2026-10-31');
    expect(p.validation.totalHits).toBe(validatePlan(input).totalHits); // 不可砍 → 数字不变
  });
});

// ===== 策略四：freeze =====

describe('freeze（冻结稳固词）', () => {
  it('稳固欠账词 → deferred 至该层末轮窗口末日（≤deadline）；非稳固摊入；债务清零', () => {
    const input = mkInput(undefined, { 3: 1050 });
    input.steadyWords = Array.from({ length: 50 }, (_, i) => ({
      wordId: `steady${i}`,
      steady: true,
      tier: 3 as Tier,
    }));
    const overdue = [
      ...Array.from({ length: 50 }, (_, i) =>
        overdueHit({ scheduledDate: '2026-10-20', wordId: `steady${i}` }),
      ),
      ...mkOverdue(150, '2026-10-20'),
    ];
    const outcome = applyStrategy('freeze', input, overdue, undefined, '2026-10-31');
    assertDebtCleared(outcome as never, overdue);
    if (outcome.ok) {
      const lastEnd = planRounds(input.params, input.tierCounts)
        .filter((w) => w.tier === 3)
        .reduce((a, w) => (w.endDate > a ? w.endDate : a), START);
      const frozen = outcome.hitMutations.filter((m) => m.reason.includes('冻结') && m.newStatus === 'deferred' && m.action === 'defer');
      expect(frozen.length).toBe(50);
      for (const m of frozen) expect(m.newScheduledDate).toBe(lastEnd);
      expect(lastEnd <= DEADLINE).toBe(true);
    }
  });

  it('deferredIds 显式部分放弃：勾选词标 deferred 且不重复获得 reschedule', () => {
    const input = mkInput(undefined, { 3: 1050 });
    const overdue = mkOverdue(30, '2026-10-20');
    const outcome = applyStrategy('freeze', input, overdue, [overdue[0].id, overdue[5].id], '2026-10-31');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const byId = new Map(outcome.hitMutations.map((m) => [m.hitId, m]));
      expect(byId.get(overdue[0].id)?.newStatus).toBe('deferred');
      expect(byId.get(overdue[5].id)?.newStatus).toBe('deferred');
      expect(outcome.hitMutations.length).toBe(30); // 不翻倍
    }
  });
});

// ===== 时间口径一致性 =====

describe('四策略共同不变量', () => {
  const strategies = ['extend', 'compress', 'drop_round', 'freeze'] as const;

  it('任一策略的 mutation 都不早于 today、不晚于 deadline', () => {
    for (const s of strategies) {
      const input =
        s === 'drop_round'
          ? mkInput({ tierRounds: { 1: 0, 2: 0, 3: 3, 4: 0 } }, { 3: 1050 })
          : mkInput(undefined, { 3: 1050 });
      const overdue = mkOverdue(120, '2026-10-20');
      const outcome = applyStrategy(s, input, overdue, undefined, '2026-10-31');
      if (outcome.ok) {
        for (const m of outcome.hitMutations) {
          if (m.newScheduledDate) {
            expect(m.newScheduledDate >= '2026-10-31', `${s} mutation 早于 today`).toBe(true);
            expect(m.newScheduledDate <= DEADLINE, `${s} mutation 晚于 deadline`).toBe(true);
          }
        }
      }
    }
  });

  it('超额欠账在任何策略下都不会产出突破 deadline 的成功重排', () => {
    for (const s of strategies) {
      const input =
        s === 'drop_round'
          ? mkInput({ tierRounds: { 1: 0, 2: 0, 3: 3, 4: 0 } }, { 3: 1050 })
          : mkInput(undefined, { 3: 1050 });
      const overdue = mkOverdue(2000, '2026-10-20');
      const outcome = applyStrategy(s, input, overdue, undefined, '2026-11-25');
      if (outcome.ok) {
        expect(outcome.newFinishDate <= DEADLINE, `${s} newFinishDate 突破 deadline`).toBe(true);
      } else {
        expect(outcome.error).toBe('DeadlineExceeded');
      }
    }
  });
});
