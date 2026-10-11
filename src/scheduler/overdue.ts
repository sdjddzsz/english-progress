/**
 * overdue.ts —— 欠账检测 + 四策略（PRD §4.4.4，硬约束 #5）。
 * 规则 1：欠账不消失、不翻倍、不静默累积（原样保留进 overdue 池）。
 * 规则 4：重排即债务清零 —— applyStrategy 保证每个 overdue hit 恰好获得一条 mutation。
 * 规则 6：展期不得突破 deadline（硬约束 #5）。
 */
import { OVERDUE_IDLE_DAYS_TRIGGER, OVERDUE_THRESHOLD_MULTIPLIER } from '../config/constants';
import type {
  HitMutation,
  HitRecord,
  OverdueSummary,
  PlanParams,
  RescheduleStrategy,
  StrategyOutcome,
  StrategyPreview,
  Tier,
  TierWordCounts,
  ValidationInput,
  ValidationResult,
} from './types';
import { addDays, diffDays, planFinishDate, planRounds } from './expand';
import { validatePlan } from './validate';

// ===== 欠账检测 =====

/**
 * count = status ∈ {pending, overdue} 且 scheduled_date < today 的 hit 数；
 * mustReschedule = count > 2×dailyHits 或（连续 ≥3 天未学 且 count > 0）。
 */
export function computeOverdue(
  hits: HitRecord[],
  today: string,
  dailyHits: number,
  lastStudyDate?: string,
): OverdueSummary {
  const count = hits.filter(
    (h) => (h.status === 'pending' || h.status === 'overdue') && h.scheduledDate < today,
  ).length;
  const threshold = dailyHits * OVERDUE_THRESHOLD_MULTIPLIER;
  const idleDays = lastStudyDate ? Math.max(0, diffDays(today, lastStudyDate)) : 0;
  const mustReschedule =
    count > threshold ||
    (count > 0 && lastStudyDate != null && idleDays >= OVERDUE_IDLE_DAYS_TRIGGER);
  return { count, threshold, mustReschedule, idleDays };
}

// ===== 大白话（面板原文，Q4 决策）=====

export const STRATEGY_PLAIN_WORDS: Record<RescheduleStrategy, string> = {
  extend: '做不完就往后顺延：整体时间拉长，每天量不变，质量不缩水。',
  compress: '日子不能延，就每天多背一点：总量和时间都不变，短期内加量。',
  drop_round: '实在赶不上，就少过一遍：比如 3 遍改 2 遍，完成时间不变。',
  freeze: '已经会的先放一放：把欠账里其实已经掌握的词移出本轮，最后一遍时再确认一次。',
};

// ===== 内部工具 =====

function uniqueWordCount(hits: HitRecord[]): number {
  return new Set(hits.map((h) => h.wordId)).size;
}

function emptyValidation(params: PlanParams): ValidationResult {
  return {
    pass: false,
    totalHits: 0,
    dailyHits: 0,
    dailyMinutes: 0,
    marginRatio: 1,
    critical: false,
    windowDays: Math.max(1, diffDays(params.deadlineDate, params.startDate)),
  };
}

/**
 * 重排摊入日：从 from 日起 H 天内 round-robin 分配（确定性）。
 * 返回每个 overdue hit 的目标日期。
 */
function spreadDates(count: number, from: string, days: number): string[] {
  const H = Math.max(1, days);
  return Array.from({ length: count }, (_, i) => addDays(from, i % H));
}

/** 重排摊入窗口：当前轮剩余天数 + 下一轮天数（无 today 时退化为整个窗口） */
function horizonDays(input: ValidationInput, today?: string): number {
  const { params, tierCounts } = input;
  if (!today) return Math.max(1, diffDays(params.deadlineDate, params.startDate));
  const windows = planRounds(params, tierCounts);
  const active = windows.filter((w) => w.endDate >= today);
  const current = active.find((w) => today >= w.startDate) ?? active[0];
  if (!current) return Math.max(1, diffDays(params.deadlineDate, params.startDate));
  const next = windows.find((w) => w.tier === current.tier && w.roundNo === current.roundNo + 1);
  const remainingCurrent = diffDays(current.endDate, today) + 1;
  return Math.max(1, remainingCurrent + (next ? next.days : 0));
}

function tierOfMostOverdue(overdue: HitRecord[]): Tier {
  const byTier = new Map<Tier, number>();
  for (const h of overdue) byTier.set(h.tier, (byTier.get(h.tier) ?? 0) + 1);
  let best: Tier = 3;
  let bestCount = -1;
  for (const [t, c] of byTier) {
    if (c > bestCount) {
      best = t;
      bestCount = c;
    }
  }
  return best;
}

function revalidate(params: PlanParams, input: ValidationInput): ValidationResult {
  return validatePlan({ params, tierCounts: input.tierCounts, steadyWords: input.steadyWords });
}

/**
 * 日额度物理上限（PRD §4.4.4-B）：maxDailyHits = floor(日预算分钟 × 60 / 单词均耗时秒)。
 * compress 摊入后的近期日额度不得超过此值——超过即物理上不可完成（P1-1 修复）。
 */
export function maxDailyHitsCap(params: PlanParams): number {
  return Math.max(1, Math.floor((params.dailyBudgetMin * 60) / Math.max(1, params.avgHitSec)));
}

// ===== 影响预览 =====

/**
 * 四策略影响预览（面板逐条展示）。
 * @param today 可选；提供后 compress 的摊入窗口按"本轮剩余 + 下一轮"计算
 */
export function previewStrategy(
  s: RescheduleStrategy,
  input: ValidationInput,
  overdue: HitRecord[],
  today?: string,
): StrategyPreview {
  const { params, tierCounts } = input;
  const base = validatePlan(input);
  const affected = uniqueWordCount(overdue);
  const plainWords = STRATEGY_PLAIN_WORDS[s];

  switch (s) {
    case 'extend': {
      const finish = planFinishDate(params, tierCounts);
      const delta = Math.max(1, Math.ceil(overdue.length / Math.max(1, base.dailyHits)));
      const newFinish = addDays(finish, delta);
      return {
        strategy: s,
        plainWords,
        newFinishDate: newFinish,
        newDailyHits: base.dailyHits,
        validation: base,
        affectedWordCount: affected,
        deadlineExceeded: newFinish > params.deadlineDate,
      };
    }
    case 'compress': {
      const H = horizonDays(input, today);
      // 欠账摊入摊入窗口：近期日额度上浮（validation 保留整体校验口径，newDailyHits 为近期上浮值）
      // P1-1：raw 值超 maxDailyHits 物理上限时封顶显示，并标记 capacityExceeded 引导换策略
      const rawDailyHits = Math.ceil((overdue.length + base.dailyHits * H) / H);
      const cap = maxDailyHitsCap(params);
      const capacityExceeded = rawDailyHits > cap;
      const newDailyHits = Math.min(rawDailyHits, cap);
      return {
        strategy: s,
        plainWords,
        newFinishDate: planFinishDate(params, tierCounts),
        newDailyHits,
        validation: base,
        affectedWordCount: affected,
        deadlineExceeded: false,
        ...(capacityExceeded ? { capacityExceeded: true, capacityOverflow: rawDailyHits - cap } : {}),
      };
    }
    case 'drop_round': {
      const tier = tierOfMostOverdue(overdue);
      const R = params.tierRounds[tier];
      const canDrop = R > 2; // 保底 2，不可低于 2
      const newRounds = { ...params.tierRounds };
      if (canDrop) newRounds[tier] = R - 1;
      const newParams: PlanParams = { ...params, tierRounds: newRounds };
      const validation = canDrop ? revalidate(newParams, input) : base;
      return {
        strategy: s,
        plainWords,
        newFinishDate: planFinishDate(newParams, tierCounts),
        newDailyHits: validation.dailyHits,
        validation,
        affectedWordCount: affected,
        deadlineExceeded: false,
      };
    }
    case 'freeze': {
      // 稳固词移出本轮 → 末轮复查一次：每词 hits 从 R_t 降为 1
      const steadyIds = new Set(input.steadyWords.filter((x) => x.steady).map((x) => x.wordId));
      const steadyWordsInOverdue = new Set(overdue.filter((h) => steadyIds.has(h.wordId)).map((h) => h.wordId));
      let saved = 0;
      for (const wid of steadyWordsInOverdue) {
        const hit = overdue.find((h) => h.wordId === wid);
        if (!hit) continue;
        const R = params.tierRounds[hit.tier] ?? 0;
        saved += Math.max(0, R - 1);
      }
      const newTotal = Math.max(0, base.totalHits - saved);
      const windowDays = Math.max(1, diffDays(params.deadlineDate, params.startDate));
      const newDailyHits = Math.ceil(newTotal / windowDays);
      const validation: ValidationResult = {
        ...base,
        totalHits: newTotal,
        dailyHits: newDailyHits,
        dailyMinutes: (newDailyHits * params.avgHitSec) / 60,
        pass: (newDailyHits * params.avgHitSec) / 60 <= params.dailyBudgetMin + 1e-9,
      };
      return {
        strategy: s,
        plainWords,
        newFinishDate: planFinishDate(params, tierCounts),
        newDailyHits,
        validation,
        affectedWordCount: affected,
        deadlineExceeded: false,
      };
    }
  }
}

// ===== 执行重排 =====

/**
 * 执行重排。不变量（规则 4）：每个 overdue hit 恰好获得一条 mutation（债务清零）。
 * @param deferredIds 显式部分放弃（规则 5）：勾选"本轮跳过"的子集 → 标 deferred，只在末轮出现一次
 * @param today 可选；compress/freeze 的摊入起点（缺省用 plan startDate）
 */
export function applyStrategy(
  s: RescheduleStrategy,
  input: ValidationInput,
  overdue: HitRecord[],
  deferredIds?: string[],
  today?: string,
): StrategyOutcome {
  const { params, tierCounts, steadyWords } = input;
  const base = validatePlan(input);
  const deferredSet = new Set(deferredIds ?? []);
  const sorted = [...overdue].sort((a, b) =>
    a.scheduledDate < b.scheduledDate ? -1 : a.scheduledDate > b.scheduledDate ? 1 : 0,
  );
  const startFrom = today ?? params.startDate;
  const mutations: HitMutation[] = [];

  switch (s) {
    case 'extend': {
      const finish = planFinishDate(params, tierCounts);
      const delta = Math.max(1, Math.ceil(overdue.length / Math.max(1, base.dailyHits)));
      const newFinish = addDays(finish, delta);
      if (newFinish > params.deadlineDate) {
        // 硬约束 #5：展期不得突破 deadline → 提示只能走 B / C / D 或上调预算
        return {
          ok: false,
          error: 'DeadlineExceeded',
          message: `Extend would finish on ${newFinish}, past the deadline ${params.deadlineDate}. Use compress / drop_round / freeze instead, or raise the daily budget.`,
        };
      }
      // 展期通过延长各层末轮窗口实现（整体后移 Δ 天）
      const newRounds = { ...params.tierRounds };
      const newTierRoundDays: Record<string, number[]> = { ...(params.tierRoundDays ?? {}) };
      const windows = planRounds(params, tierCounts);
      for (const tierStr of Object.keys(newRounds)) {
        const tier = Number(tierStr) as Tier;
        const R = newRounds[tier];
        if (R <= 0 || (tierCounts[tier] ?? 0) <= 0) continue;
        const last = windows.find((w) => w.tier === tier && w.roundNo === R);
        if (!last) continue;
        const days = newTierRoundDays[String(tier)] && newTierRoundDays[String(tier)].length === R
          ? [...newTierRoundDays[String(tier)]]
          : windows.filter((w) => w.tier === tier).map((w) => w.days);
        days[R - 1] = days[R - 1] + delta;
        newTierRoundDays[String(tier)] = days;
      }
      const newPlan: PlanParams = { ...params, tierRoundDays: newTierRoundDays };
      // 欠账顺延：从 today 起在 Δ 天内 round-robin（不早于 today、不晚于 deadline）
      const dates = spreadDates(sorted.length, startFrom, delta).map((d) => (d > params.deadlineDate ? params.deadlineDate : d));
      sorted.forEach((h, i) => {
        if (deferredSet.has(h.id)) {
          mutations.push({ hitId: h.id, action: 'defer', newStatus: 'deferred', reason: '显式部分放弃（本轮跳过）' });
        } else {
          mutations.push({
            hitId: h.id,
            action: 'reschedule',
            newScheduledDate: dates[i],
            newStatus: 'pending',
            reason: `展期：欠账顺延至延长窗口（+${delta} 天）`,
          });
        }
      });
      return { ok: true, newPlan, hitMutations: mutations, newFinishDate: newFinish, newDailyHits: base.dailyHits };
    }
    case 'compress': {
      // 欠账摊入本轮剩余天 + 下一轮；总工期不变，日额度上浮
      const H = horizonDays(input, today);
      // P1-1（PRD §4.4.4-B）：摊入后近期日额度超物理上限 → 结构化拒绝，引导换策略
      const rawDailyHits = Math.ceil((overdue.length + base.dailyHits * H) / H);
      const cap = maxDailyHitsCap(params);
      if (rawDailyHits > cap) {
        return {
          ok: false,
          error: 'CapacityExceeded',
          message: `Compress would need ${rawDailyHits} hits/day for ${H} days, exceeding the physical cap of ${cap} (dailyBudgetMin ${params.dailyBudgetMin} × 60 / avgHitSec ${params.avgHitSec}). Use drop_round / freeze instead, or raise the daily budget.`,
        };
      }
      const dates = spreadDates(sorted.length, startFrom, H);
      sorted.forEach((h, i) => {
        if (deferredSet.has(h.id)) {
          mutations.push({ hitId: h.id, action: 'defer', newStatus: 'deferred', reason: '显式部分放弃（本轮跳过）' });
        } else {
          mutations.push({
            hitId: h.id,
            action: 'reschedule',
            newScheduledDate: dates[i],
            newStatus: 'pending',
            reason: `压缩：欠账摊入未来 ${H} 天`,
          });
        }
      });
      return { ok: true, newPlan: params, hitMutations: mutations, newFinishDate: planFinishDate(params, tierCounts), newDailyHits: rawDailyHits };
    }
    case 'drop_round': {
      const tier = tierOfMostOverdue(overdue);
      const R = params.tierRounds[tier];
      if (R <= 2) {
        throw new Error(
          `drop_round: tier ${tier} already has the minimum 2 rounds; choose another strategy.`,
        );
      }
      const newPlan: PlanParams = { ...params, tierRounds: { ...params.tierRounds, [tier]: R - 1 } };
      const windows = planRounds(params, tierCounts);
      const droppedRoundEnd = windows.find((w) => w.tier === tier && w.roundNo === R)?.endDate ?? params.deadlineDate;
      const H = horizonDays(input, today);
      const rescheduleTargets = sorted.filter((h) => !(h.tier === tier && h.roundNo === R) && !deferredSet.has(h.id));
      const dates = spreadDates(rescheduleTargets.length, startFrom, H);
      let di = 0;
      for (const h of sorted) {
        if (deferredSet.has(h.id)) {
          mutations.push({ hitId: h.id, action: 'defer', newStatus: 'deferred', reason: '显式部分放弃（本轮跳过）' });
        } else if (h.tier === tier && h.roundNo === R) {
          // 被砍掉的最后一轮：降为 deferred（末轮复查语义）
          mutations.push({
            hitId: h.id,
            action: 'defer',
            newStatus: 'deferred',
            newScheduledDate: droppedRoundEnd,
            reason: `降轮：T${tier} 第 ${R} 轮移除`,
          });
        } else {
          mutations.push({
            hitId: h.id,
            action: 'reschedule',
            newScheduledDate: dates[di],
            newStatus: 'pending',
            reason: `降轮：T${tier} R${R}→R${R - 1}，其余欠账摊入未来 ${H} 天`,
          });
          di += 1;
        }
      }
      const validation = revalidate(newPlan, input);
      return { ok: true, newPlan, hitMutations: mutations, newFinishDate: planFinishDate(newPlan, tierCounts), newDailyHits: validation.dailyHits };
    }
    case 'freeze': {
      // 稳固欠账词 → deferred，末轮（该层最后窗口末日）复查一次；其余欠账摊入未来天数
      const steadyIds = new Set(steadyWords.filter((x) => x.steady).map((x) => x.wordId));
      const windows = planRounds(params, tierCounts);
      const H = horizonDays(input, today);
      const rescheduleTargets = sorted.filter((h) => !steadyIds.has(h.wordId) && !deferredSet.has(h.id));
      const dates = spreadDates(rescheduleTargets.length, startFrom, H);
      let di = 0;
      for (const h of sorted) {
        if (deferredSet.has(h.id)) {
          mutations.push({ hitId: h.id, action: 'defer', newStatus: 'deferred', reason: '显式部分放弃（本轮跳过）' });
        } else if (steadyIds.has(h.wordId)) {
          const lastEnd = windows
            .filter((w) => w.tier === h.tier)
            .reduce((acc, w) => (w.endDate > acc ? w.endDate : acc), params.startDate);
          mutations.push({
            hitId: h.id,
            action: 'defer',
            newStatus: 'deferred',
            newScheduledDate: lastEnd,
            reason: '冻结：已稳固，移出本轮，末轮复查一次',
          });
        } else {
          mutations.push({
            hitId: h.id,
            action: 'reschedule',
            newScheduledDate: dates[di],
            newStatus: 'pending',
            reason: `冻结：非稳固欠账摊入未来 ${H} 天`,
          });
          di += 1;
        }
      }
      const preview = previewStrategy('freeze', input, overdue);
      return { ok: true, newPlan: params, hitMutations: mutations, newFinishDate: preview.newFinishDate, newDailyHits: preview.newDailyHits };
    }
  }
}

/** 空校验结果占位（供外部在异常路径使用） */
export { emptyValidation };
export type { TierWordCounts };
