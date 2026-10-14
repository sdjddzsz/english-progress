/**
 * proposal.ts —— AI 提案（硬约束 #6：必含 reason 与 changes(diff)，缺则拒绝落地）+ 采纳率统计。
 */
import type { AIProposal, RiskLevel } from '../types/domain';
import type { Repository } from '../data/repository';

export class ProposalValidationError extends Error {}

/** P2-3：reason 长度上限（超限拒收，防超长 payload 撑爆提案存储 / UI） */
export const MAX_PROPOSAL_REASON_LENGTH = 2000;

export function validateProposal(input: { reason?: string; changes?: unknown }): void {
  const reason = input.reason?.trim();
  if (!reason) {
    throw new ProposalValidationError('proposal rejected: reason is required (PRD §7.6 — 无理由提案拒绝落地)');
  }
  if (reason.length > MAX_PROPOSAL_REASON_LENGTH) {
    throw new ProposalValidationError(
      `proposal rejected: reason exceeds maximum length of ${MAX_PROPOSAL_REASON_LENGTH} characters (got ${reason.length})`,
    );
  }
  if (
    input.changes == null ||
    (typeof input.changes === 'object' && !Array.isArray(input.changes) && Object.keys(input.changes).length === 0)
  ) {
    throw new ProposalValidationError('proposal rejected: changes(diff) is required');
  }
}

export async function createProposal(
  proposals: Repository<AIProposal>,
  input: {
    planId: string;
    proposer: AIProposal['proposer'];
    changes: Record<string, unknown>;
    reason: string;
    riskLevel: RiskLevel;
  },
): Promise<AIProposal> {
  validateProposal(input);
  return proposals.insert({
    planId: input.planId,
    proposer: input.proposer,
    changes: input.changes,
    reason: input.reason,
    riskLevel: input.riskLevel,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
}

export interface ProposalStats {
  total: number;
  pending: number;
  applied: number;
  rejected: number;
  adoptionRate: number;
  rejectionRate: number;
}

/** AI 有效性面板：提案采纳率 / 驳回率（PRD §7.6 防"形式主义"） */
export async function proposalStats(proposals: Repository<AIProposal>, planId: string): Promise<ProposalStats> {
  const rows = await proposals.listAll([{ column: 'planId', op: 'eq', value: planId }]);
  const pending = rows.filter((r) => r.status === 'pending').length;
  const applied = rows.filter((r) => r.status === 'applied' || r.status === 'approved').length;
  const rejected = rows.filter((r) => r.status === 'rejected').length;
  const decided = applied + rejected;
  return {
    total: rows.length,
    pending,
    applied,
    rejected,
    adoptionRate: decided ? applied / decided : 0,
    rejectionRate: decided ? rejected / decided : 0,
  };
}
