/**
 * planRepo.ts —— study_plans / plan_rounds / plan_versions 读写。
 * 任何计划参数变更（用户手动改、欠账重排、avg_hit 校准）都必须生成 PlanVersion 快照。
 */
import type { PlanRound, PlanVersion, StudyPlan } from '../../types/domain';
import { getDb } from '../cloud';
import { Repository, type CloudDatabaseLike } from '../repository';

export interface PlanRepo {
  readonly plans: Repository<StudyPlan>;
  readonly rounds: Repository<PlanRound>;
  readonly versions: Repository<PlanVersion>;

  createPlan(plan: Omit<StudyPlan, 'id'> & { id?: string }): Promise<StudyPlan>;
  getPlan(id: string): Promise<StudyPlan | null>;
  getActivePlan(bookId: string): Promise<StudyPlan | null>;
  listPlans(bookId: string): Promise<StudyPlan[]>;
  updatePlan(id: string, patch: Partial<StudyPlan>): Promise<StudyPlan | null>;

  replaceRounds(planId: string, rounds: (Omit<PlanRound, 'id'> & { id?: string })[]): Promise<void>;
  listRounds(planId: string): Promise<PlanRound[]>;

  savePlanVersion(version: Omit<PlanVersion, 'id'> & { id?: string }): Promise<PlanVersion>;
  listPlanVersions(planId: string): Promise<PlanVersion[]>;
}

export function createPlanRepo(db: CloudDatabaseLike = getDb()): PlanRepo {
  const plans = new Repository<StudyPlan>(db, 'study_plans');
  const rounds = new Repository<PlanRound>(db, 'plan_rounds');
  const versions = new Repository<PlanVersion>(db, 'plan_versions');

  return {
    plans,
    rounds,
    versions,

    createPlan: (plan) => plans.insert(plan),
    getPlan: (id) => plans.getById(id),
    getActivePlan: async (bookId) => {
      const rows = await plans.list(
        [
          { column: 'bookId', op: 'eq', value: bookId },
          { column: 'status', op: 'in', values: ['active', 'maintenance'] },
        ],
        { orderBy: 'createdAt', ascending: false, limit: 1 },
      );
      return rows[0] ?? null;
    },
    listPlans: (bookId) => plans.listAll([{ column: 'bookId', op: 'eq', value: bookId }]),

    updatePlan: (id, patch) => plans.update(id, patch),

    replaceRounds: async (planId, next) => {
      const old = await rounds.list([{ column: 'planId', op: 'eq', value: planId }]);
      for (const r of old) await rounds.remove(r.id);
      await rounds.insertMany(next.map((r) => ({ ...r, planId })));
    },
    listRounds: (planId) =>
      rounds.listAll([{ column: 'planId', op: 'eq', value: planId }], { orderBy: 'roundNo', ascending: true }),

    savePlanVersion: (version) => versions.insert(version),
    listPlanVersions: (planId) =>
      versions.listAll([{ column: 'planId', op: 'eq', value: planId }], { orderBy: 'versionNo', ascending: false }),
  };
}
