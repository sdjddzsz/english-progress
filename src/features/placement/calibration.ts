/**
 * calibration.ts —— 前两周每日校准（PRD §4.3 摸底后校准）：
 * 计划开始 14 天内，按近 2 日反馈对词层做增量修正建议；
 * 批量变动 >10% 由 recompute_word_tiers 的动态风险路由为 Confirm 提案（>10% → confirm），
 * ≤10% 自动落地（authz.ts effectiveRiskLevel 已实现，本模块只负责产 assignments 并调用）。
 * 纯函数 + 一个执行入口；不做任何 UI。
 */
import { TIER_RECALIBRATION_CONFIRM_RATIO } from '../../config/constants';
import { diffDays } from '../../scheduler';
import type { Feedback, L1State, StudyPlan, Tier } from '../../types/domain';
import { getRepos, getToolCtx } from '../../store/useAppStore';
import { executeTool } from '../../ai/authz';

export const CALIBRATION_WINDOW_DAYS = 14;
/** 观察窗：近 2 日的反馈参与修正 */
export const CALIBRATION_LOOKBACK_DAYS = 2;

/** 是否处于前两周校准窗口（start 计为第 0 天） */
export function inCalibrationWindow(planStartDate: string, today: string): boolean {
  return diffDays(today, planStartDate) < CALIBRATION_WINDOW_DAYS;
}

/** 单词近 N 次 L1 → 层修正方向：2 次秒认上移一层；出现"不认识"下移一层（宁严勿松） */
export function suggestTierFromFeedback(l1States: L1State[], current: Tier): Tier {
  const recent = l1States.slice(-CALIBRATION_LOOKBACK_DAYS * 4); // 防御性截断
  if (recent.length === 0) return current;
  const instantStreak =
    recent.length >= 2 && recent.slice(-2).every((s) => s === 'instant') ? 1 : 0;
  const downgrade = recent.includes('unknown');
  let tier = current;
  if (downgrade) tier = Math.min(4, current + 1) as Tier;
  else if (instantStreak) tier = Math.max(1, current - 1) as Tier;
  return tier as Tier;
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
 * 反馈近 2 日 → 按 wordId 聚合 L1 → 对照 book_words 当前层产 assignments → executeTool。
 * >10% 时 authz 动态风险自动升级为 Confirm 提案（等用户在 AI 方案页确认）。
 */
export async function runDailyCalibration(input: {
  userId: string;
  plan: StudyPlan;
  today: string;
}): Promise<CalibrationRunResult> {
  if (!inCalibrationWindow(input.plan.startDate, input.today)) {
    return { checked: 0, changed: 0, proposalCreated: false, skipped: 'window' };
  }
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
