/**
 * qa/mrcsAdversarial.test.ts —— QA 独立对抗性验证：MRCS 调度器边界（PRD §4.4 / §4.4.6 / §4.4.7）。
 * 不复用现有断言口径，全部按 PRD 原文独立推导期望值。
 */
import { describe, expect, it } from 'vitest';
import {
  computeTotalHits,
  generateBothPlans,
  applyTierFreeze,
  resolveDegradePath,
  validatePlan,
} from '../../src/scheduler/validate';
import {
  addDays,
  diffDays,
  epochDay,
  expandDay,
  expandDayForWords,
  maxDailyHits,
  planRounds,
} from '../../src/scheduler/expand';
import { FALLBACK_TIER_ROUNDS, RECOMMENDED_TIER_ROUNDS } from '../../src/config/constants';
import { defaultPlanParams } from '../../src/config/constants';
import type { PlanParams, Tier, TierWordCounts, WordSteadiness } from '../../src/scheduler/types';

const START = '2026-10-11';
const DEADLINE = '2026-12-05';
/** PRD §4.4.6 敏感性表：W=7000，层分布 25/35/25/15% */
export const SENS_TIER_COUNTS: TierWordCounts = { 1: 1750, 2: 2450, 3: 1750, 4: 1050 };

function sensParams(over: Partial<PlanParams> = {}): PlanParams {
  return defaultPlanParams('fallback', {
    tierRounds: { ...FALLBACK_TIER_ROUNDS },
    startDate: START,
    deadlineDate: DEADLINE,
    sprintStartDate: DEADLINE,
    ...over,
  });
}

const noSteady: WordSteadiness[] = [];
const TIERS_ALL: readonly Tier[] = [1, 2, 3, 4];

// ===== 1. 极端输入不抛异常、给出可理解降级 =====

describe('对抗边界：极端输入', () => {
  it('空词书：不抛异常，validate 通过（0 负载），降级路径 fallback', () => {
    const params = sensParams();
    expect(() => validatePlan({ params, tierCounts: {}, steadyWords: [] })).not.toThrow();
    const r = validatePlan({ params, tierCounts: {}, steadyWords: [] });
    expect(r.totalHits).toBe(0);
    expect(r.pass).toBe(true);
    expect(resolveDegradePath({ params, tierCounts: {}, steadyWords: [] })).toBe('fallback');
  });

  it('空词书 expandDay：返回空队列，不抛异常', () => {
    const params = sensParams();
    expect(expandDay(params, {}, '2026-10-20', [])).toEqual([]);
  });

  it('单词条目：窗口物理下限 1 天，全窗口每日至多 1 词', () => {
    const params = sensParams({ tierRounds: { 1: 2, 2: 0, 3: 0, 4: 0 } });
    const windows = planRounds(params, { 1: 1 });
    expect(windows.length).toBe(2);
    for (const w of windows) {
      expect(w.physicalFloorDays).toBe(1);
      expect(w.floorViolated).toBe(false);
    }
    // 两个轮窗口都应有该词各一次
    const entries = new Map<number, number>(); // roundNo -> count
    for (let d = 0; d < diffDays(DEADLINE, START); d++) {
      for (const e of expandDayForWords(params, { 1: ['w1'], 2: [], 3: [], 4: [] }, addDays(START, d), [])) {
        entries.set(e.roundNo, (entries.get(e.roundNo) ?? 0) + 1);
      }
    }
    expect(entries.get(1)).toBe(1);
    expect(entries.get(2)).toBe(1);
  });

  it('R=1 层：单轮覆盖 100%（skipAllowed(1,1)=false）', () => {
    const params = sensParams({ tierRounds: { 1: 1, 2: 1, 3: 1, 4: 1 } });
    const words = { 1: ['a1', 'a2', 'a3'], 2: [], 3: [], 4: [] };
    const seen = new Set<string>();
    for (let d = 0; d < diffDays(DEADLINE, START); d++) {
      for (const e of expandDayForWords(params, words, addDays(START, d), [])) seen.add(e.wordId);
    }
    expect([...seen].sort()).toEqual(['a1', 'a2', 'a3']);
  });

  it('T 小于理论最小值（30 天塞 16800 hits）：不抛异常，走 raise_budget 降级', () => {
    // 30 天窗口：2026-11-05 → 2026-12-05
    const params = sensParams({
      tierRounds: { ...RECOMMENDED_TIER_ROUNDS },
      startDate: '2026-11-05',
      dailyBudgetMin: 60,
    });
    const input = { params, tierCounts: SENS_TIER_COUNTS, steadyWords: noSteady };
    expect(diffDays(DEADLINE, params.startDate)).toBe(30);
    expect(() => resolveDegradePath(input)).not.toThrow();
    // 推荐 16800/30=560 hits → 112min > 60；保底 14000/30≈467 → 93.4min > 60；
    // 冻结（推荐轮次+T1→1）15050/30≈502 → 100.4min > 60；T>0 且预算 60 ≥ 25 → raise_budget
    expect(resolveDegradePath(input)).toBe('raise_budget');
    expect(validatePlan(input).pass).toBe(false);
  });

  it('deadline 已过（start > deadline）：不抛异常，重负载 → exceed_deadline', () => {
    const params = sensParams({ startDate: '2026-12-06', deadlineDate: '2026-12-05' });
    const input = { params, tierCounts: SENS_TIER_COUNTS, steadyWords: noSteady };
    expect(() => resolveDegradePath(input)).not.toThrow();
    expect(resolveDegradePath(input)).toBe('exceed_deadline');
  });

  it('deadline 已过但零负载：validate 不抛异常且通过（空计划平凡可行）', () => {
    const params = sensParams({ startDate: '2026-12-06', deadlineDate: '2026-12-05' });
    const r = validatePlan({ params, tierCounts: {}, steadyWords: [] });
    expect(r.pass).toBe(true);
    expect(r.windowDays).toBe(1); // 负窗口被钳到 1，不产生 NaN/负数
  });

  it('start === deadline：windowDays 钳为 1，重负载不通过且数字有限', () => {
    const params = sensParams({ startDate: DEADLINE });
    const r = validatePlan({ params, tierCounts: SENS_TIER_COUNTS, steadyWords: noSteady });
    expect(Number.isFinite(r.dailyHits)).toBe(true);
    expect(r.windowDays).toBe(1);
    expect(r.pass).toBe(false);
  });
});

// ===== 2. 全员稳固：首末轮 100% 覆盖（硬约束 #4）=====

describe('对抗边界：全员稳固（降频首末轮保底）', () => {
  const params = sensParams({ tierRounds: { ...RECOMMENDED_TIER_ROUNDS } });
  const words: Record<Tier, string[]> = {
    1: Array.from({ length: 30 }, (_, i) => `t1w${i}`),
    2: Array.from({ length: 40 }, (_, i) => `t2w${i}`),
    3: Array.from({ length: 30 }, (_, i) => `t3w${i}`),
    4: Array.from({ length: 20 }, (_, i) => `t4w${i}`),
  };
  const steady: WordSteadiness[] = TIERS_ALL.flatMap((t) =>
    words[t].map((w) => ({ wordId: w, steady: true, tier: t })),
  );

  it('R=3 层全员稳固：第 1 轮与最后 1 轮 100% 覆盖，中间轮 0 出现', () => {
    const byWordRound = new Map<string, Set<number>>();
    for (let d = 0; d < diffDays(DEADLINE, START); d++) {
      for (const e of expandDayForWords(params, words, addDays(START, d), steady)) {
        if (!byWordRound.has(e.wordId)) byWordRound.set(e.wordId, new Set());
        byWordRound.get(e.wordId)!.add(e.roundNo);
      }
    }
    for (const t of [3, 4] as Tier[]) {
      const R = params.tierRounds[t];
      expect(R).toBe(3);
      for (const w of words[t]) {
        const rounds = byWordRound.get(w);
        expect(rounds, `${w} 必须出现在首末轮`).toBeDefined();
        expect(rounds!.has(1)).toBe(true);
        expect(rounds!.has(R)).toBe(true);
        // 全员稳固 → 中间轮全跳
        expect(rounds!.size).toBe(2);
      }
    }
  });

  it('R=2 层：稳固词两轮都出现（首末轮即全部轮）', () => {
    const byWordRound = new Map<string, Set<number>>();
    for (let d = 0; d < diffDays(DEADLINE, START); d++) {
      for (const e of expandDayForWords(params, words, addDays(START, d), steady)) {
        if (!byWordRound.has(e.wordId)) byWordRound.set(e.wordId, new Set());
        byWordRound.get(e.wordId)!.add(e.roundNo);
      }
    }
    for (const w of words[1]) {
      const rounds = byWordRound.get(w)!;
      expect(rounds.has(1)).toBe(true);
      expect(rounds.has(2)).toBe(true);
    }
  });
});

// ===== 3. gapMin 极端：不无限顺延/死循环 =====

describe('对抗边界：gapMin 与短轮窗口冲突', () => {
  it('gapMinDays=100 > 全窗口：瞬间终止，覆盖不丢，冲突词钳到窗口末日', () => {
    const params = sensParams({ gapMinDays: 100, tierRounds: { 1: 0, 2: 0, 3: 2, 4: 0 } });
    const words = { 1: [], 2: [], 3: Array.from({ length: 40 }, (_, i) => `g${i}`), 4: [] };
    const t0 = Date.now();
    const seenRounds = new Map<string, Set<number>>();
    const lastDay = new Map<string, string[]>();
    for (let d = 0; d < diffDays(DEADLINE, START); d++) {
      const date = addDays(START, d);
      for (const e of expandDayForWords(params, words, date, [])) {
        if (!seenRounds.has(e.wordId)) seenRounds.set(e.wordId, new Set());
        seenRounds.get(e.wordId)!.add(e.roundNo);
        if (!lastDay.has(e.wordId)) lastDay.set(e.wordId, []);
        lastDay.get(e.wordId)!.push(date);
      }
    }
    expect(Date.now() - t0).toBeLessThan(3000); // 无死循环
    for (const w of words[3]) {
      expect(seenRounds.get(w)).toEqual(new Set([1, 2])); // 覆盖不丢
      const dates = lastDay.get(w)!;
      expect(dates.length).toBe(2);
      // 第二次出现被钳到第 2 轮窗口末日或保持合法间隔
      const win2 = planRounds(params, { 3: 40 }).find((x) => x.tier === 3 && x.roundNo === 2)!;
      const gap = diffDays(dates[1], dates[0]);
      expect(gap >= 100 || dates[1] === win2.endDate).toBe(true);
    }
  });

  it('gapMinDays 适中：相邻两次出现满足 gap 或钳到窗口末日，且当日队列量不超过物理上限太多', () => {
    const params = sensParams({ gapMinDays: 7, tierRounds: { 1: 0, 2: 0, 3: 2, 4: 0 } });
    const words = { 1: [], 2: [], 3: Array.from({ length: 60 }, (_, i) => `m${i}`), 4: [] };
    const perDay = new Map<string, number>();
    const dates = new Map<string, string[]>();
    for (let d = 0; d < diffDays(DEADLINE, START); d++) {
      const date = addDays(START, d);
      const entries = expandDayForWords(params, words, date, []);
      perDay.set(date, entries.length);
      for (const e of entries) {
        if (!dates.has(e.wordId)) dates.set(e.wordId, []);
        dates.get(e.wordId)!.push(date);
      }
    }
    const maxDaily = maxDailyHits(params);
    for (const [, n] of perDay) expect(n).toBeLessThanOrEqual(maxDaily + 60); // 无单日爆量
    const win2 = planRounds(params, { 3: 60 }).find((x) => x.tier === 3 && x.roundNo === 2)!;
    for (const [, ds] of dates) {
      for (let i = 1; i < ds.length; i++) {
        const gap = diffDays(ds[i], ds[i - 1]);
        expect(gap >= 7 || ds[i] === win2.endDate).toBe(true);
      }
    }
  });
});

// ===== 4. 确定性与隔离性 =====

describe('对抗边界：expand 确定性与层间隔离', () => {
  const baseParams = sensParams({ tierRounds: { ...RECOMMENDED_TIER_ROUNDS } });
  const words: Record<Tier, string[]> = {
    1: Array.from({ length: 80 }, (_, i) => `d1_${i}`),
    2: Array.from({ length: 90 }, (_, i) => `d2_${i}`),
    3: Array.from({ length: 70 }, (_, i) => `d3_${i}`),
    4: Array.from({ length: 50 }, (_, i) => `d4_${i}`),
  };
  const sampleDates = ['2026-10-11', '2026-10-30', '2026-11-15', '2026-11-28', '2026-12-04'];

  it('同参数两次生成：expand 结果逐字节一致', () => {
    for (const date of sampleDates) {
      const a = JSON.stringify(expandDayForWords(baseParams, words, date, []));
      const b = JSON.stringify(expandDayForWords(baseParams, words, date, []));
      expect(a).toBe(b);
    }
  });

  it('改 T3 层轮次（3→2）：其余层（T1/T2/T4）当日展开完全不变', () => {
    const changed: PlanParams = {
      ...baseParams,
      tierRounds: { ...baseParams.tierRounds, 3: 2 },
    };
    for (const date of sampleDates) {
      const before = expandDayForWords(baseParams, words, date, []);
      const after = expandDayForWords(changed, words, date, []);
      for (const t of [1, 2, 4] as Tier[]) {
        expect(JSON.stringify(after.filter((e) => e.tier === t))).toBe(
          JSON.stringify(before.filter((e) => e.tier === t)),
        );
      }
    }
  });

  it('改 T3 层轮次：T1/T2/T4 的轮窗口几何完全不变', () => {
    const changed: PlanParams = { ...baseParams, tierRounds: { ...baseParams.tierRounds, 3: 2 } };
    const w1 = planRounds(baseParams, wordsToCounts(words)).filter((w) => w.tier !== 3);
    const w2 = planRounds(changed, wordsToCounts(words)).filter((w) => w.tier !== 3);
    expect(JSON.stringify(w2)).toBe(JSON.stringify(w1));
  });
});

function wordsToCounts(words: Record<Tier, string[]>): TierWordCounts {
  const c: TierWordCounts = {};
  for (const t of TIERS_ALL) c[t] = words[t].length;
  return c;
}

// ===== 5. 敏感性算术独立复算（PRD §4.4.6）=====

describe('敏感性算术独立复算（W=7000, 25/35/25/15%, 10-11→12-05）', () => {
  // 独立算术：T = 2026-12-05 − 2026-10-11 = 55 天
  // 推荐档 {2,2,3,3}: 1750×2+2450×2+1750×3+1050×3 = 3500+4900+5250+3150 = 16800
  // 保底档 {2,2,2,2}: 7000×2 = 14000
  // 保底+冻结T1 {1,2,2,2}: 1750×1 + 5250×2 = 12250
  const T = 55;

  it('窗口天数独立验证 = 55 天', () => {
    expect(diffDays(DEADLINE, START)).toBe(T);
    expect(diffDays(DEADLINE, START)).toBe(20 + 30 + 5);
  });

  it('推荐档 totalHits = 16800；budget=60 时 dailyHits=306、61.2min、fail 且临界', () => {
    const params = sensParams({ tierRounds: { ...RECOMMENDED_TIER_ROUNDS } });
    const r = validatePlan({ params, tierCounts: SENS_TIER_COUNTS, steadyWords: noSteady });
    expect(r.totalHits).toBe(16800);
    expect(r.dailyHits).toBe(Math.ceil(16800 / T));
    expect(r.dailyHits).toBe(306);
    expect(r.dailyMinutes).toBeCloseTo((306 * 12) / 60, 10);
    expect(r.dailyMinutes).toBeCloseTo(61.2, 10);
    expect(r.pass).toBe(false);
    expect(r.critical).toBe(true); // 余量 -2%，在 ±5% 内
    expect(r.marginRatio).toBeCloseTo((60 - 61.2) / 60, 10);
  });

  it('保底档 totalHits = 14000；budget=60 时 255 hits / 51min、pass', () => {
    const params = sensParams({ tierRounds: { ...FALLBACK_TIER_ROUNDS } });
    const r = validatePlan({ params, tierCounts: SENS_TIER_COUNTS, steadyWords: noSteady });
    expect(r.totalHits).toBe(14000);
    expect(r.dailyHits).toBe(255);
    expect(r.dailyMinutes).toBeCloseTo(51, 10);
    expect(r.pass).toBe(true);
  });

  it('保底+冻结 T1 totalHits = 12250（1750×1 + 5250×2）', () => {
    const rounds = applyTierFreeze({ ...FALLBACK_TIER_ROUNDS }, [1]);
    expect(rounds).toEqual({ 1: 1, 2: 2, 3: 2, 4: 2 });
    const params = sensParams({ tierRounds: rounds });
    const r = validatePlan({ params, tierCounts: SENS_TIER_COUNTS, steadyWords: noSteady });
    expect(r.totalHits).toBe(12250);
    expect(r.dailyHits).toBe(Math.ceil(12250 / T));
    expect(r.dailyHits).toBe(223);
    expect(r.dailyMinutes).toBeCloseTo(44.6, 10);
  });

  it('降级路径矩阵：60→fallback / 50→freeze_t1 / 30→raise_budget / 20→maintenance_mode', () => {
    const mk = (budget: number) => ({
      params: sensParams({ tierRounds: { ...FALLBACK_TIER_ROUNDS }, dailyBudgetMin: budget }),
      tierCounts: SENS_TIER_COUNTS,
      steadyWords: noSteady,
    });
    expect(resolveDegradePath(mk(60))).toBe('fallback'); // 保底 51min ≤ 60
    expect(resolveDegradePath(mk(50))).toBe('freeze_t1'); // 保底 51>50，冻结 44.6≤50
    expect(resolveDegradePath(mk(30))).toBe('raise_budget'); // 冻结 44.6>30，30≥25
    expect(resolveDegradePath(mk(20))).toBe('maintenance_mode'); // 20<25
  });

  it('generateBothPlans 双档数字与独立算术一致', () => {
    const { recommended, fallback } = generateBothPlans({
      params: sensParams({ tierRounds: { ...RECOMMENDED_TIER_ROUNDS } }),
      tierCounts: SENS_TIER_COUNTS,
      steadyWords: noSteady,
    });
    expect(recommended.totalHits).toBe(16800);
    expect(fallback.totalHits).toBe(14000);
    expect(computeTotalHits({ params: sensParams(), tierCounts: SENS_TIER_COUNTS, steadyWords: [] })).toBe(14000);
  });

  it('稳固词折减算术：computeTotalHits 按 (R−2)/词 折减，且不折为负', () => {
    const params = sensParams({ tierRounds: { 1: 2, 2: 3, 3: 0, 4: 0 } });
    const steady: WordSteadiness[] = [
      ...Array.from({ length: 100 }, (_, i) => ({ wordId: `s2_${i}`, steady: true, tier: 2 as Tier })),
    ];
    // T2: 2450×3 − 100×1 = 7350−100 = 7250
    const r = computeTotalHits({ params, tierCounts: { 2: 2450 }, steadyWords: steady });
    expect(r).toBe(7250);
  });

  it('epochDay/addDays 往返一致性（日期算术健全性）', () => {
    expect(addDays(START, T)).toBe(DEADLINE);
    expect(epochDay(START) + T).toBe(epochDay(DEADLINE));
  });
});
