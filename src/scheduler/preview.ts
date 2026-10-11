/**
 * preview.ts —— 参数影响预览（P0-09 / S2）：
 * 任一进度参数修改后，预览总覆盖次数变化、日均与分钟校验、预计完成日、通过判定是否翻转。
 * 纯函数。
 */
import type { ImpactPreviewResult, PlanParams, TierWordCounts, ValidationInput, WordSteadiness } from './types';
import { planFinishDate } from './expand';
import { validatePlan } from './validate';

export function impactPreview(
  oldP: PlanParams,
  newP: PlanParams,
  tierCounts: TierWordCounts,
  steadyWords: WordSteadiness[],
): ImpactPreviewResult {
  const oldInput: ValidationInput = { params: oldP, tierCounts, steadyWords };
  const newInput: ValidationInput = { params: newP, tierCounts, steadyWords };
  const oldTotal = validatePlan(oldInput).totalHits;
  const newValidation = validatePlan(newInput);
  // 完成日 = 当前排布下最后一个窗口的结束日（校验通过时即 deadline）
  const newFinishDate = planFinishDate(newP, tierCounts);
  const passChanged = validatePlan(oldInput).pass !== newValidation.pass;
  return {
    totalHitsDelta: newValidation.totalHits - oldTotal,
    dailyMinutes: newValidation,
    newFinishDate,
    passChanged,
  };
}
