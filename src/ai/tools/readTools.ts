/**
 * readTools.ts —— 10 个只读工具实现（走 repos 只读，Auto 直落）。
 */
import { computeOverdue, validatePlan } from '../../scheduler';
import type { Tier } from '../../types/domain';
import type { WordRepo } from '../../data/repos/wordRepo';
import type { PlanRepo } from '../../data/repos/planRepo';
import type { HitRepo } from '../../data/repos/hitRepo';
import type { FeedbackRepo } from '../../data/repos/feedbackRepo';
import type { ConfigRepo } from '../../data/repos/configRepo';
import type { TrainingRepo } from '../../data/repos/trainingRepo';

export interface ToolContext {
  userId: string;
  repos: {
    word: WordRepo;
    plan: PlanRepo;
    hit: HitRepo;
    feedback: FeedbackRepo;
    config: ConfigRepo;
    training: TrainingRepo;
  };
  actor: 'ai' | 'user' | 'system';
  /** 当前生效计划 id（欠账/重排类工具用） */
  planId?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const n = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d);

export type ReadToolImpl = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export const readToolImpls: Record<string, ReadToolImpl> = {
  get_study_records: async (input, ctx) => {
    const planId = s(input.planId, ctx.planId ?? '');
    return ctx.repos.hit.getHitsRange(planId, s(input.fromDate, '2000-01-01'), s(input.toDate, '2999-12-31'));
  },

  get_feedback_stats: async (input, ctx) => {
    const rows = await ctx.repos.feedback.listFeedbacksRange(s(input.fromIso, '2000-01-01'), s(input.toIso, '2999-12-31'));
    const l1: Record<string, number> = {};
    const l2: Record<string, number> = {};
    const modality: Record<string, number> = {};
    let totalReactionMs = 0;
    for (const f of rows) {
      l1[f.l1State] = (l1[f.l1State] ?? 0) + 1;
      modality[f.modality] = (modality[f.modality] ?? 0) + 1;
      totalReactionMs += f.reactionMs;
      for (const t of f.l2Tags) l2[t] = (l2[t] ?? 0) + 1;
    }
    return { count: rows.length, l1, l2, modality, avgReactionMs: rows.length ? Math.round(totalReactionMs / rows.length) : 0 };
  },

  get_overdue_stats: async (input, ctx) => {
    const today = s(input.today, new Date().toISOString().slice(0, 10));
    const planId = s(input.planId, ctx.planId ?? '');
    const plan = await ctx.repos.plan.getPlan(planId);
    const overdueHits = await ctx.repos.hit.getOverdueHits(planId, today);
    const dailyHits = plan
      ? validatePlan({ params: planToParams(plan), tierCounts: {}, steadyWords: [] }).dailyHits
      : 0;
    return computeOverdue(overdueHits, today, dailyHits);
  },

  get_word_stats: async (input, ctx) => {
    const wordIds = Array.isArray(input.wordIds) ? (input.wordIds as string[]) : [];
    const fromIso = s(input.fromIso, '2000-01-01');
    const rows = await ctx.repos.feedback.listFeedbacksRange(fromIso, '2999-12-31');
    const out: Record<string, { visual: Record<string, number>; audio: Record<string, number>; total: number }> = {};
    for (const f of rows) {
      if (wordIds.length > 0 && !wordIds.includes(f.wordId)) continue;
      const slot = out[f.wordId] ?? { visual: {}, audio: {}, total: 0 };
      const bucket = f.modality === 'audio' ? slot.audio : slot.visual;
      bucket[f.l1State] = (bucket[f.l1State] ?? 0) + 1;
      slot.total += 1;
      out[f.wordId] = slot;
    }
    return out;
  },

  get_book_progress: async (input, ctx) => {
    const bookId = s(input.bookId);
    const bookWords = await ctx.repos.word.listBookWords(bookId);
    const byTier: Record<string, number> = {};
    for (const bw of bookWords) byTier[bw.tier] = (byTier[bw.tier] ?? 0) + 1;
    const plan = await ctx.repos.plan.getActivePlan(bookId);
    const rounds = plan ? await ctx.repos.plan.listRounds(plan.id) : [];
    return { bookId, wordCount: bookWords.length, byTier, planId: plan?.id ?? null, rounds };
  },

  get_training_records: async (input, ctx) => {
    const sessionId = s(input.sessionId);
    if (sessionId) return ctx.repos.training.listRecordsBySession(sessionId);
    return ctx.repos.training.records.list([], { orderBy: 'createdAt', ascending: false, limit: n(input.limit, 50) });
  },

  get_pronunciation_issues: async (_input, ctx) => {
    const issues = await ctx.repos.feedback.listIssues(ctx.userId, 'open');
    const pronunciation = issues.filter((i) => i.type === 'pronunciation');
    const logs = await ctx.repos.feedback.pronunciationLogs.list([], { orderBy: 'createdAt', ascending: false, limit: 100 });
    const fallbacks = logs.filter((l) => l.fallbackUsed).length;
    return { openPronunciationIssues: pronunciation, recentLogCount: logs.length, fallbackRate: logs.length ? fallbacks / logs.length : 0 };
  },

  get_tts_provider_status: async (_input, ctx) => ctx.repos.config.getTTSConfig(ctx.userId),

  get_ability_snapshot: async (_input, ctx) => {
    const rows = await ctx.repos.config.listAbilitySnapshots(ctx.userId);
    return rows[0] ?? null;
  },

  query_words: async (input, ctx) => {
    const bookId = s(input.bookId);
    const tier = input.tier != null ? (n(input.tier) as Tier) : undefined;
    const status = input.status != null ? (s(input.status) as never) : undefined;
    const bookWords = await ctx.repos.word.listBookWords(bookId, { tier, status });
    const limited = bookWords.slice(0, n(input.limit, 50));
    const words = await ctx.repos.word.listWordsByIds(limited.map((bw) => bw.wordId));
    const wordMap = new Map(words.map((w) => [w.id, w]));
    return limited.map((bw) => ({ ...bw, word: wordMap.get(bw.wordId) ?? null }));
  },
};

export async function runReadTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const impl = readToolImpls[name];
  if (!impl) throw new Error(`Unknown read tool: ${name}`);
  return impl(asRecord(input), ctx);
}

/** StudyPlan → 调度 PlanParams（校验用；listSize 缺省 50，词书级配置） */
export function planToParams(plan: {
  tierRounds: Record<Tier, number>;
  planMode: 'recommended' | 'fallback';
  startDate: string;
  deadlineDate: string;
  sprintStartDate: string;
  dailyBudgetMin: number;
  avgHitSec: number;
  gapMinDays: number;
  modalRatio: Record<Tier, number>;
  masteryDecayEnabled: boolean;
  tierRoundDays?: Record<string, number[]>;
  listSize?: number;
}): import('../../scheduler/types').PlanParams {
  return {
    tierRounds: plan.tierRounds,
    planMode: plan.planMode,
    startDate: plan.startDate,
    deadlineDate: plan.deadlineDate,
    sprintStartDate: plan.sprintStartDate,
    dailyBudgetMin: plan.dailyBudgetMin,
    avgHitSec: plan.avgHitSec,
    gapMinDays: plan.gapMinDays,
    modalRatio: plan.modalRatio,
    masteryDecayEnabled: plan.masteryDecayEnabled,
    tierRoundDays: plan.tierRoundDays,
    listSize: plan.listSize ?? 50,
  };
}
