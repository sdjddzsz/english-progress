/**
 * calibration.ts —— **按练习成绩持续判定掌握程度**（用户 2026-10-13：
 * 「掌握程度根据练习成绩判定」，导入时不再按词频猜层级）。
 *
 * 每次反馈落库后按反馈证据调整词层：
 *  - 证据充分且连续「秒认」⇒ 上移一层（更熟 ⇒ 更少轮次）；
 *  - 出现「不认识」/「见过想不起」⇒ 下移一层（宁严勿松）；
 *  - 证据不足 ⇒ **不动**（不猜）。
 *
 * ⚠ 与旧实现的区别（重要）：旧版是「前 14 天校准窗口」，过了就彻底不再判定层。
 *   那意味着 11 月以后掌握程度就永远冻结在初始值 —— 与本项目「进度由真实学习数据驱动」
 *   的立身之本直接矛盾。现在窗口只影响**观察窗长度**（近 N 日证据），不再决定「是否判定」。
 */
import { TIER_RECALIBRATION_CONFIRM_RATIO } from '../../config/constants';
import { diffDays } from '../../scheduler';
import type { Feedback, L1State, StudyPlan, Tier } from '../../types/domain';
import { getRepos, getToolCtx } from '../../store/useAppStore';
import { executeTool } from '../../ai/authz';

/** 观察窗：取近 N 日反馈作为证据（不再是「判定窗口」） */
export const CALIBRATION_LOOKBACK_DAYS = 7;
/** 兼容旧名：不再表示「校准窗口」，仅保留给引用方，避免误解为「14 天后不判定」 */
export const CALIBRATION_WINDOW_DAYS = 14;

/** 保留旧函数签名（测试与旧调用方仍引用）；语义已变为「是否处于观察窗早期」 */
export function inCalibrationWindow(planStartDate: string, today: string): boolean {
  return diffDays(today, planStartDate) < CALIBRATION_WINDOW_DAYS;
}

/** 上移所需的连续秒认次数：>=2 次（单次秒认不足以说明问题） */
export const PROMOTE_MIN_INSTANT_STREAK = 2;

/** 判定依据的最近证据条数（观察窗内最后 N 条） */
const EVIDENCE_TAIL = 8;

/**
 * 单词最近证据 → 层修正方向。
 * 上移：末尾连续 `PROMOTE_MIN_INSTANT_STREAK` 次秒认且期间无任何其他状态。
 * 下移：证据里出现「不认识」或「见过想不起」⇒ 宁严勿松，往难里放。
 * 都不满足 ⇒ 不动。
 */
export function suggestTierFromFeedback(l1States: L1State[], current: Tier): Tier {
  const recent = l1States.slice(-EVIDENCE_TAIL);
  if (recent.length === 0) return current;
  if (recent.includes('unknown') || recent.includes('familiar_but_forgotten')) {
    return Math.min(4, current + 1) as Tier;
  }
  const tail = recent.slice(-PROMOTE_MIN_INSTANT_STREAK);
  const allInstant =
    tail.length === PROMOTE_MIN_INSTANT_STREAK && tail.every((s) => s === 'instant');
  if (allInstant) return Math.max(1, current - 1) as Tier;
  return current;
}

export interface CalibrationWordInput {
  wordId: string;
  currentTier: Tier;
  recentL1: L1State[];
}

export interface CalibrationAssignment {
  wordId: string;
  tier: Tier;
}

/** 产变更清单（仅与当前层不同的词） */
export function buildCalibrationAssignments(words: CalibrationWordInput[]): CalibrationAssignment[] {
  const out: CalibrationAssignment[] = [];
  for (const w of words) {
    const next = suggestTierFromFeedback(w.recentL1, w.currentTier);
    if (next !== w.currentTier) out.push({ wordId: w.wordId, tier: next });
  }
  return out;
}

/** 变更占比是否超过 Confirm 阈值（>10%，PRD §4.3） */
export function exceedsConfirmRatio(changedCount: number, total: number): boolean {
  return total > 0 && changedCount / total > TIER_RECALIBRATION_CONFIRM_RATIO;
}

export interface CalibrationRunResult {
  checked: number;
  changed: number;
  proposalCreated: boolean;
  skipped?: 'window' | 'no-plan' | 'no-data';
}

/**
 * 每日校准执行入口（boot / 打开 App 时调用一次）：
 * 反馈近 N 日 → 按 wordId 聚合 L1 → 对照 book_words 当前层产 assignments → executeTool。
 *
 * ⚠ 与旧版的行为差异（用户 2026-10-13：掌握程度由练习成绩判定）：
 *   旧版 14 天后直接 `skipped: 'window'` —— 掌握程度从此永久冻结。
 *   现在**任何时候都判定**，14 天窗口只保留给 UI 提示；无反馈时才是 'no-data'。
 *   批量变动 >10% 仍由 authz 动态风险升级为 Confirm 提案（等用户在 AI 方案页确认）。
 */
export async function runDailyCalibration(input: {
  userId: string;
  plan: StudyPlan;
  today: string;
}): Promise<CalibrationRunResult> {
  const repos = getRepos();
  const lookbackStart = new Date(Date.now() - CALIBRATION_LOOKBACK_DAYS * 86400000).toISOString();
  const recent: Feedback[] = await repos.feedback.listFeedbacksRange(lookbackStart, new Date().toISOString());
  if (recent.length === 0) {
    return { checked: 0, changed: 0, proposalCreated: false, skipped: 'no-data' };
  }
  const bws = await repos.word.listBookWords(input.plan.bookId);
  const byWord = new Map<string, Feedback[]>();
  for (const f of recent) {
    const list = byWord.get(f.wordId) ?? [];
    list.push(f);
    byWord.set(f.wordId, list);
  }
  const inputs: CalibrationWordInput[] = [];
  for (const bw of bws) {
    const fs = byWord.get(bw.wordId);
    if (!fs || fs.length === 0) continue;
    inputs.push({ wordId: bw.wordId, currentTier: bw.tier, recentL1: fs.map((f) => f.l1State) });
  }
  const assignments = buildCalibrationAssignments(inputs);
  if (assignments.length === 0) {
    return { checked: inputs.length, changed: 0, proposalCreated: false };
  }
  // wordId → bookWordId 映射（recompute_word_tiers 以 bookWordId 定位）
  const idByWord = new Map(bws.map((bw) => [bw.wordId, bw.id]));
  const toolAssignments = assignments
    .filter((a) => idByWord.has(a.wordId))
    .map((a) => ({ bookWordId: idByWord.get(a.wordId) as string, tier: a.tier }));
  const ctx = getToolCtx(input.userId, input.plan.id);
  const decision = await executeTool(
    { ctx },
    {
      toolName: 'recompute_word_tiers',
      input: { bookId: input.plan.bookId, assignments: toolAssignments },
      reason: `前两周每日校准：近 ${CALIBRATION_LOOKBACK_DAYS} 日反馈建议调整 ${toolAssignments.length}/${bws.length} 词层`,
      actor: 'system',
    },
  );
  return {
    checked: inputs.length,
    changed: toolAssignments.length,
    proposalCreated: decision.kind === 'confirm' || decision.kind === 'require',
  };
}
