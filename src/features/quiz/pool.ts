/**
 * pool.ts —— 考查制选词池（用户 2026-10-15 拍板 A：今日页清单与考查页共用同一套规则）。
 *
 * 规则（与 QuizPage 出题完全一致）：
 *   进池 = shouldQuizToday（毕业不考 / 特种训练每天 / 其余按层间隔）且当天未过关；
 *   排序 = 特种训练优先 → 层高优先（越生疏越靠前）→ 上次考查早的优先；
 *   出池 = 连续熟练 ≥ QUIZ_GRADUATE_STREAK（毕业）。
 *
 * 纯函数、零 IO、零 React 依赖。
 */
import { QUIZ_GRADUATE_STREAK, isDayPassedToday, shouldQuizToday } from './judging';
import type { BookWord } from '../../types/domain';

export interface QuizPoolResult {
  /** 今天该考的词（已排序：特种 → 层高 → 久未考） */
  pool: BookWord[];
  /** 词书总词数 */
  total: number;
  /** 已毕业（本轮出池，不再出现） */
  graduated: number;
}

export function selectQuizPool(all: BookWord[], now: Date = new Date()): QuizPoolResult {
  const pool = all.filter((bw) => shouldQuizToday(bw, now) && !isDayPassedToday(bw, now));
  const sorted = [...pool].sort((a, b) => {
    if (a.specialTraining !== b.specialTraining) return a.specialTraining ? -1 : 1;
    if (a.tier !== b.tier) return b.tier - a.tier; // 越生疏越靠前
    return (a.lastQuizAt ?? '').localeCompare(b.lastQuizAt ?? '');
  });
  const total = all.length;
  const graduated = total - all.filter((bw) => bw.streak < QUIZ_GRADUATE_STREAK).length;
  return { pool: sorted, total, graduated };
}
