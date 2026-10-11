/**
 * writeTools.ts —— 15 个写工具实现。全部经 authz 分发（Auto 直落 / Confirm/Require 走提案），
 * 计划参数类变更自动生成 PlanVersion 快照（可回滚）。
 */
import { applyStrategy } from '../../scheduler';
import type { Hit, StudyPlan, Tier } from '../../types/domain';
import { hitDeterministicId } from '../../data/collections';
import { FALLBACK_TIER_ROUNDS, RECOMMENDED_TIER_ROUNDS } from '../../config/constants';
import { snapshotPlan } from '../planVersion';
import type { ToolContext } from './readTools';

export interface WriteToolResult {
  summary: string;
  data?: unknown;
}

export type WriteToolImpl = (input: Record<string, unknown>, ctx: ToolContext) => Promise<WriteToolResult>;

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}
const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const now = (): string => new Date().toISOString();

async function requirePlan(ctx: ToolContext, planId?: string): Promise<StudyPlan> {
  const id = planId ?? ctx.planId;
  if (!id) throw new Error('no active plan id in tool context');
  const plan = await ctx.repos.plan.getPlan(id);
  if (!plan) throw new Error(`plan ${id} not found`);
  return plan;
}

export const writeToolImpls: Record<string, WriteToolImpl> = {
  update_plan_params: async (input, ctx) => {
    const plan = await requirePlan(ctx, s(input.planId) || undefined);
    const patch = asRecord(input.patch) as Partial<StudyPlan>;
    delete patch.id;
    delete patch.createdAt;
    const updated = await ctx.repos.plan.updatePlan(plan.id, patch);
    if (!updated) throw new Error('update_plan_params affected 0 rows (RLS blocked?)');
    await snapshotPlan(ctx.repos.plan, updated, ctx.actor, s(input.reason, '参数修改'), `patch: ${Object.keys(patch).join(',')}`);
    return { summary: `plan ${plan.id} updated: ${Object.keys(patch).join(',')}`, data: updated };
  },

  reschedule: async (input, ctx) => {
    const plan = await requirePlan(ctx);
    const today = s(input.today, new Date().toISOString().slice(0, 10));
    const strategy = s(input.strategy) as 'extend' | 'compress' | 'drop_round' | 'freeze';
    const overdueHits = await ctx.repos.hit.getOverdueHits(plan.id, today);
    // 稳固信号：近 30 天反馈聚合
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const recentFeedbacks = await ctx.repos.feedback.listFeedbacksRange(since, now());
    const steadyWords = ctx.repos.feedback.aggregateSteadiness(recentFeedbacks);
    const params = {
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
      tierRoundDays: plan.tierRoundDays as never,
      listSize: 50,
    };
    const tierCounts: Partial<Record<Tier, number>> = {};
    const bookWords = await ctx.repos.word.listBookWords(plan.bookId);
    for (const bw of bookWords) tierCounts[bw.tier] = (tierCounts[bw.tier] ?? 0) + 1;
    const deferredIds = Array.isArray(input.deferredIds) ? (input.deferredIds as string[]) : undefined;
    const outcome = applyStrategy(strategy, { params, tierCounts: tierCounts as Record<number, number>, steadyWords }, overdueHits as never, deferredIds, today);
    if (!outcome.ok) throw new Error(outcome.message);
    // 落 mutations：reschedule → 新日期 pending；defer → deferred（原样保留池）
    for (const m of outcome.hitMutations) {
      const patch: Partial<Hit> = { status: m.newStatus };
      if (m.newScheduledDate) patch.scheduledDate = m.newScheduledDate;
      const updated = await ctx.repos.hit.hits.update(m.hitId, patch);
      if (!updated) throw new Error(`reschedule mutation hit 0 rows for ${m.hitId}`);
    }
    // 新计划参数 + 版本快照
    const updatedPlan = await ctx.repos.plan.updatePlan(plan.id, {
      tierRounds: outcome.newPlan.tierRounds,
      tierRoundDays: outcome.newPlan.tierRoundDays as never,
      dailyBudgetMin: outcome.newPlan.dailyBudgetMin,
    });
    if (updatedPlan) {
      await snapshotPlan(ctx.repos.plan, updatedPlan, ctx.actor, s(input.reason, strategy), `重排 ${strategy}：${outcome.hitMutations.length} 条 hit 变更`);
    }
    return {
      summary: `reschedule(${strategy}): ${outcome.hitMutations.length} mutations, finish ${outcome.newFinishDate}`,
      data: { mutations: outcome.hitMutations.length, newFinishDate: outcome.newFinishDate, newDailyHits: outcome.newDailyHits },
    };
  },

  switch_plan_mode: async (input, ctx) => {
    const plan = await requirePlan(ctx, s(input.planId) || undefined);
    const mode = s(input.planMode) as 'recommended' | 'fallback';
    const tierRounds = mode === 'recommended' ? { ...RECOMMENDED_TIER_ROUNDS } : { ...FALLBACK_TIER_ROUNDS };
    const updated = await ctx.repos.plan.updatePlan(plan.id, { planMode: mode, tierRounds });
    if (!updated) throw new Error('switch_plan_mode affected 0 rows');
    await snapshotPlan(ctx.repos.plan, updated, ctx.actor, s(input.reason, mode), `plan_mode → ${mode}`);
    return { summary: `plan mode switched to ${mode}`, data: updated };
  },

  batch_defer_words: async (input, ctx) => {
    const hitIds = Array.isArray(input.hitIds) ? (input.hitIds as string[]) : [];
    let done = 0;
    for (const id of hitIds) {
      const updated = await ctx.repos.hit.setStatus(id, 'deferred');
      if (updated) done += 1;
    }
    return { summary: `deferred ${done}/${hitIds.length} hits（末轮复查一次）`, data: { done } };
  },

  adjust_word_frequency: async (input, ctx) => {
    const plan = await requirePlan(ctx, s(input.planId) || undefined);
    const wordId = s(input.wordId);
    const action = s(input.action) as 'extra_practice' | 'reduce';
    if (action === 'extra_practice') {
      // 加练：本轮再多出现 1 次（明日追加 hit，确定性 ID 天然唯一，计入时间校验）
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const tier = 3 as Tier; // 词层从 bookWords 反查
      const bws = await ctx.repos.word.listBookWords(plan.bookId);
      const bw = bws.find((b) => b.wordId === wordId);
      const t = (bw?.tier ?? tier) as Tier;
      const extra: Hit = {
        id: hitDeterministicId(plan.id, wordId, 1, `${tomorrow}_extra`),
        planId: plan.id,
        wordId,
        userId: ctx.userId,
        tier: t,
        roundNo: 1,
        listNo: bw?.listNo ?? 0,
        scheduledDate: tomorrow,
        modality: 'visual',
        status: 'pending',
        explain: { roundIdxInWindow: 0 },
      };
      await ctx.repos.hit.upsertHits([extra]);
      return { summary: `加练：${wordId} 明日追加 1 次 hit`, data: { hitId: extra.id } };
    }
    // reduce：今日 pending hit 置 deferred（末轮复查）
    const today = new Date().toISOString().slice(0, 10);
    const todayHits = await ctx.repos.hit.getHitsByDate(plan.id, today);
    const target = todayHits.find((h) => h.wordId === wordId && h.status === 'pending');
    if (target) await ctx.repos.hit.setStatus(target.id, 'deferred');
    return { summary: `降频：${wordId} 本轮跳过（${target ? 'deferred' : '无待完成 hit'}）` };
  },

  recompute_word_tiers: async (input, ctx) => {
    const bookId = s(input.bookId);
    const assignments = Array.isArray(input.assignments) ? (input.assignments as { bookWordId: string; tier: Tier }[]) : [];
    let done = 0;
    for (const a of assignments) {
      const updated = await ctx.repos.word.updateWordTier(a.bookWordId, a.tier);
      if (updated) done += 1;
    }
    const total = (await ctx.repos.word.listBookWords(bookId)).length;
    return { summary: `重分层 ${done}/${assignments.length}（总 ${total} 词，${(assignments.length / Math.max(1, total)).toFixed(2)}）`, data: { done } };
  },

  move_words_between_lists: async (input, ctx) => {
    const moves = Array.isArray(input.moves) ? (input.moves as { bookWordId: string; listNo: number; orderInList?: number }[]) : [];
    let done = 0;
    for (const m of moves) {
      const updated = await ctx.repos.word.bookWords.update(m.bookWordId, {
        listNo: m.listNo,
        ...(m.orderInList != null ? { orderInList: m.orderInList } : {}),
      } as never);
      if (updated) done += 1;
    }
    return { summary: `移动 ${done}/${moves.length} 词的 List 归属` };
  },

  update_mock_unlock_rule: async (input, ctx) => {
    const rule = await ctx.repos.config.saveMockRule({
      userId: ctx.userId,
      ruleJson: asRecord(input.ruleJson),
      status: 'draft',
      createdBy: 'ai',
      reason: s(input.reason, 'AI 基于学习数据制定'),
    });
    return { summary: `模考解锁规则草案 ${rule.id}（待用户批准）`, data: rule };
  },

  mark_word_status: async (input, ctx) => {
    const updated = await ctx.repos.word.updateBookWordStatus(s(input.bookWordId), s(input.status) as never);
    if (!updated) throw new Error('mark_word_status affected 0 rows');
    return { summary: `词状态 → ${s(input.status)}`, data: updated };
  },

  create_training_material: async (input, ctx) => {
    const item = await ctx.repos.training.createItem({
      type: s(input.type) as never,
      source: 'ai',
      content: asRecord(input.content),
      targetWords: Array.isArray(input.targetWords) ? (input.targetWords as string[]) : [],
      createdBy: ctx.actor,
    });
    return { summary: `训练素材 ${item.id}（${item.type}，目标词 ${item.targetWords.length}）`, data: item };
  },

  generate_sprint_pack: async (input, ctx) => {
    const item = await ctx.repos.training.createItem({
      type: 'writing',
      source: 'ai',
      content: { ...asRecord(input.content), paperRefs: Array.isArray(input.paperRefs) ? input.paperRefs : [] },
      targetWords: [],
      createdBy: ctx.actor,
    });
    return { summary: `冲刺周作文模板包 ${item.id}（Confirm 级，确认后入日程）`, data: item };
  },

  upsert_pronunciation: async (input, ctx) => {
    const updated = await ctx.repos.word.words.update(s(input.wordId), { ipa: s(input.ipa) } as never);
    if (!updated) throw new Error('upsert_pronunciation affected 0 rows');
    return { summary: `音标已更新`, data: updated };
  },

  resolve_issue: async (input, ctx) => {
    const updated = await ctx.repos.feedback.resolveIssue(s(input.issueId));
    if (!updated) throw new Error('resolve_issue affected 0 rows');
    return { summary: `Issue ${s(input.issueId)} 已处理`, data: updated };
  },

  create_ability_snapshot: async (input, ctx) => {
    const snap = asRecord(input.snapshot);
    const saved = await ctx.repos.config.saveAbilitySnapshot({
      userId: ctx.userId,
      weekStart: s(snap.weekStart, new Date().toISOString().slice(0, 10)),
      wordStatesSummary: asRecord(snap.wordStatesSummary) as never,
      weakPoints: asRecord(snap.weakPoints) as never,
      modalityGap: asRecord(snap.modalityGap) as never,
      tierPassRates: asRecord(snap.tierPassRates) as never,
      createdAt: now(),
    });
    return { summary: `能力画像快照 ${saved.id}（无总分）`, data: saved };
  },

  annotate_word: async (input, ctx) => {
    const wordId = s(input.wordId);
    const sense = s(input.sense);
    const word = await ctx.repos.word.words.getById(wordId);
    if (!word) throw new Error(`word ${wordId} not found`);
    const updated = await ctx.repos.word.words.update(wordId, { senses: [...word.senses, sense] } as never);
    return { summary: `释义已补充`, data: updated };
  },
};

export async function runWriteTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<WriteToolResult> {
  const impl = writeToolImpls[name];
  if (!impl) throw new Error(`Unknown write tool: ${name}`);
  return impl(asRecord(input), ctx);
}
