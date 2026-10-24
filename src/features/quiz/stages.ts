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
import type { StageStatsSummary } from '../../data/repos/wordRepo';
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

/**
 * 层（tier）→ 现行四档中文标签（用户 2026-10-15：T1~T4 旧标签失效，改用判定四档展示）。
 * tier 本身仍是内部排序/降频依据（1=最熟 4=最生），对外只显示四档。
 */
export const TIER_VERDICT_LABEL: Record<Tier, string> = {
  1: '熟练',
  2: '认识',
  3: '不熟',
  4: '生词',
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
/**
 * 四阶段卡片统计：各阶段词库量 / 待刷 / 特种训练词数。
 *
 * 2026-10-24 起原料由云端算好（PG 函数 ep_stage_stats 的 byStage/specialByStage
 * 两个计数聚合）——原实现拉整本 8296 行只为数 6 个数，云资源拥挤时这 9 个
 * 串行分页请求正是「数据更新常常出错」的失败面之一。
 * 彻底毕业（stage=0）不计入任何阶段卡片（byStage 里没有 0 键或忽略它）。
 * due = total：阶段池不限每天一轮，待刷就是词库量。
 */
export function stageStats(
  counts: StageStatsSummary,
): Record<1 | 2 | 3 | 4, { total: number; due: number; special: number; graduated: number }> {
  const out = {
    1: { total: 0, due: 0, special: 0, graduated: 0 },
    2: { total: 0, due: 0, special: 0, graduated: 0 },
    3: { total: 0, due: 0, special: 0, graduated: 0 },
    4: { total: 0, due: 0, special: 0, graduated: 0 },
  } as Record<1 | 2 | 3 | 4, { total: number; due: number; special: number; graduated: number }>;
  for (const n of [1, 2, 3, 4] as const) {
    const total = counts.byStage[n] ?? 0;
    out[n] = { total, due: total, special: counts.specialByStage[n] ?? 0, graduated: 0 };
  }
  return out;
}

/**
 * 进入新一轮：轮标线计数归零（用户 2026-10-18：「进入新一轮的单词得从零开始计数」——
 * 旧实现不归零，上一轮刷到 6/3 的数字带进新一轮，「连续 3 次达标才放行」形同虚设；
 * 实测截图：authentic 轮标线 6/3 已过关仍带着 6 这个数）。
 *
 * ⚠ 毕业线（stageStreak）是**跨轮累计**（连续 N 轮首见达标才毕业），**不归零**；
 * 这里只归零轮标线（quizDayStreak / quizDayPassed）。
 * 已经是 0 的词原样返回（引用稳定，调用方可按引用相等跳过写库）。
 */
export function enteringRound(bw: BookWord): BookWord {
  if (bw.quizDayStreak === 0 && !bw.quizDayPassed) return bw;
  return { ...bw, quizDayStreak: 0, quizDayPassed: false };
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
 * ★★ 两条线、两个挡位，永远不许混（用户 2026-10-18 发火定案）：
 *  - **轮标线（放行线）**用「每轮过关挡位」（设置页 quizDayThreshold：宽松/适当/严格），
 *    归 judging.ts 的 roundRelease 管，本函数一概不碰；
 *  - **毕业线（晋级线）**用设置页「阶段毕业条件」——连续**熟练** N 次，判定写死「熟练」，
 *    只有次数（graduateStreak）可配。**绝不允许把每轮挡位传进来**（2026-10-18 事故：
 *    传了 quizDayThreshold，用户设「适当」时毕业线按「认识」计数，认识就晋级）。
 */
/** 毕业线首过判定：固定「熟练」（设置页只开放次数，不开放判定档位） */
export const STAGE_GRADUATE_VERDICT: QuizVerdict = 'skilled';
/** 毕业线档位显示名（固定，不随每轮挡位变） */
export const STAGE_GRADUATE_LABEL = '熟练';

/**
 * 阶段一~三（4 选 1）：判定 → 状态走向 →（可能）晋级。
 * graduateStreak = 该阶段毕业所需连续熟练次数（设置页可配，默认 3）。
 *
 * ★ 每轮首过规则（用户 2026-10-18 定案）：
 *  - **首见即熟练**：本轮第一次作答（attemptNo===1）就是「熟练」才算这一轮「首过」；
 *  - 首见熟练 ⇒ stageStreak +1；首见不是熟练 ⇒ stageStreak 清零（「连续」从此轮断）；
 *  - **同轮重排后的作答（attemptNo>1）一律不动 stageStreak**——既不加也不清零：
 *    哪怕这个词今天已经被重排刷过好几轮、答熟练了 N 次，没凑够连续 N 轮首见熟练
 *    就坚决不毕业（毕业线只认首见）；
 *  - tier / failStreak / 特训标记仍然每次作答都更新（它们管频率，不管毕业）。
 */
export function applyStageChoiceResult(
  bw: BookWord,
  verdict: QuizVerdict,
  graduateStreak: number,
  now: Date = new Date(),
  attemptNo?: number,
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

  // 毕业线（stageStreak）只由「本轮首见作答」写：首见熟练 +1，否则清零；
  // 重排后的作答（attemptNo>1）不碰它——刷再多次也不算首过（用户 2026-10-18）
  if (attemptNo === undefined || attemptNo === 1) {
    stageStreak = verdict === STAGE_GRADUATE_VERDICT ? stageStreak + 1 : 0;
  }
  if (verdict === 'skilled') {
    tier = Math.max(1, tier - 1) as Tier;
  } else {
    if (verdict === 'unknown') tier = Math.min(4, tier + 1) as Tier;
    if (verdict === 'unfamiliar' || verdict === 'unknown') failStreak += 1;
  }
  if (failStreak >= STAGE_SPECIAL_FAILS) special = true;

  // 毕业晋级：连续熟练达标 → 下一阶段，特训解除，连击清零（档位固定熟练，见上）
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
