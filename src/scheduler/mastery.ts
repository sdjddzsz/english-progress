/**
 * mastery.ts —— 稳固判定 / 掌握度降频 / 首末轮保底（硬约束 #4）。
 * 纯函数，零依赖。
 */
import { STEADY_MIN_AUDIO_RECOGNIZED, STEADY_MIN_INSTANT_COUNT } from '../config/constants';
import type { FeedbackSignal } from './types';

/**
 * 保底约束（硬约束 #4，不可妥协）：
 * 稳固词在第 1 轮和最后 1 轮必现，仅中间轮可跳。
 * skipAllowed(1, R) === skipAllowed(R, R) === false 对任意 R。
 */
export function skipAllowed(roundNo: number, tierRounds: number): boolean {
  return roundNo !== 1 && roundNo !== tierRounds;
}

/**
 * 单词折减后 hits：稳固词从 R 降为 2（首 + 末）；R ≤ 2 时无折减空间。
 */
export function decayedHitsForWord(wordRounds: number, steady: boolean): number {
  if (!steady) return wordRounds;
  return Math.min(2, Math.max(0, wordRounds));
}

/**
 * 稳固判定（PRD §4.4.4）：
 * L1 秒认 连续 ≥ 2 次 且 无任何 L2 问题标签 且 在听觉模态 hit 中被正确识别 ≥ 1 次。
 * "正确识别" = L1 ∈ { instant, recognized }（秒认 / 认得）。
 */
export function isSteadySignal(feedbacks: FeedbackSignal[]): boolean {
  if (feedbacks.length === 0) return false;
  let instantCount = 0;
  let audioRecognized = 0;
  for (const f of feedbacks) {
    // 无任何 L2 问题标签
    if (f.l2Tags.length > 0) return false;
    if (f.l1 === 'instant') instantCount += 1;
    if (f.modality === 'audio' && (f.l1 === 'instant' || f.l1 === 'recognized')) {
      audioRecognized += 1;
    }
  }
  return (
    instantCount >= STEADY_MIN_INSTANT_COUNT && audioRecognized >= STEADY_MIN_AUDIO_RECOGNIZED
  );
}
