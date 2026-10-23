/**
 * stagePace.ts —— 四阶段制的**真实节奏**与完成预估（用户 2026-10-23 拍板「方案 2」）。
 *
 * 背景：首页计划卡原来显示的是 tier 模型数学（Σ各层词数×轮次 ÷ 窗口天数 × 每题秒数）——
 * 四阶段考查不计入 hits、词晋级/毕业后离开 tier 池，那套预估对四阶段用户是**持续误报**
 * （用户截图：红线「日均需 93 分钟，超出预算」常年亮着）。
 *
 * 现在按四阶段现实算：
 *  - 剩余词 = book_words 中 stage≠0 的（还在阶段一~四池里的）；
 *  - 真实节奏 = book_words.lastQuizAt 的日期分布（**每次答题都写**，考查页也写），
 *    统计近 windowDays 天：学习天数、学习日均刷词量（去重词）、日均用时估算；
 *  - 预计完成日 = 剩余词 ÷ 学习日均速 = 所需学习日，再按学习频率折算成自然日；
 *  - 判定：预计完成日 vs 计划窗口截止日（deadlineDate）——来得及/差几天/要提到多少。
 *
 * 纯函数、零 IO、零 React 依赖（store 调它，测试可直跑）。
 */
import type { BookWord } from '../../types/domain';

const DAY_MS = 86_400_000;

/** UTC 日序号（与 judging.isSameUtcDay 同口径） */
function utcDay(iso: string): number {
  return Math.floor(new Date(iso).getTime() / DAY_MS);
}

/** 今天 UTC 0 点的时间戳 */
function utcMidnight(now: Date): number {
  return utcDay(now.toISOString()) * DAY_MS;
}

export interface StagePace {
  /** 统计窗口天数（默认 14） */
  windowDays: number;
  /** 窗口内有答题记录的天数（学习日） */
  activeDays: number;
  /** 学习日均刷词量（窗口内答题去重词数 ÷ 学习日，四舍五入） */
  wordsPerDay: number;
  /** 学习日均用时估算（分钟）：wordsPerDay × avgHitSec / 60 */
  minutesPerDay: number;
  /** 窗口内被答过的不同词数（含跨天重复答同一个，只算一次） */
  touchedWords: number;
}

export type PaceVerdict =
  | { kind: 'finished' }
  /** 学习日太少，估不出来（不硬给数字——旧误报就是这么来的） */
  | { kind: 'insufficient'; activeDays: number }
  | { kind: 'ontrack'; finishDate: string; gapDays: number }
  | { kind: 'behind'; finishDate: string; gapDays: number; neededPerDay: number; neededMinutes: number };

/**
 * 真实节奏：近 windowDays 天（含今天）内，按 UTC 日汇总 lastQuizAt。
 * avgHitSec 用于把词数量折算成分钟（计划参数，默认 12 秒/词）。
 */
export function computeStagePace(bws: BookWord[], now: Date, windowDays = 14, avgHitSec = 12): StagePace {
  const todayDay = utcDay(now.toISOString());
  const perDay = new Map<number, Set<string>>();
  for (const bw of bws) {
    if (!bw.lastQuizAt) continue;
    const d = utcDay(bw.lastQuizAt);
    if (d > todayDay || todayDay - d >= windowDays) continue;
    let set = perDay.get(d);
    if (!set) {
      set = new Set();
      perDay.set(d, set);
    }
    set.add(bw.wordId);
  }
  const activeDays = perDay.size;
  let touched = 0;
  for (const s of perDay.values()) touched += s.size;
  const wordsPerDay = activeDays > 0 ? Math.round(touched / activeDays) : 0;
  return {
    windowDays,
    activeDays,
    wordsPerDay,
    minutesPerDay: (wordsPerDay * avgHitSec) / 60,
    touchedWords: touched,
  };
}

export interface StageProjection {
  finishDate: string;
  /** 所需学习日（剩余 ÷ 学习日均速，向上取整） */
  studyDaysNeeded: number;
  /** 折算成自然日（按当前学习频率：学习日占比缩放） */
  calendarDays: number;
}

/**
 * 完成预估：剩余词 ÷ 学习日均速 ⇒ 所需学习日；再按「窗口内学习频率」折算自然日
 * （例：14 天里学了 7 天，则自然日 ≈ 学习日 × 2——不是天天学就别按天天学投影）。
 * 数据不足（学习日 < minActiveDays 或日均速为 0）⇒ 返回 null，由调用方显示「数据积累中」。
 */
export function projectStageFinish(args: {
  remaining: number;
  pace: StagePace;
  now: Date;
  minActiveDays?: number;
}): StageProjection | null {
  const { remaining, pace, now } = args;
  const minActive = args.minActiveDays ?? 3;
  if (remaining <= 0 || pace.activeDays < minActive || pace.wordsPerDay <= 0) return null;
  const studyDaysNeeded = Math.ceil(remaining / pace.wordsPerDay);
  const calendarDays = Math.ceil((studyDaysNeeded * pace.windowDays) / Math.max(1, pace.activeDays));
  const finish = new Date(utcMidnight(now) + calendarDays * DAY_MS);
  return { finishDate: finish.toISOString().slice(0, 10), studyDaysNeeded, calendarDays };
}

/** 速度判定：预计完成日 vs 窗口截止日；落后时顺带算「按时完成需要什么日均速」 */
export function paceVerdict(args: {
  remaining: number;
  pace: StagePace;
  now: Date;
  deadlineDate: string;
  avgHitSec?: number;
}): PaceVerdict {
  const { remaining, pace, now, deadlineDate } = args;
  if (remaining <= 0) return { kind: 'finished' };
  const proj = projectStageFinish({ remaining, pace, now });
  if (!proj) return { kind: 'insufficient', activeDays: pace.activeDays };
  const gapDays = Math.round(
    (utcMidnight(new Date(`${proj.finishDate}T00:00:00Z`)) - utcMidnight(new Date(`${deadlineDate}T00:00:00Z`))) / DAY_MS,
  );
  if (gapDays <= 0) return { kind: 'ontrack', finishDate: proj.finishDate, gapDays: -gapDays };
  const daysLeft = Math.max(1, Math.ceil((utcMidnight(new Date(`${deadlineDate}T00:00:00Z`)) - utcMidnight(now)) / DAY_MS));
  const neededPerDay = Math.ceil(remaining / daysLeft);
  const avgHitSec = args.avgHitSec ?? 12;
  return {
    kind: 'behind',
    finishDate: proj.finishDate,
    gapDays,
    neededPerDay,
    neededMinutes: (neededPerDay * avgHitSec) / 60,
  };
}
