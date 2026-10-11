/**
 * useFeedback.ts —— 反馈提交与会话生命周期 Hook：
 * 每 hit 一条 Feedback（L1/L2/L3 + 反应时长）；L3 发音/内容存疑自动建 Issue；
 * 混淆词自动聚合 ConfusionPair；会话结束写 StudySession + SessionSummary。
 * 硬约束 #1 边界：本 Hook 只落库与聚合，不产出任何分数类指标。
 */
import { useCallback } from 'react';
import type { Hit, L1State, L2Tag, L3Action, SessionType } from '../types/domain';
import { getRepos, useAppStore } from '../store/useAppStore';
import { useSettingsStore } from '../store/useSettingsStore';

export interface FeedbackSubmitInput {
  l1State: L1State;
  l2Tags?: L2Tag[];
  confusionWordId?: string;
  l3Actions?: L3Action[];
  note?: string;
}

function emptyL1(): Record<L1State, number> {
  return { instant: 0, recognized: 0, familiar_but_forgotten: 0, unknown: 0 };
}

export function useFeedback() {
  const submit = useCallback(async (hit: Hit, sessionId: string, input: FeedbackSubmitInput, reactionMs: number) => {
    const userId = useAppStore.getState().userId;
    if (!userId) throw new Error('not signed in: bootstrap the app store first');
    const repos = getRepos();
    const device = useSettingsStore.getState().device;
    await repos.feedback.createFeedback({
      hitId: hit.id,
      sessionId,
      wordId: hit.wordId,
      userId,
      l1State: input.l1State,
      reactionMs: Math.max(0, Math.round(reactionMs)),
      l2Tags: input.l2Tags ?? [],
      ...(input.confusionWordId ? { confusionWordId: input.confusionWordId } : {}),
      l3Actions: input.l3Actions ?? [],
      ...(input.note ? { note: input.note } : {}),
      modality: hit.modality,
      roundNo: hit.roundNo,
      tier: hit.tier,
      device,
    });
    // 混淆词 → ConfusionPair（无序化聚合在 repo 内）
    if (input.confusionWordId) {
      await repos.feedback.upsertConfusionPair(userId, hit.wordId, input.confusionWordId);
    }
    // L3 处置 → Issue（发音存疑/发音错误/释义存疑）
    for (const action of input.l3Actions ?? []) {
      if (action === 'pronunciation_doubt') {
        await repos.feedback.createIssue(hit.wordId, userId, 'pronunciation', input.note);
      } else if (action === 'pronunciation_error') {
        await repos.feedback.createIssue(hit.wordId, userId, 'pronunciation', `发音错误：${input.note ?? ''}`);
      } else if (action === 'content_doubt') {
        await repos.feedback.createIssue(hit.wordId, userId, 'definition', input.note);
      }
    }
  }, []);

  const startSession = useCallback(async (type: SessionType): Promise<string> => {
    const userId = useAppStore.getState().userId;
    if (!userId) throw new Error('not signed in: bootstrap the app store first');
    const session = await getRepos().feedback.startSession({
      userId,
      type,
      startedAt: new Date().toISOString(),
      device: useSettingsStore.getState().device,
      hitCount: 0,
    });
    return session.id;
  }, []);

  /** 会话收尾：endSession + SessionSummary（L1/L2/模态分布；无任何分数字段） */
  const finishSession = useCallback(async (sessionId: string, hitCount: number): Promise<void> => {
    const repos = getRepos();
    await repos.feedback.endSession(sessionId, new Date().toISOString(), hitCount);
    const rows = await repos.feedback.listFeedbacksBySession(sessionId);
    const l1Distribution = emptyL1();
    const l2Count = new Map<L2Tag, number>();
    const modalityDistribution = { visual: 0, audio: 0 };
    let reactionSum = 0;
    let confusionCount = 0;
    for (const f of rows) {
      l1Distribution[f.l1State] += 1;
      for (const t of f.l2Tags) l2Count.set(t, (l2Count.get(t) ?? 0) + 1);
      modalityDistribution[f.modality] += 1;
      reactionSum += f.reactionMs;
      if (f.confusionWordId) confusionCount += 1;
    }
    const l2Top = [...l2Count.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag, count]) => ({ tag, count }));
    await repos.feedback.saveSessionSummary({
      sessionId,
      hitCount: rows.length,
      l1Distribution,
      l2Top,
      newConfusionPairs: confusionCount,
      newIssues: 0,
      avgReactionMs: rows.length ? Math.round(reactionSum / rows.length) : 0,
      modalityDistribution,
      createdAt: new Date().toISOString(),
    });
  }, []);

  return { submit, startSession, finishSession };
}
