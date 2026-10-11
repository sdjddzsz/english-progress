/**
 * overdue.test.ts —— 欠账四策略 preview/apply + 阈值触发 + DeadlineExceeded（硬约束 #5）。
 */
import { describe, expect, it } from 'vitest';
import {
  STRATEGY_PLAIN_WORDS,
  applyStrategy,
  computeOverdue,
  previewStrategy,
} from '../../src/scheduler/overdue';
import { planFinishDate } from '../../src/scheduler/expand';
import type { HitRecord, PlanParams, TierWordCounts, WordSteadiness } from '../../src/scheduler/types';
import { defaultPlanParams } from '../../src/config/constants';

function params(over: Partial<PlanParams> = {}): PlanParams {
  return defaultPlanParams('recommended', over);
}

const SMALL_COUNTS: TierWordCounts = { 1: 20, 2: 20, 3: 20, 4: 20 };

function hit(id: string, over: Partial<HitRecord> = {}): HitRecord {
  return {
    id,
    planId: 'p1',
    wordId: `w_${id}`,
    tier: 3,
    roundNo: 1,
    listNo: 0,
    scheduledDate: '2026-10-12',
    modality: 'visual',
    status: 'pending',
    ...over,
  };
}

/** 制造 n 条欠账 */
function makeOverdue(n: number, over: Partial<HitRecord> = {}): HitRecord[] {
  return Array.from({ length: n }, (_, i) => hit(`od${i}`, over));
}

function input(over: Partial<PlanParams> = {}, steadyWords: WordSteadiness[] = []) {
  return { params: params(over), tierCounts: SMALL_COUNTS, steadyWords };
}

const TODAY = '2026-11-10';

describe('欠账阈值触发', () => {
  it('count > 2×dailyHits → mustReschedule=true', () => {
    const s = computeOverdue(makeOverdue(21), TODAY, 10);
    expect(s.count).toBe(21);
    expect(s.threshold).toBe(20);
    expect(s.mustReschedule).toBe(true);
  });

  it('count = 2×dailyHits → 不触发（严格大于）', () => {
    expect(computeOverdue(makeOverdue(20), TODAY, 10).mustReschedule).toBe(false);
  });

  it('连续 3 天未学且欠账 > 0 → 触发；done 状态不计入', () => {
    expect(computeOverdue(makeOverdue(5), TODAY, 10, '2026-11-07').mustReschedule).toBe(true);
    expect(computeOverdue(makeOverdue(5), TODAY, 10, '2026-11-08').mustReschedule).toBe(false);
    const done = makeOverdue(21).map((h) => ({ ...h, status: 'done' as const }));
    expect(computeOverdue(done, TODAY, 10).count).toBe(0);
  });
});

describe('策略 A：展期 extend（硬约束 #5）', () => {
  it('窗口铺满 T 时展期 → DeadlineExceeded', () => {
    const inp = input();
    // 默认窗口铺满 T=55 天（10-11 .. 12-04），finish = 12-04
    expect(planFinishDate(inp.params, inp.tierCounts)).toBe('2026-12-04');
    const outcome = applyStrategy('extend', inp, makeOverdue(10), [], TODAY);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('DeadlineExceeded');
  });

  it('有富余窗口（不等分 40 天）时展期成功：债务清零 + 新完成日 ≤ deadline', () => {
    const inp = input({
      planMode: 'fallback',
      tierRounds: { 1: 2, 2: 2, 3: 2, 4: 2 },
      tierRoundDays: { 1: [10, 10], 2: [10, 10], 3: [10, 10], 4: [10, 10] },
    });
    const finish = planFinishDate(inp.params, inp.tierCounts);
    expect(finish).toBe('2026-10-30'); // 各层并行：每层 2×10 天窗口，末日 = start+19
    const overdue = makeOverdue(8);
    const preview = previewStrategy('extend', inp, overdue, TODAY);
    expect(preview.deadlineExceeded).toBe(false);
    expect(preview.plainWords).toBe(STRATEGY_PLAIN_WORDS.extend);

    const outcome = applyStrategy('extend', inp, overdue, [], TODAY);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.newFinishDate <= inp.params.deadlineDate).toBe(true);
      expect(outcome.hitMutations.length).toBe(8); // 债务清零
      for (const m of outcome.hitMutations) {
        expect(m.action).toBe('reschedule');
        expect(m.newScheduledDate! >= TODAY).toBe(true);
        expect(m.newScheduledDate! <= inp.params.deadlineDate).toBe(true);
      }
    }
  });
});

describe('策略 B：压缩 compress', () => {
  it('总工期不变，欠账全部摊入未来窗口（债务清零）', () => {
    const inp = input();
    const overdue = makeOverdue(30);
    const preview = previewStrategy('compress', inp, overdue, TODAY);
    expect(preview.newDailyHits).toBeGreaterThan(preview.validation.dailyHits);

    const outcome = applyStrategy('compress', inp, overdue, [], TODAY);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.hitMutations.length).toBe(30);
      for (const m of outcome.hitMutations) {
        expect(m.newScheduledDate! >= TODAY).toBe(true);
        expect(m.newScheduledDate! <= inp.params.deadlineDate).toBe(true);
      }
      expect(outcome.newFinishDate).toBe('2026-12-04'); // 工期不变（T=55 天窗口末日）
    }
  });
});

describe('策略 C：降轮 drop_round', () => {
  it('R_t ← R_t − 1（保底 2），被砍轮次的欠账转 deferred', () => {
    const inp = input({ tierRoundDays: { 1: [10, 10, 10], 2: [10, 10], 3: [10, 10, 10], 4: [10, 10] } });
    expect(inp.params.tierRounds[3]).toBe(3);
    const overdue = makeOverdue(6, { tier: 3, roundNo: 3 });
    const outcome = applyStrategy('drop_round', inp, overdue, [], TODAY);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.newPlan.tierRounds[3]).toBe(2);
      // 被砍的第 3 轮欠账 → deferred（末轮复查语义）
      for (const m of outcome.hitMutations) {
        expect(m.newStatus).toBe('deferred');
      }
      expect(outcome.hitMutations.length).toBe(6);
    }
  });

  it('R=2 的层不可再降 → 抛错提示换策略', () => {
    const inp = input({ tierRounds: { 1: 2, 2: 2, 3: 2, 4: 2 }, planMode: 'fallback' });
    const overdue = makeOverdue(4, { tier: 3 });
    expect(() => applyStrategy('drop_round', inp, overdue, [], TODAY)).toThrow(/minimum 2 rounds/);
  });
});

describe('策略 D：子集冻结 freeze', () => {
  it('稳固欠账词 → deferred 末轮复查；非稳固 → 摊入未来；债务清零', () => {
    const overdue = makeOverdue(10);
    const steadyWords: WordSteadiness[] = overdue.slice(0, 6).map((h) => ({ wordId: h.wordId, steady: true }));
    const inp = input({}, steadyWords);

    const preview = previewStrategy('freeze', inp, overdue, TODAY);
    expect(preview.plainWords).toBe(STRATEGY_PLAIN_WORDS.freeze);
    // 6 个稳固词 hits 从 3 → 1，省 12
    expect(preview.validation.totalHits).toBe(previewStrategy('compress', inp, overdue).validation.totalHits - 12);

    const outcome = applyStrategy('freeze', inp, overdue, [], TODAY);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.hitMutations.length).toBe(10);
      const deferredIds = new Set(outcome.hitMutations.filter((m) => m.action === 'defer').map((m) => m.hitId));
      expect(deferredIds.size).toBe(6);
      // 稳固词 deferred 到该层最后窗口末日
      for (const m of outcome.hitMutations.filter((x) => x.action === 'defer')) {
        expect(m.newScheduledDate).toBe('2026-12-04');
      }
    }
  });

  it('显式部分放弃（规则 5）：deferredIds 子集无条件 deferred', () => {
    const inp = input();
    const overdue = makeOverdue(10);
    const outcome = applyStrategy('freeze', inp, overdue, ['od0', 'od1'], TODAY);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const deferred = outcome.hitMutations.filter((m) => m.action === 'defer');
      expect(deferred.length).toBe(2);
      expect(deferred.map((m) => m.hitId).sort()).toEqual(['od0', 'od1']);
    }
  });
});
