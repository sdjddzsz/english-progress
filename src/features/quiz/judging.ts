/**
 * judging.ts —— 考查制判定核心（用户 2026-10-14 定案，摸底已砍）。
 *
 * 判定规则（按答题用时 + 对错，**客观可判**，取代原自评摸底）：
 *   ≤1s  且选对 → 熟练：streak+1；连续熟练 ≥5 次本轮出池（不再出现）
 *   1-3s 且选对 → 认识：连续性中断，streak 清零
 *   3-5s 且选对 → 不熟：streak 清零、failStreak+1
 *   >5s 或选错  → 生词：streak 清零、failStreak+1、层降
 *   连续不熟/生词 ≥3 次 → 特种训练（无视间隔每天必考，直到毕业）
 *
 * 考查频率（越生疏越频繁）：按层给出应考间隔天数
 *   T4=0（每天）、T3=1、T2=2、T1=3。
 *
 * 本轮计划结束条件：**全部词连续熟练 ≥5 次**。
 *
 * 纯函数、零 IO、零 React 依赖。
 */
import type { Tier } from '../../types/domain';

/** 连续熟练多少次毕业（本轮计划内不再出现） */
export const QUIZ_GRADUATE_STREAK = 5;
/** 连续多少次不熟/生词进入特种训练 */
export const QUIZ_SPECIAL_TRAINING_FAILS = 3;
/** 各用时档位（毫秒） */
export const QUIZ_MS_INSTANT = 1000;
export const QUIZ_MS_RECOGNIZED = 3000;
export const QUIZ_MS_UNFAMILIAR = 5000;

export type QuizVerdict = 'skilled' | 'recognized' | 'unfamiliar' | 'unknown';

/**
 * 单题判定：用时 + 对错 → 四档结论。
 * 选错时不管用时不可以「熟练/认识」，最高只有「不熟」（用户规则：熟练必须选对且足够快）。
 */
export function judgeAnswer(elapsedMs: number, correct: boolean): QuizVerdict {
  if (!correct) return 'unknown';
  if (elapsedMs <= QUIZ_MS_INSTANT) return 'skilled';
  if (elapsedMs <= QUIZ_MS_RECOGNIZED) return 'recognized';
  if (elapsedMs <= QUIZ_MS_UNFAMILIAR) return 'unfamiliar';
  return 'unknown';
}

/** 判定后的层走向：熟练升一层（1 封顶），生词降一层（4 兜底），认识/不熟维持 */
export function tierAfterVerdict(tier: Tier, verdict: QuizVerdict): Tier {
  if (verdict === 'skilled') return Math.max(1, tier - 1) as Tier;
  if (verdict === 'unknown') return Math.min(4, tier + 1) as Tier;
  return tier;
}

/** 判定后的 streak：只有「熟练」累加，其余清零（「连续」熟练才作数） */
export function streakAfterVerdict(streak: number, verdict: QuizVerdict): number {
  return verdict === 'skilled' ? streak + 1 : 0;
}

/** 判定后的 failStreak：不熟/生词累加，熟练/认识清零 */
export function failStreakAfterVerdict(failStreak: number, verdict: QuizVerdict): number {
  return verdict === 'unfamiliar' || verdict === 'unknown' ? failStreak + 1 : 0;
}

/** 特种训练标记：failStreak 达标即 true；毕业（streak 达标）时解除 */
export function specialTrainingAfter(
  failStreak: number,
  streak: number,
  prev: boolean,
): boolean {
  if (streak >= QUIZ_GRADUATE_STREAK) return false;
  return prev || failStreak >= QUIZ_SPECIAL_TRAINING_FAILS;
}

/**
 * 各层再次可考的最少间隔（天，按自然日差）：越生疏考得越勤。
 *   T4=1（昨天考过今天还能考，同日不重复）、T3=2（隔天）、T2=3、T1=4。
 * 特种训练无视间隔每天必考（shouldQuizToday 单独判断）。
 */
export const TIER_QUIZ_INTERVAL_DAYS: Record<Tier, number> = { 1: 4, 2: 3, 3: 2, 4: 1 };

/**
 * 该词今天该不该考：
 *   已毕业（streak≥5）→ 不考；特种训练 → 视为 T4（每天必考，但**同日不重复**——
 *   否则中断后重进页面，刚答过的特种词会立刻再出，像从头开始）；否则按层间隔。
 */
export function shouldQuizToday(
  word: { tier: Tier; streak: number; specialTraining: boolean; lastQuizAt?: string },
  now: Date = new Date(),
): boolean {
  if (word.streak >= QUIZ_GRADUATE_STREAK) return false;
  if (!word.lastQuizAt) return true;
  const interval = word.specialTraining ? 1 : TIER_QUIZ_INTERVAL_DAYS[word.tier];
  const last = new Date(word.lastQuizAt);
  if (Number.isNaN(last.getTime())) return true;
  const dayStart = (d: Date): number =>
    Math.floor(d.getTime() / 86400000);
  return dayStart(now) - dayStart(last) >= interval;
}

/** 判定结果对用户的一句话反馈（考查页直接展示） */
export function verdictLabel(v: QuizVerdict): string {
  switch (v) {
    case 'skilled':
      return '熟练';
    case 'recognized':
      return '认识';
    case 'unfamiliar':
      return '不熟';
    case 'unknown':
      return '生词';
  }
}

/** 判定配色（考查页 chip 用）：熟练绿、认识蓝、不熟橙、生词红 */
export function verdictColor(v: QuizVerdict): 'success' | 'info' | 'warning' | 'error' {
  switch (v) {
    case 'skilled':
      return 'success';
    case 'recognized':
      return 'info';
    case 'unfamiliar':
      return 'warning';
    case 'unknown':
      return 'error';
  }
}
