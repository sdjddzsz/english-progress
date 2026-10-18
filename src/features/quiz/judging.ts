/**
 * judging.ts —— 考查制判定核心（用户 2026-10-14 定案，摸底已砍）。
 *
 * 判定规则（按答题用时 + 对错，**客观可判**，取代原自评摸底；
 * 用户 2026-10-15 放宽：熟练 ≤3s，其余各档 +2s）：
 *   ≤3s  且选对 → 熟练：streak+1；连续熟练 ≥5 次本轮出池（不再出现）
 *   3-5s 且选对 → 认识：连续性中断，streak 清零
 *   5-7s 且选对 → 不熟：streak 清零、failStreak+1
 *   >7s 或选错  → 生词：streak 清零、failStreak+1、层降
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
/** 各用时档位（毫秒；用户 2026-10-15 放宽：熟练 ≤3s，认识 ≤5s，不熟 ≤7s） */
export const QUIZ_MS_INSTANT = 3000;
export const QUIZ_MS_RECOGNIZED = 5000;
export const QUIZ_MS_UNFAMILIAR = 7000;

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

/** 判定 chip 的柔和底色（用户 2026-10-14：浅底深字，不用艳色实心） */
export function verdictChipSx(v: QuizVerdict): { bgcolor: string; color: string } {
  switch (v) {
    case 'skilled':
      return { bgcolor: '#e6f4ea', color: '#1b5e20' };
    case 'recognized':
      return { bgcolor: '#e3f2fd', color: '#0d47a1' };
    case 'unfamiliar':
      return { bgcolor: '#fff4e0', color: '#8d5300' };
    case 'unknown':
      return { bgcolor: '#fdecea', color: '#b3261e' };
  }
}

// ===== 每轮过关（用户 2026-10-14 建制，2026-10-15 改口径：
// 原按「当天小循环」设计，现放行机制改为按「轮」——同一个词在一轮里连续 N 次达到档位线才放行，
// 档位名也从「当天过关挡位」改为「每轮过关挡位」（设置页同步改名））=====

/** 每轮过关的档位线（设置页三选一，原名「当天过关挡位」，2026-10-15 改名） */
export type QuizDayThreshold = 'lenient' | 'standard' | 'strict';

/** 连续达标多少次算一轮内过关（放行） */
export const QUIZ_DAY_PASS_COUNT = 3;

/** 判定档位线：unknown=0 < unfamiliar=1 < recognized=2 < skilled=3 */
const VERDICT_RANK: Record<QuizVerdict, number> = {
  unknown: 0,
  unfamiliar: 1,
  recognized: 2,
  skilled: 3,
};

/**
 * 三档阈值线（一轮内连续达标次数）：
 *   宽松 = 连续 3 次比「生词」好（至少不熟）→ 本轮放行
 *   适当 = 连续 3 次比「不熟」好（至少认识）→ 本轮放行
 *   严格 = 连续 3 次比「认识」好（至少熟练）→ 本轮放行
 */
const THRESHOLD_LINE: Record<QuizDayThreshold, number> = {
  lenient: 1,
  standard: 2,
  strict: 3,
};

/** 挡位线显示名（用户 2026-10-18：题旁要显示「距本轮过关还差几次达标」） */
export function thresholdLineLabel(t: QuizDayThreshold): string {
  switch (t) {
    case 'lenient':
      return '不熟';
    case 'standard':
      return '认识';
    case 'strict':
      return '熟练';
  }
}

/** 本次判定是否达到当前档位线 */
export function dayVerdictOk(v: QuizVerdict, threshold: QuizDayThreshold): boolean {
  return VERDICT_RANK[v] >= THRESHOLD_LINE[threshold];
}

/** 连续计数：达标 +1，不达标清零 */
export function quizDayStreakAfter(
  dayStreak: number,
  v: QuizVerdict,
  threshold: QuizDayThreshold,
): number {
  return dayVerdictOk(v, threshold) ? dayStreak + 1 : 0;
}

/** 自然日同天判断（UTC 日差=0）。lastQuizAt 为 undefined/脏值时视为不同天 */
export function isSameUtcDay(iso: string | undefined, now: Date): boolean {
  if (!iso) return false;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return false;
  return Math.floor(t.getTime() / 86400000) === Math.floor(now.getTime() / 86400000);
}

/**
 * 总计划排次用的「当天首次判定快照」：tier 只在当天第一次判定时更新，
 * 之后当天内的升/降档不影响明天起的频率安排（用户 2026-10-14）。
 */
export function tierAfterQuiz(
  currentTier: Tier,
  v: QuizVerdict,
  firstQuizOfDay: boolean,
): Tier {
  return firstQuizOfDay ? tierAfterVerdict(currentTier, v) : currentTier;
}

/** 该词今天是否已过关（quizDayPassed 只对当天有效，隔夜自动失效；
 *  2026-10-15 起只在整个词达到过关线时才写 true，不再是「答过就 true」） */
export function isDayPassedToday(
  word: { quizDayPassed?: boolean; lastQuizAt?: string },
  now: Date = new Date(),
): boolean {
  return Boolean(word.quizDayPassed) && isSameUtcDay(word.lastQuizAt, now);
}

/**
 * 本轮放行判定（用户 2026-10-15：放行机制必须与设置页「每轮过关挡位」匹配——
 * 旧实现「答对一次就放行」，档位设置形同虚设。2026-10-17 增补首答规则）。
 *
 * 规则（阶段一~四一致）：
 *  - **本轮第一次作答就达到当前挡位线（首见即达标）⇒ 一遍过，立即放行**
 *    （用户 2026-10-18 定案：首过看的是「当前设置的挡位」——设首熟就要熟练，
 *     设首认识认识就行；旧实现硬编码「熟练」，档位设置对首过形同虚设）；
 *  - 其余词：连续 QUIZ_DAY_PASS_COUNT 次达到档位线 ⇒ 放行（本轮不再出现）；
 *  - 本次作答后离开本阶段（晋级/毕业）⇒ 立即放行（它已不属于本阶段的池）；
 *  - 连续计数跨天自动重新起算（lastQuizAt 不是今天 ⇒ 已累计次数作废）。
 */
export function roundRelease(args: {
  verdict: QuizVerdict;
  prevStreak: number;
  threshold: QuizDayThreshold;
  leftStage: boolean;
  /** 本轮内该词的第几次作答（1=第一次；不传按非第一次处理） */
  attemptNo?: number;
  lastQuizAt?: string;
  now?: Date;
}): { dayStreak: number; release: boolean } {
  const now = args.now ?? new Date();
  const carried = isSameUtcDay(args.lastQuizAt, now) ? args.prevStreak : 0;
  const dayStreak = quizDayStreakAfter(carried, args.verdict, args.threshold);
  // 首见即达标：本轮第一次作答（attemptNo===1）就达到当前挡位线 ⇒ 一遍过
  const firstTryOk = args.attemptNo === 1 && dayVerdictOk(args.verdict, args.threshold);
  return {
    dayStreak,
    release: args.leftStage || firstTryOk || dayStreak >= QUIZ_DAY_PASS_COUNT,
  };
}
