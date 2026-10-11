/**
 * queue.ts —— 写操作统一入口（在线直写云 + 本地镜像；离线入 pending_ops）。
 * 补传幂等：写操作带 op_id；hit 文档以确定性 ID 去重（last-write-win）。
 * sync.ts（T05）恢复联网后按序 takePendingOps → 重放 → resolveOp。
 */
import { localDb, makeOpId, type PendingOp, type PendingOpName } from './localDb';

/** 网络状态（SSR/测试环境无 navigator 时视为在线） */
export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** 入队离线写操作（opId 唯一，重复 put 幂等） */
export async function enqueueOp(
  name: PendingOpName,
  payload: Record<string, unknown>,
  lastError?: string,
  opId?: string,
): Promise<PendingOp> {
  const op: PendingOp = {
    opId: opId ?? makeOpId(),
    name,
    payload,
    createdAt: new Date().toISOString(),
    retries: 0,
    ...(lastError ? { lastError } : {}),
  };
  await localDb.pendingOps.put(op);
  return op;
}

/**
 * 在线则立即执行 run()；失败或离线则入 pending_ops。
 * 返回 'ran'（已直写云）或 'queued'（待补传）。
 */
export async function runOrQueue(
  name: PendingOpName,
  payload: Record<string, unknown>,
  run: () => Promise<void>,
): Promise<'ran' | 'queued'> {
  if (isOnline()) {
    try {
      await run();
      return 'ran';
    } catch (err) {
      // 直写失败（网络抖动/RLS）→ 入队待补传，不阻断学习
      await enqueueOp(name, payload, err instanceof Error ? err.message : String(err));
      return 'queued';
    }
  }
  await enqueueOp(name, payload);
  return 'queued';
}

/** 按创建顺序取待补传操作 */
export async function takePendingOps(limit = 100): Promise<PendingOp[]> {
  return localDb.pendingOps.orderBy('createdAt').limit(limit).toArray();
}

/** 补传成功后移除 */
export async function resolveOp(opId: string): Promise<void> {
  await localDb.pendingOps.delete(opId);
}

/** 补传失败：重试计数 +1 并记录错误（留在队列下次再试） */
export async function failOp(op: PendingOp, error: unknown): Promise<void> {
  await localDb.pendingOps.put({
    ...op,
    retries: op.retries + 1,
    lastError: error instanceof Error ? error.message : String(error),
  });
}
