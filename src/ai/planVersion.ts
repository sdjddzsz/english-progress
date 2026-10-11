/**
 * planVersion.ts —— PlanVersion 快照 / 回滚（PRD §7.3）：
 * 任何计划参数变更（用户手动改、欠账重排、avg_hit 校准）都生成完整快照；
 * 可回滚到任意版本，回滚本身也记新版本（changed_by=user, reason=rollback）。
 */
import type { PlanVersion, StudyPlan } from '../types/domain';
import type { Repository } from '../data/repository';
import type { PlanRepo } from '../data/repos/planRepo';

export interface PlanVersionDeps {
  plans: Repository<StudyPlan>;
  versions: Repository<PlanVersion>;
}

export function planVersionDeps(planRepo: PlanRepo): PlanVersionDeps {
  return { plans: planRepo.plans, versions: planRepo.versions };
}

/** 写入新版本快照（version_no = 当前最大 + 1）。deps 可传 PlanRepo（含 versions）或显式 deps */
export async function snapshotPlan(
  deps: Pick<PlanRepo, 'versions'>,
  plan: StudyPlan,
  changedBy: 'user' | 'ai' | 'system',
  reason: string,
  diffSummary: string,
): Promise<PlanVersion> {
  const latest = await deps.versions.list([{ column: 'planId', op: 'eq', value: plan.id }], {
    orderBy: 'versionNo',
    ascending: false,
    limit: 1,
  });
  const versionNo = (latest[0]?.versionNo ?? 0) + 1;
  return deps.versions.insert({
    planId: plan.id,
    versionNo,
    snapshot: plan as unknown as Record<string, unknown>,
    changedBy,
    reason,
    diffSummary,
    createdAt: new Date().toISOString(),
  });
}

/** 回滚到任意版本：以快照覆盖计划 + 记录新版本 */
export async function rollbackToVersion(
  deps: PlanVersionDeps,
  planId: string,
  versionNo: number,
  changedBy: 'user' | 'ai' | 'system' = 'user',
): Promise<{ plan: StudyPlan; newVersion: PlanVersion }> {
  const versions = await deps.versions.list([{ column: 'planId', op: 'eq', value: planId }]);
  const target = versions.find((v) => v.versionNo === versionNo);
  if (!target) throw new Error(`plan ${planId} has no version ${versionNo}`);
  const snapshot = { ...(target.snapshot as Record<string, unknown>) };
  delete snapshot.id;
  delete snapshot.createdAt;
  const updated = await deps.plans.update(planId, snapshot as Partial<StudyPlan>);
  if (!updated) {
    throw new Error(`rollback affected 0 rows for plan ${planId} (not found or RLS-blocked)`);
  }
  const newVersion = await snapshotPlan(deps, updated, changedBy, `rollback to v${versionNo}`, '回滚');
  return { plan: updated, newVersion };
}
