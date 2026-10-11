/**
 * authz.ts —— 三级授权执行器（PRD §7.2，架构硬约束）：
 * - Auto（读类 + 低风险写类）：直接落地，写 ToolCallLog；
 * - Confirm：生成 AIProposal（必含 reason+diff），推用户一键确认/驳回；
 * - Require：同 Confirm 但**永不自动执行**（无任何自动放行路径）。
 * 硬约束 #6：提案必含 reason 与 changes(diff)，缺则拒绝落地。
 */
import type { AIProposal, RiskLevel, ToolCallLog } from '../types/domain';
import { getToolSpec } from './tools/catalog';
import { runReadTool, type ToolContext } from './tools/readTools';
import { runWriteTool } from './tools/writeTools';
import { createProposal, MAX_PROPOSAL_REASON_LENGTH } from './proposal';

export interface ToolCallRequest {
  toolName: string;
  input: Record<string, unknown>;
  /** Confirm/Require 级必填（硬约束 #6） */
  reason?: string;
  actor?: 'ai' | 'user' | 'system';
}

export type AuthzDecision =
  | { kind: 'auto'; result: unknown; summary: string }
  | { kind: 'confirm' | 'require'; proposalId: string }
  | { kind: 'rejected'; reason: string };

export interface AuthzDeps {
  ctx: ToolContext;
}

async function logCall(
  deps: AuthzDeps,
  entry: Omit<ToolCallLog, 'id' | 'createdAt'>,
): Promise<void> {
  await deps.ctx.repos.config.logToolCall(entry);
}

/**
 * 动态风险升级：
 * - batch_defer_words：待 defer 数 / 当日+欠账总量 > 20% → Require；
 * - recompute_word_tiers：变更占比 > 10% → Confirm，≤10% → Auto（PRD §7.1）。
 */
export async function effectiveRiskLevel(deps: AuthzDeps, specName: string, baseRisk: RiskLevel, input: Record<string, unknown>): Promise<RiskLevel> {
  if (specName === 'batch_defer_words' && deps.ctx.planId) {
    const hitIds = Array.isArray(input.hitIds) ? (input.hitIds as string[]).length : 0;
    const active = await deps.ctx.repos.hit.hits.list([
      { column: 'planId', op: 'eq', value: deps.ctx.planId },
      { column: 'status', op: 'in', values: ['pending', 'overdue'] },
    ]);
    if (active.length > 0 && hitIds / active.length > 0.2) return 'require';
    return baseRisk;
  }
  if (specName === 'recompute_word_tiers') {
    const assignments = Array.isArray(input.assignments) ? (input.assignments as unknown[]).length : 0;
    const bookId = typeof input.bookId === 'string' ? input.bookId : '';
    if (!bookId) return 'confirm';
    const total = (await deps.ctx.repos.word.listBookWords(bookId)).length;
    if (total > 0 && assignments / total > 0.1) return 'confirm';
    return 'auto';
  }
  return baseRisk;
}

export async function executeTool(deps: AuthzDeps, req: ToolCallRequest): Promise<AuthzDecision> {
  const spec = getToolSpec(req.toolName);
  const actor = req.actor ?? 'ai';
  if (!spec) {
    await logCall(deps, { actor, toolName: req.toolName, input: req.input, output: { error: 'unknown tool' }, applied: false });
    return { kind: 'rejected', reason: `Unknown tool: ${req.toolName}` };
  }

  // 读类：Auto 直落
  if (spec.category === 'read') {
    const output = await runReadTool(spec.name, req.input, deps.ctx);
    await logCall(deps, { actor, toolName: spec.name, input: req.input, output: { result: output }, applied: true });
    return { kind: 'auto', result: output, summary: `read ${spec.name}` };
  }

  // 写类：动态风险
  const risk = await effectiveRiskLevel(deps, spec.name, spec.riskLevel, req.input);
  if (risk === 'auto') {
    // P2-1：auto 写分支同样可能抛错（如下游数据缺失），捕获后结构化拒绝而非异常裸传
    try {
      const out = await runWriteTool(spec.name, req.input, deps.ctx);
      await logCall(deps, { actor, toolName: spec.name, input: req.input, output: { result: out.data ?? out.summary }, applied: true });
      return { kind: 'auto', result: out.data ?? out.summary, summary: out.summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logCall(deps, { actor, toolName: spec.name, input: req.input, output: { error: message }, applied: false });
      return { kind: 'rejected', reason: `tool "${spec.name}" failed: ${message}` };
    }
  }

  // Confirm / Require：必附 reason（硬约束 #6），无理由拒绝落地
  const reason = req.reason?.trim();
  if (!reason) {
    const msg = `proposal rejected: reason is required for ${risk}-level tool "${spec.name}" (PRD §7.6)`;
    await logCall(deps, { actor, toolName: spec.name, input: req.input, output: { error: msg }, applied: false });
    return { kind: 'rejected', reason: msg };
  }

  // P2-3：超长 reason 截断入库——原始超限内容不落地（validateProposal 硬上限 2000），
  // 但仍走提案通道（不静默执行），截断事实记入 ToolCallLog
  const reasonTruncated = reason.length > MAX_PROPOSAL_REASON_LENGTH;
  const storedReason = reasonTruncated ? reason.slice(0, MAX_PROPOSAL_REASON_LENGTH) : reason;

  const proposal = await createProposal(deps.ctx.repos.config.proposals, {
    planId: deps.ctx.planId ?? '',
    proposer: actor,
    changes: { toolName: spec.name, input: req.input },
    reason: storedReason,
    riskLevel: risk,
  });
  await logCall(deps, {
    actor,
    toolName: spec.name,
    input: req.input,
    output: {
      proposalId: proposal.id,
      ...(reasonTruncated ? { reasonTruncated: true, originalReasonLength: reason.length } : {}),
    },
    applied: false,
    proposalId: proposal.id,
  });
  // Require 永不自动执行：此处仅创建提案，无任何自动放行分支
  return { kind: risk, proposalId: proposal.id };
}

/** 用户对提案确认/驳回（AI 方案页 / Require 级唯一放行通道） */
export async function decideProposal(deps: AuthzDeps, proposalId: string, approve: boolean): Promise<AuthzDecision> {
  const p = await deps.ctx.repos.config.proposals.getById(proposalId);
  if (!p) return { kind: 'rejected', reason: 'proposal not found' };
  if (p.status !== 'pending') return { kind: 'rejected', reason: `proposal already ${p.status}` };

  if (!approve) {
    await deps.ctx.repos.config.proposals.update(proposalId, { status: 'rejected', decidedAt: new Date().toISOString() });
    await logCall(deps, { actor: 'user', toolName: 'decide_proposal', input: { proposalId, approve: false }, output: { rejected: true }, applied: false, proposalId });
    return { kind: 'rejected', reason: 'rejected by user' };
  }

  const changes = p.changes as { toolName?: string; input?: Record<string, unknown> };
  const toolName = changes.toolName ?? '';
  // P2-1：执行失败（如下游抛错）→ 提案标记 failed（终态，不可重试），异常不裸传
  try {
    const out = await runWriteTool(toolName, changes.input ?? {}, deps.ctx);
    await deps.ctx.repos.config.proposals.update(proposalId, { status: 'applied', decidedAt: new Date().toISOString() });
    await logCall(deps, { actor: 'user', toolName, input: changes.input ?? {}, output: { result: out.data ?? out.summary }, applied: true, proposalId });
    return { kind: 'auto', result: out.data ?? out.summary, summary: out.summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.ctx.repos.config.proposals.update(proposalId, { status: 'failed', decidedAt: new Date().toISOString() });
    await logCall(deps, { actor: 'user', toolName, input: changes.input ?? {}, output: { error: message }, applied: false, proposalId });
    return { kind: 'rejected', reason: `proposal execution failed: ${message}` };
  }
}

export type { AIProposal };
