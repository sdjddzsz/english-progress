/**
 * mrcs.test.ts —— MRCS 调度核心正确性断言（架构文档第四部分"关键正确性断言"）
 * + PRD §4.4.6 敏感性算术 5 个数字精确匹配 + PRD §6.3 硬约束逐条。
 */
import { describe, expect, it } from 'vitest';
import {
  applyTierFreeze,
  computeTotalHits,
  generateBothPlans,
  resolveDegradePath,
  validatePlan,
} from '../../src/scheduler/validate';
import { decayedHitsForWord, isSteadySignal, skipAllowed } from '../../src/scheduler/mastery';
import { expandDay, expandDayForWords, maxDailyHits, planFinishDate, planRounds } from '../../src/scheduler/expand';
import { computeOverdue } from '../../src/scheduler/overdue';
import type { FeedbackSignal, HitRecord, PlanParams, TierWordCounts, WordSteadiness } from '../../src/scheduler/types';
import { defaultPlanParams } from '../../src/config/constants';

// ===== 测试数据 =====

/** 摸底前假设 25/35/25/15 × 7000 */
const TIER_COUNTS_2535: TierWordCounts = { 1: 1750, 2: 2450, 3: 1750, 4: 1050 };
/** 摸底后 T1≥30%、T4≤10%：{30/35/25/10} */
const TIER_COUNTS_T1_30: TierWordCounts = { 1: 2100, 2: 2450, 3: 1750, 4: 700 };

function params(over: Partial<PlanParams> = {}): PlanParams {
  return defaultPlanParams('recommended', over);
}

function hit(id: string, over: Partial<HitRecord> = {}): HitRecord {
  return {
    id,
    planId: 'p1',
    wordId: `w_${id}`,
    tier: 3,
    roundNo: 1,
    listNo: 0,
    scheduledDate: '2026-10-01',
    modality: 'visual',
    status: 'pending',
    ...over,
  };
}

// ===== 敏感性算术（PRD §4.4.6 表，5 个数字精确匹配）=====

describe('敏感性算术（PRD §4.4.6）', () => {
  const steady: WordSteadiness[] = []; // 建计划时无稳固数据

  it('全层 R=3（不降频，参照项）= 21000 hits，日均 382 hits ≈ 76 分钟，不通过', () => {
    const r = validatePlan({
      params: params({ tierRounds: { 1: 3, 2: 3, 3: 3, 4: 3 }, planMode: 'fallback' }),
      tierCounts: TIER_COUNTS_2535,
      steadyWords: steady,
    });
    expect(r.totalHits).toBe(21000);
    expect(r.dailyHits).toBe(382); // ceil(21000/55)
    expect(r.dailyMinutes).toBeCloseTo(76.4, 5);
    expect(r.pass).toBe(false);
  });

  it('推荐计划（25/35/25/15）= 16800 hits，60 分基准下临界（61 分钟 > 60）', () => {
    const r = validatePlan({ params: params(), tierCounts: TIER_COUNTS_2535, steadyWords: steady });
    expect(r.totalHits).toBe(16800);
    expect(r.dailyHits).toBe(306); // ceil(16800/55)
    expect(r.dailyMinutes).toBeCloseTo(61.2, 5);
    expect(r.pass).toBe(false);
    expect(r.critical).toBe(true); // ±5% 内 → 黄色警告
    // 70 分预算下通过
    const r70 = validatePlan({
      params: params({ dailyBudgetMin: 70 }),
      tierCounts: TIER_COUNTS_2535,
      steadyWords: steady,
    });
    expect(r70.pass).toBe(true);
  });

  it('推荐计划（摸底后 T1≥30%、T4≤10%）= 16450 hits，60 分基准通过', () => {
    const r = validatePlan({ params: params(), tierCounts: TIER_COUNTS_T1_30, steadyWords: steady });
    expect(r.totalHits).toBe(16450);
    expect(r.pass).toBe(true);
  });

  it('保底计划（任意分布）= 14000 hits；50 分临界不通过、60 分通过', () => {
    const r = validatePlan({
      params: params({ tierRounds: { 1: 2, 2: 2, 3: 2, 4: 2 }, planMode: 'fallback' }),
      tierCounts: TIER_COUNTS_2535,
      steadyWords: steady,
    });
    expect(r.totalHits).toBe(14000);
    expect(r.pass).toBe(true); // 51 ≤ 60
    const r50 = validatePlan({
      params: params({ tierRounds: { 1: 2, 2: 2, 3: 2, 4: 2 }, planMode: 'fallback', dailyBudgetMin: 50 }),
      tierCounts: TIER_COUNTS_2535,
      steadyWords: steady,
    });
    expect(r50.pass).toBe(false); // 51 > 50
    expect(r50.critical).toBe(true);
  });

  it('保底计划 + 冻结 T1 整层 = 12250 hits（T1 只在末轮确认一次）', () => {
    const rounds = applyTierFreeze({ 1: 2, 2: 2, 3: 2, 4: 2 }, [1]);
    expect(rounds[1]).toBe(1);
    const r = validatePlan({
      params: params({ tierRounds: rounds, planMode: 'fallback', dailyBudgetMin: 50 }),
      tierCounts: TIER_COUNTS_2535,
      steadyWords: steady,
    });
    expect(r.totalHits).toBe(12250);
    expect(r.pass).toBe(true); // 45 ≤ 50
  });
});

// ===== 硬约束 #4：稳固词首末轮必现，仅中间轮可跳 =====

describe('稳固降频与首末轮保底（硬约束 #4）', () => {
  it('skipAllowed(1,R)=skipAllowed(R,R)=false 对任意 R∈2..5', () => {
    for (const R of [2, 3, 4, 5]) {
      expect(skipAllowed(1, R)).toBe(false);
      expect(skipAllowed(R, R)).toBe(false);
    }
    expect(skipAllowed(2, 4)).toBe(true);
    expect(skipAllowed(3, 4)).toBe(true);
    expect(skipAllowed(2, 3)).toBe(true);
  });

  it('decayedHitsForWord：稳固词 R→2；R≤2 无折减空间', () => {
    expect(decayedHitsForWord(5, true)).toBe(2);
    expect(decayedHitsForWord(3, true)).toBe(2);
    expect(decayedHitsForWord(2, true)).toBe(2);
    expect(decayedHitsForWord(4, false)).toBe(4);
  });

  it('expandDayForWords：稳固词第 1、3 轮必现，第 2 轮跳过', () => {
    const words = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const steadyWords: WordSteadiness[] = [{ wordId: 'a', steady: true }];
    const p = params({
      tierRounds: { 1: 1, 2: 1, 3: 3, 4: 1 },
      tierRoundDays: { 1: [10], 2: [10], 3: [10, 10, 10], 4: [10] },
      masteryDecayEnabled: true,
      gapMinDays: 0,
    });
    const byTier = { 1: [], 2: [], 3: words, 4: [] };
    const seen = new Map<string, Set<number>>();
    for (let d = 0; d < 30; d++) {
      const date = addDaysISO('2026-10-11', d);
      for (const e of expandDayForWords(p, byTier, date, steadyWords)) {
        if (!seen.has(e.wordId)) seen.set(e.wordId, new Set());
        seen.get(e.wordId)!.add(d);
      }
    }
    const a = seen.get('a')!;
    // 稳固词只在第 1、3 轮出现（共 2 次），中间轮（第 10–19 天）必不出现
    expect(a.size).toBe(2);
    for (const d of a) {
      expect(d < 10 || d >= 20, `steady word 'a' appeared in middle round at day ${d}`).toBe(true);
    }
    // 非稳固词 b 三轮都出现
    const b = seen.get('b')!;
    expect(b.size).toBe(3);
  });

  it('关闭降频 → totalHits 严格 Σ(W_t×R_t)', () => {
    const steadyWords: WordSteadiness[] = [{ wordId: 'x', steady: true, tier: 3 }];
    const input = { params: params({ masteryDecayEnabled: false }), tierCounts: TIER_COUNTS_2535, steadyWords };
    expect(computeTotalHits(input)).toBe(16800);
    const inputOn = { params: params(), tierCounts: TIER_COUNTS_2535, steadyWords };
    // 开启降频：T3 稳固 1 词，R3→2，减 1
    expect(computeTotalHits(inputOn)).toBe(16799);
  });

  it('isSteadySignal：秒认≥2 且无 L2 且听觉识别≥1', () => {
    const ok: FeedbackSignal[] = [
      { l1: 'instant', reactionMs: 400, l2Tags: [], modality: 'visual' },
      { l1: 'instant', reactionMs: 500, l2Tags: [], modality: 'audio' },
    ];
    expect(isSteadySignal(ok)).toBe(true);
    // 缺听觉识别
    expect(
      isSteadySignal([
        { l1: 'instant', reactionMs: 400, l2Tags: [], modality: 'visual' },
        { l1: 'instant', reactionMs: 500, l2Tags: [], modality: 'visual' },
      ]),
    ).toBe(false);
    // 有 L2 标签
    expect(
      isSteadySignal([
        { l1: 'instant', reactionMs: 400, l2Tags: ['形近词混淆'], modality: 'visual' },
        { l1: 'instant', reactionMs: 500, l2Tags: [], modality: 'audio' },
      ]),
    ).toBe(false);
    // 秒认不足 2 次
    expect(
      isSteadySignal([
        { l1: 'instant', reactionMs: 400, l2Tags: [], modality: 'visual' },
        { l1: 'recognized', reactionMs: 2000, l2Tags: [], modality: 'audio' },
      ]),
    ).toBe(false);
  });
});

// ===== 确定性 / 模态比例 / gap（正确性断言 4/5/6）=====

describe('expand 确定性与模态/gap 约束', () => {
  const counts: TierWordCounts = { 1: 30, 2: 30, 3: 30, 4: 30 };

  it('断言 4：同参数同输入 expandDay 输出一致（种子=轮次号可复现）', () => {
    const p = params({ gapMinDays: 0 });
    const a = expandDay(p, counts, '2026-11-01', []);
    const b = expandDay(p, counts, '2026-11-01', []);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('断言 5：各层当日听觉 hit 数 = round(n × modal_ratio)（±0 容差）', () => {
    const p = params({ gapMinDays: 0 });
    for (const date of ['2026-10-20', '2026-11-01', '2026-11-20']) {
      const entries = expandDay(p, counts, date, []);
      for (const tier of [1, 2, 3, 4] as const) {
        const chunk = entries.filter((e) => e.tier === tier);
        if (chunk.length === 0) continue;
        const audio = chunk.filter((e) => e.modality === 'audio').length;
        expect(audio).toBe(Math.round(chunk.length * p.modalRatio[tier]));
      }
    }
  });

  it('断言 6：同词相邻轮 hit 间隔 ≥ gapMinDays（冲突顺延到最近合法日）', () => {
    const gapMin = 16; // ≈ 轮窗口 27 × 0.6
    const p = params({ gapMinDays: gapMin });
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`);
    const byTier = { 1: words, 2: [], 3: [], 4: [] };
    // 全窗口扫描，收集每词出现日
    const seen = new Map<string, number[]>();
    for (let d = 0; d < 55; d++) {
      const date = addDaysISO('2026-10-11', d);
      for (const e of expandDayForWords(p, byTier, date, [])) {
        if (!seen.has(e.wordId)) seen.set(e.wordId, []);
        seen.get(e.wordId)!.push(d);
      }
    }
    for (const [wordId, days] of seen) {
      expect(days.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < days.length; i++) {
        expect(days[i] - days[i - 1], `${wordId} gap`).toBeGreaterThanOrEqual(gapMin);
      }
    }
  });

  it('planRounds：每轮窗口 ≥ 物理下限 ceil(W/maxDailyHits)；maxDailyHits=floor(预算×60/avgHit)', () => {
    const p = params();
    expect(maxDailyHits(p)).toBe(300); // floor(60×60/12)
    const windows = planRounds(p, TIER_COUNTS_2535);
    const t3 = windows.filter((w) => w.tier === 3);
    expect(t3.length).toBe(3);
    for (const w of t3) {
      expect(w.days).toBeGreaterThanOrEqual(w.physicalFloorDays);
      expect(w.floorViolated).toBe(false);
    }
    // 推荐档全窗口铺满 T=55 天（10-11..12-04）→ 完成日 = 窗口末日 12-04
    expect(planFinishDate(p, TIER_COUNTS_2535)).toBe('2026-12-04');
  });
});

// ===== 硬约束 #2 / 欠账阈值（断言 7）=====

describe('欠账阈值（断言 7）', () => {
  it('count > 2×dailyHits 或 连续 3 天未学且 count>0 → mustReschedule', () => {
    const hits = Array.from({ length: 201 }, (_, i) => hit(`h${i}`));
    expect(computeOverdue(hits, '2026-10-15', 100).mustReschedule).toBe(true);
    const hits200 = hits.slice(0, 200);
    expect(computeOverdue(hits200, '2026-10-15', 100).mustReschedule).toBe(false);
    // 连续 3 天未学 + 欠账 > 0
    const few = hits.slice(0, 5);
    expect(computeOverdue(few, '2026-10-15', 100, '2026-10-12').mustReschedule).toBe(true);
    expect(computeOverdue(few, '2026-10-15', 100, '2026-10-13').mustReschedule).toBe(false);
    expect(computeOverdue([], '2026-10-15', 100, '2026-10-01').mustReschedule).toBe(false);
  });
});

// ===== 双档生成与降级路径（PRD §4.4.7）=====

describe('双档生成与降级路径', () => {
  it('generateBothPlans：推荐档 tierRounds {1:2,2:2,3:3,4:3} / 保底档全 2', () => {
    const input = { params: params(), tierCounts: TIER_COUNTS_2535, steadyWords: [] };
    const both = generateBothPlans(input);
    expect(both.recommended.totalHits).toBe(16800);
    expect(both.fallback.totalHits).toBe(14000);
  });

  it('resolveDegradePath：60 分推荐临界 → 保底通过 → fallback；预算 20 → maintenance_mode', () => {
    const low = { params: params({ dailyBudgetMin: 20 }), tierCounts: TIER_COUNTS_2535, steadyWords: [] };
    expect(resolveDegradePath(low)).toBe('maintenance_mode');
    const ok = { params: params({ dailyBudgetMin: 70 }), tierCounts: TIER_COUNTS_2535, steadyWords: [] };
    expect(resolveDegradePath(ok)).toBe('fallback');
  });
});

// ===== 工具 =====

function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
