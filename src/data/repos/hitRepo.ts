/**
 * hitRepo.ts —— hits 批量写入 / 当日查询 / 状态迁移 / 幂等 upsert + Dexie 本地镜像。
 * hit 确定性 ID（{planId}_{wordId}_{roundNo}_{scheduledDate}）保证：
 * - 离线补传幂等；- 跨端并发写 last-write-win 去重。
 */
import type { Hit, HitStatus } from '../../types/domain';
import { getDb } from '../cloud';
import { hitDeterministicId } from '../collections';
import { localDb } from '../localDb';
import { enqueueOp, runOrQueue } from '../queue';
import { Repository, type CloudDatabaseLike } from '../repository';

export interface HitRepo {
  readonly hits: Repository<Hit>;
  /** 组装确定性 ID（导出给调度器调用方使用） */
  deterministicId(planId: string, wordId: string, roundNo: number, scheduledDate: string): string;
  /** 批量幂等 upsert（写云端 + 当日镜像） */
  upsertHits(hits: Hit[]): Promise<void>;
  getHit(id: string): Promise<Hit | null>;
  getHitsByDate(planId: string, date: string): Promise<Hit[]>;
  getHitsRange(planId: string, fromDate: string, toDate: string): Promise<Hit[]>;
  /** 欠账池：status ∈ {pending, overdue} 且 scheduled_date < beforeDate */
  getOverdueHits(planId: string, beforeDate: string): Promise<Hit[]>;
  /** 完成 hit：status=done + completedAt（在线直写，失败入队补传） */
  completeHit(hitId: string, completedAt: string): Promise<'ran' | 'queued'>;
  setStatus(hitId: string, status: HitStatus): Promise<Hit | null>;

  // ===== 本地镜像 / 离线队列（T05 sync 复用）=====
  mirrorToday(hits: Hit[]): Promise<void>;
  readTodayMirror(): Promise<Hit[]>;
  clearTodayMirror(): Promise<void>;
  enqueueRawOp(name: Parameters<typeof enqueueOp>[0], payload: Record<string, unknown>): Promise<void>;
}

export function createHitRepo(db: CloudDatabaseLike = getDb()): HitRepo {
  const hits = new Repository<Hit>(db, 'hits');

  return {
    hits,
    deterministicId: hitDeterministicId,

    upsertHits: async (rows) => {
      if (rows.length === 0) return;
      await hits.upsertMany(rows as unknown as (Hit & Record<string, unknown>)[]);
      // 写入当日镜像（只镜像今天及以后，历史不镜像）
      const today = new Date().toISOString().slice(0, 10);
      const todayRows = rows.filter((h) => h.scheduledDate >= today);
      if (todayRows.length > 0) await localDb.hitsToday.bulkPut(todayRows);
    },

    getHit: (id) => hits.getById(id),

    // ⚠ listAll：服务端 max-rows 默认 1000。当日队列 + 欠账计算都读这里，
    //   截断会让「已完成/欠账」判断失真（用户看到队列突然变短）。
    getHitsByDate: (planId, date) =>
      hits.listAll(
        [
          { column: 'planId', op: 'eq', value: planId },
          { column: 'scheduledDate', op: 'eq', value: date },
        ],
        { orderBy: 'tier', ascending: true },
      ),

    getHitsRange: (planId, fromDate, toDate) =>
      hits.listAll([
        { column: 'planId', op: 'eq', value: planId },
        { column: 'scheduledDate', op: 'gte', value: fromDate },
        { column: 'scheduledDate', op: 'lte', value: toDate },
      ]),

    getOverdueHits: (planId, beforeDate) =>
      hits.listAll([
        { column: 'planId', op: 'eq', value: planId },
        { column: 'status', op: 'in', values: ['pending', 'overdue'] },
        { column: 'scheduledDate', op: 'lt', value: beforeDate },
      ]),

    completeHit: (hitId, completedAt) =>
      runOrQueue('hit.complete', { hitId, completedAt }, async () => {
        const updated = await hits.update(hitId, { status: 'done', completedAt } as Partial<Hit>);
        if (!updated) {
          throw new Error(`[hits] completeHit affected 0 rows for ${hitId} (not found or RLS-blocked)`);
        }
        // 同步本地镜像状态
        const mirrored = await localDb.hitsToday.get(hitId);
        if (mirrored) await localDb.hitsToday.put({ ...mirrored, status: 'done', completedAt });
      }),

    setStatus: (hitId, status) => hits.update(hitId, { status } as Partial<Hit>),

    mirrorToday: async (rows) => {
      await localDb.hitsToday.clear();
      if (rows.length > 0) await localDb.hitsToday.bulkPut(rows);
    },
    readTodayMirror: () => localDb.hitsToday.toArray(),
    clearTodayMirror: () => localDb.hitsToday.clear(),
    enqueueRawOp: async (name, payload) => {
      await enqueueOp(name, payload);
    },
  };
}
