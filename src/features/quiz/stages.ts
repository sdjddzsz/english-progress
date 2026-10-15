/**
 * stages.ts —— 四阶段学习制（用户 2026-10-15 拍板）：
 *   阶段一：由词选义（看单词 → 4 选 1 词义，即原考查页题型）
 *   阶段二：由义选词（看词义 → 4 选 1 单词）
 *   阶段三：听音选词（听发音 → 4 选 1 单词）
 *   阶段四：听词拼写（听发音 → 拼写输入）
 *
 * 规则：
 *   - 新词一律进阶段一；阶段一~三毕业（连续熟练 ≥ 该阶段阈值，默认 3）→ 进入下一阶段；
 *   - 阶段四完成拼写（写对一次）→ 彻底毕业（stage=0，不再出现）；
 *   - 每个阶段「总学不会」（连续不熟/生词 ≥3）→ 该阶段特种训练（每天必考）；
 *   - 阶段池 = 该阶段全部词，**不限每天一轮**（用户 2026-10-15 追加：完成一轮可立即再来一轮，
 *     同日可重复刷；排序保证久未考/越生疏的先出）；
 *   - 池内排序：特种训练优先 → 层高（越生疏）靠前 → 上次考查越久越靠前。
 *
 * 纯函数、零 IO、零 React 依赖。
 */
import type { BookWord, Tier } from '../../types/domain';
import type { QuizVerdict } from './judging';

export type WordStage = 0 | 1 | 2 | 3 | 4;

export interface StageMeta {
  stage: 1 | 2 | 3 | 4;
  name: string;
  desc: string;
}

export const STAGE_META: Record<1 | 2 | 3 | 4, StageMeta> = {
  1: { stage: 1, name: '阶段一 · 由词选义', desc: '看单词，4 选 1 词义' },
  2: { stage: 2, name: '阶段二 · 由义选词', desc: '看词义，4 选 1 单词' },
  3: { stage: 3, name: '阶段三 · 听音选词', desc: '听发音，4 选 1 单词' },
  4: { stage: 4, name: '阶段四 · 听词拼写', desc: '听发音，拼写单词' },
};

export const STAGE_LABEL: Record<WordStage, string> = {
  0: '已毕业',
  1: '阶段一',
  2: '阶段二',
  3: '阶段三',
  4: '阶段四',
};

/** 各阶段毕业所需连续熟练次数的默认值（设置页可改，阶段四=写对一次即毕业，不可改） */
export const DEFAULT_STAGE_GRADUATE: Record<1 | 2 | 3, number> = { 1: 3, 2: 3, 3: 3 };

/** 连续不熟/生词多少次进入特种训练（与旧考查制一致） */
export const STAGE_SPECIAL_FAILS = 3;

/**
 * 阶段池：该阶段全部词（不限每天一轮，同日可重复刷）。
 * 排序：特种 → 层高 → 久未考（刚答过的自然排最后，先把没刷的刷完）。
 */
export function selectStagePool(all: BookWord[], stage: 1 | 2 | 3 | 4, _now: Date = new Date()): BookWord[] {
  const pool = all.filter((bw) => bw.stage === stage);
  return [...pool].sort((a, b) => {
    if (a.specialTraining !== b.specialTraining) return a.specialTraining ? -1 : 1;
    if (a.tier !== b.tier) return b.tier - a.tier;
    return (a.lastQuizAt ?? '').localeCompare(b.lastQuizAt ?? '');
  });
}

/** 阶段统计：各阶段词库量 / 特种训练量（首页四卡片用；待刷=词库量，不限一轮） */
export function stageStats(
  all: BookWord[],
  _now: Date = new Date(),
): Record<1 | 2 | 3 | 4, { total: number; due: number; special: number; graduated: number }> {
  const out = {
    1: { total: 0, due: 0, special: 0, graduated: 0 },
    2: { total: 0, due: 0, special: 0, graduated: 0 },
    3: { total: 0, due: 0, special: 0, graduated: 0 },
    4: { total: 0, due: 0, special: 0, graduated: 0 },
  } as Record<1 | 2 | 3 | 4, { total: number; due: number; special: number; graduated: number }>;
  for (const bw of all) {
    if (bw.stage === 0) continue;
    const s = out[bw.stage];
    s.total += 1;
    s.due += 1; // 不限每天一轮：待刷=词库量
    if (bw.specialTraining) s.special += 1;
  }
  return out;
}

/** 单题判定结果（含阶段走向），由考查页写回 repo */
export interface StageResultPatch {
  tier: Tier;
  streak: number;
  failStreak: number;
  specialTraining: boolean;
  lastQuizAt: string;
  quizDayStreak: number;
  quizDayPassed: boolean;
  stage: WordStage;
  stageStreak: number;
}

/**
 * 阶段一~三（4 选 1）：判定 → 状态走向 →（可能）晋级。
 * graduateStreak = 该阶段毕业阈值（设置页可配）。
 */
export function applyStageChoiceResult(
  bw: BookWord,
  verdict: QuizVerdict,
  graduateStreak: number,
  now: Date = new Date(),
): StageResultPatch {
  const base: StageResultPatch = {
    tier: bw.tier,
    streak: bw.streak,
    failStreak: bw.failStreak,
    specialTraining: bw.specialTraining,
    lastQuizAt: now.toISOString(),
    quizDayStreak: bw.quizDayStreak,
    quizDayPassed: true,
    stage: bw.stage,
    stageStreak: bw.stageStreak,
  };

  let stage = bw.stage as 1 | 2 | 3;
  let stageStreak = bw.stageStreak;
  let tier = bw.tier;
  let failStreak = bw.failStreak;
  let special = bw.specialTraining;

  if (verdict === 'skilled') {
    stageStreak += 1;
    tier = Math.max(1, tier - 1) as Tier;
  } else {
    stageStreak = 0;
    if (verdict === 'unknown') tier = Math.min(4, tier + 1) as Tier;
    if (verdict === 'unfamiliar' || verdict === 'unknown') failStreak += 1;
  }
  if (failStreak >= STAGE_SPECIAL_FAILS) special = true;

  // 毕业晋级：连续熟练达标 → 下一阶段，特训解除，连击清零
  if (stageStreak >= graduateStreak) {
    stage = (stage + 1) as 1 | 2 | 3;
    stageStreak = 0;
    special = false;
    failStreak = 0;
  }

  return { ...base, tier, failStreak, specialTraining: special, stage, stageStreak };
}

/**
 * 阶段四（听词拼写）：写对一次 → 彻底毕业（stage=0）。
 * 写错按「生词」处理（降层 + failStreak + 特训计数），stageStreak 不使用。
 */
export function applyStageSpellingResult(bw: BookWord, correct: boolean, now: Date = new Date()): StageResultPatch {
  const base: StageResultPatch = {
    tier: bw.tier,
    streak: bw.streak,
    failStreak: bw.failStreak,
    specialTraining: bw.specialTraining,
    lastQuizAt: now.toISOString(),
    quizDayStreak: bw.quizDayStreak,
    quizDayPassed: true,
    stage: bw.stage,
    stageStreak: bw.stageStreak,
  };
  if (correct) {
    return { ...base, stage: 0, stageStreak: 0, specialTraining: false, failStreak: 0 };
  }
  const failStreak = bw.failStreak + 1;
  return {
    ...base,
    tier: Math.min(4, bw.tier + 1) as Tier,
    failStreak,
    specialTraining: bw.specialTraining || failStreak >= STAGE_SPECIAL_FAILS,
    stageStreak: 0,
  };
}
