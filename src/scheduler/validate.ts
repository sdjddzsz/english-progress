/**
 * validate.ts —— MRCS Step 1：时间校验 + 双档生成 + 降级路径（PRD §4.4.6 / §4.4.7）。
 * 校验以"时间预算"为准（v1.0 核心变更），不以词数为准。
 */
import {
  CRITICAL_MARGIN_RATIO,
  FALLBACK_TIER_ROUNDS,
  MAINTENANCE_MODE_BUDGET_MIN,
  RECOMMENDED_TIER_ROUNDS,
} from '../config/constants';
import type {
  DegradePath,
  PlanParams,
  Tier,
  ValidationInput,
  ValidationResult,
} from './types';
import { TIERS } from './types';
import { diffDays } from './expand';

/**
 * 总 hits：Σ(W_t × R_t)；降频开启时稳固词按层折减（R_t − 2）/词。
 * 折减需要 steadyWords 携带 tier（可选字段）。
 */
export function computeTotalHits(input: ValidationInput): number {
  const { params, tierCounts, steadyWords } = input;
  const steadyByTier = new Map<Tier, number>();
  for (const s of steadyWords) {
    if (s.steady && s.tier != null) {
      steadyByTier.set(s.tier, (steadyByTier.get(s.tier) ?? 0) + 1);
    }
  }
  let total = 0;
  for (const t of TIERS) {
    const W = tierCounts[t] ?? 0;
    const R = params.tierRounds[t] ?? 0;
    if (W <= 0 || R <= 0) continue;
    let hits = W * R;
    if (params.masteryDecayEnabled && R > 2) {
      const s = Math.min(steadyByTier.get(t) ?? 0, W);
      hits -= s * (R - 2);
    }
    total += hits;
  }
  return total;
}

/** 时间校验：dailyMinutes = dailyHits × avg_hit_sec / 60 ≤ budget；±5% 内为临界 */
export function validatePlan(input: ValidationInput): ValidationResult {
  const { params } = input;
  const totalHits = computeTotalHits(input);
  const windowDays = Math.max(1, diffDays(params.deadlineDate, params.startDate));
  const dailyHits = Math.ceil(totalHits / windowDays);
  const dailyMinutes = (dailyHits * params.avgHitSec) / 60;
  const pass = dailyMinutes <= params.dailyBudgetMin + 1e-9;
  const marginRatio = (params.dailyBudgetMin - dailyMinutes) / params.dailyBudgetMin;
  const critical = !pass && marginRatio >= -CRITICAL_MARGIN_RATIO;
  return { pass, totalHits, dailyHits, dailyMinutes, marginRatio, critical, windowDays };
}

/** 双档生成：推荐档（T1:2/T2:2/T3:3/T4:3）与保底档（全层 R2），各带校验结果 */
export function generateBothPlans(input: ValidationInput): {
  recommended: ValidationResult;
  fallback: ValidationResult;
} {
  const recommended = validatePlan({
    ...input,
    params: { ...input.params, tierRounds: { ...RECOMMENDED_TIER_ROUNDS }, planMode: 'recommended' },
  });
  const fallback = validatePlan({
    ...input,
    params: { ...input.params, tierRounds: { ...FALLBACK_TIER_ROUNDS }, planMode: 'fallback' },
  });
  return { recommended, fallback };
}

/**
 * 整层冻结（PRD §4.4.7 ① / §4.4.4 规则 5 的层级化推广）：
 * 被冻结层 R ← 1（只在末轮确认一次）。属 Require 级提案，须用户显式批准。
 */
export function applyTierFreeze(tierRounds: Record<Tier, number>, frozenTiers: Tier[]): Record<Tier, number> {
  const out = { ...tierRounds };
  for (const t of frozenTiers) out[t] = 1;
  return out;
}

/**
 * 降级路径判定（PRD §4.4.7）：
 * 推荐/保底通过 → 'fallback'（无需降级）；
 * 保底不通过但整层冻结 T1 后通过 → 'freeze_t1'；
 * 窗口非法（start ≥ deadline）→ 'exceed_deadline'；
 * 预算低于维持模式线（≈实习期）→ 'maintenance_mode'；
 * 其余 → 'raise_budget'。
 */
export function resolveDegradePath(input: ValidationInput): DegradePath {
  const { recommended, fallback } = generateBothPlans(input);
  if (recommended.pass) return 'fallback';
  if (fallback.pass) return 'fallback';

  const frozenParams: PlanParams = {
    ...input.params,
    tierRounds: applyTierFreeze(input.params.tierRounds, [1]),
    planMode: 'fallback',
  };
  const frozen = validatePlan({ params: frozenParams, tierCounts: input.tierCounts, steadyWords: input.steadyWords });
  if (frozen.pass) return 'freeze_t1';

  const T = diffDays(input.params.deadlineDate, input.params.startDate);
  if (T <= 0) return 'exceed_deadline';
  if (input.params.dailyBudgetMin < MAINTENANCE_MODE_BUDGET_MIN) return 'maintenance_mode';
  return 'raise_budget';
}
