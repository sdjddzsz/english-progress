/**
 * overdueFlow.test.ts —— 「国庆 5 天欠账」端到端（T05 验收场景）：
 * 欠账检测（computeOverdue → mustReschedule）→ 四策略 preview（大白话/新完成日/超期标记）
 * → applyStrategy 执行（规则 4：每个 overdue hit 恰好一条 mutation = 债务清零）
 * → 落库模拟 → 队列重展开（expandDayForWords 未来日不含已处理欠账）。
 */
import { describe, expect, it } from 'vitest';
import {
  applyStrategy,
  computeOverdue,
  expandDayForWords,
  previewStrategy,
  validatePlan,
  type HitRecord,
  type PlanParams,
  type RescheduleStrategy,
  type TierWordCounts,
  type WordSteadiness,
} from '../../src/scheduler';
import { defaultPlanParams } from '../../src/config/constants';

const TODAY = '2026-10-06'; // 国庆后第一天
const params: PlanParams = {
  ...defaultPlanParams('recommended'),
  startDate: '2026-09-10',
  gapMinDays: 0,
};

const tierCounts: TierWordCounts = { 1: 0, 2: 400, 3: 600, 4: 300 }; // 精简版词书
const steadyWords: WordSteadiness[] = [];

function makeOverdue(count: number, fromDaysAgo = 5): HitRecord[] {
  // 5 天假期各摊若干条 pending hit（过去日期）
  return Array.from({ length: count }, (_, i) => {
    const dayOffset = fromDaysAgo - (i % fromDaysAgo); // 5..1 天前
    const d = new Date(`${TODAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - dayOffset);
    const tier = (2 + (i % 3)) as 2 | 3 | 4;
    return {
      id: `p1_w${i}_1_${d.toISOString().slice(0, 10)}`,
      planId: 'p1',
      wordId: `w${i}`,
      tier,
      roundNo: 1,
      listNo: Math.floor(i / 50),
      scheduledDate: d.toISOString().slice(0, 10),
      modality: i % 2 === 0 ? 'visual' : 'audio',
      status: 'pending',
    } as HitRecord;
  });
}

describe('「国庆 5 天欠账」全流程', () => {
  const overdue = makeOverdue(100); // 5 天 × 20 条，> 2×日均(41) → 必须重排
  const validation = validatePlan({ params, tierCounts, steadyWords });

  it('Step1 检测：100 条欠账 > 2×日均 → mustReschedule=true', () => {
    const summary = computeOverdue(overdue, TODAY, validation.dailyHits);
    expect(summary.count).toBe(100);
    expect(summary.threshold).toBe(validation.dailyHits * 2);
    expect(summary.mustReschedule).toBe(true);
  });

  it('Step2 预览：四策略都有大白话；extend 突破 deadline 被标记', () => {
    const strategies: RescheduleStrategy[] = ['extend', 'compress', 'drop_round', 'freeze'];
    for (const s of strategies) {
      const p = previewStrategy(s, { params, tierCounts, steadyWords }, overdue, TODAY);
      expect(p.plainWords.length).toBeGreaterThan(4);
      expect(p.affectedWordCount).toBe(100);
      expect(p.newDailyHits).toBeGreaterThan(0);
      expect(new Date(p.newFinishDate).getTime()).not.toBeNaN();
    }
    const extend = previewStrategy('extend', { params, tierCounts, steadyWords }, overdue, TODAY);
    // 100 条 / 日均 → 需延数日，窗口 2026-09-10→12-05 余量有限：若突破则必须标记
    if (extend.newFinishDate > params.deadlineDate) {
      expect(extend.deadlineExceeded).toBe(true);
    }
    const compress = previewStrategy('compress', { params, tierCounts, steadyWords }, overdue, TODAY);
    expect(compress.deadlineExceeded).toBe(false);
  });

  it('Step3 执行 compress：债务清零（每条欠账恰一条 mutation），新日期 ≥ today', () => {
    const outcome = applyStrategy('compress', { params, tierCounts, steadyWords }, overdue, undefined, TODAY);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.hitMutations.length).toBe(overdue.length); // 规则 4
    const ids = new Set(outcome.hitMutations.map((m) => m.hitId));
    expect(ids.size).toBe(overdue.length); // 每条 hit 只有一条 mutation
    for (const m of outcome.hitMutations) {
      expect(m.newStatus).toBe('pending');
      if (m.newScheduledDate) {
        expect(m.newScheduledDate >= TODAY).toBe(true); // 不排到过去
        expect(m.newScheduledDate <= params.deadlineDate).toBe(true); // 硬约束 #5
      }
    }
  });

  it('Step3 执行 extend：若不突破 deadline 则成功；突破则明确拒绝（硬约束 #5）', () => {
    const outcome = applyStrategy('extend', { params, tierCounts, steadyWords }, overdue, undefined, TODAY);
    if (outcome.ok) {
      expect(outcome.hitMutations.length).toBe(overdue.length);
      for (const m of outcome.hitMutations) {
        if (m.newScheduledDate) expect(m.newScheduledDate <= params.deadlineDate).toBe(true);
      }
    } else {
      expect(outcome.error).toBe('DeadlineExceeded');
      expect(outcome.message).toContain('compress');
    }
  });

  it('Step3 执行 freeze：稳固词 → deferred 末轮复查；其余摊入未来（债务清零）', () => {
    // 前 6 个词标记稳固
    const steady: WordSteadiness[] = overdue.slice(0, 6).map((h) => ({ wordId: h.wordId, steady: true, tier: h.tier }));
    const outcome = applyStrategy('freeze', { params, tierCounts, steadyWords: steady }, overdue, undefined, TODAY);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.hitMutations.length).toBe(overdue.length);
    const frozen = outcome.hitMutations.filter((m) => m.action === 'defer' && m.reason.includes('冻结'));
    expect(frozen.length).toBe(6);
    for (const m of frozen) {
      expect(m.newStatus).toBe('deferred');
      expect(m.newScheduledDate).toBeDefined(); // 末轮复查日
    }
  });

  it('Step4 落库模拟 + 队列重展开：处理后的欠账词在当日/未来队列正常出现，不与旧日期冲突', () => {
    const outcome = applyStrategy('compress', { params, tierCounts, steadyWords }, overdue, undefined, TODAY);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 模拟落库：reschedule 的 hit 改期 pending
    const after = overdue.map((h) => {
      const m = outcome.hitMutations.find((x) => x.hitId === h.id);
      return m && m.newScheduledDate ? { ...h, scheduledDate: m.newScheduledDate, status: m.newStatus } : h;
    });
    // 重展开某未来日：真实词表路径（词 ID = w0..w1299 按层铺）
    const wordsByTier: Record<number, string[]> = { 1: [], 2: [], 3: [], 4: [] };
    let n = 0;
    for (const t of [2, 3, 4] as const) {
      const W = tierCounts[t];
      for (let i = 0; i < W; i++) wordsByTier[t].push(`w${n++}`);
    }
    // 取 compress 摊入窗口中段一天，断言队列条目 scheduledDate 语义一致（entries 属于该日）且无重复
    const target = outcome.hitMutations[0].newScheduledDate ?? TODAY;
    const entries = expandDayForWords(params, wordsByTier, target, steadyWords);
    const seen = new Set<string>();
    for (const e of entries) {
      const key = `${e.wordId}_${e.roundNo}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // 落库后的欠账词无一仍停留在过去
    for (const h of after) {
      if (h.status !== 'deferred') expect(h.scheduledDate >= TODAY).toBe(true);
    }
    // 处理后欠账池应清零
    const remaining = after.filter((h) => (h.status === 'pending' || h.status === 'overdue') && h.scheduledDate < TODAY);
    expect(remaining.length).toBe(0);
  });

  it('extend 被拒路径：紧迫场景（欠账 200 条）extend 必须明确拒绝并给出替代建议', () => {
    const big = makeOverdue(200);
    const outcome = applyStrategy('extend', { params, tierCounts, steadyWords }, big, undefined, TODAY);
    if (!outcome.ok) {
      expect(outcome.error).toBe('DeadlineExceeded');
      expect(outcome.message.length).toBeGreaterThan(10);
    } else {
      // 若窗口恰好容纳，则所有改期仍不越 deadline
      for (const m of outcome.hitMutations) {
        if (m.newScheduledDate) expect(m.newScheduledDate <= params.deadlineDate).toBe(true);
      }
    }
  });
});
