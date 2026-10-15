/**
 * syncManager.ts —— 离线补传执行器（T05，架构 §1.7 / S30）：
 * takePendingOps（按 createdAt 顺序）→ 按操作名分发到对应仓库写路径 → 成功 resolveOp / 失败 failOp。
 * 幂等保障：op 重复重放无副作用（hit 确定性 ID upsert 去重；update 天然幂等）。
 * useOfflineSync（UI hook）包装本模块：在线事件自动重放 + 手动补传按钮。
 */
import type { Hit, HitStatus } from '../types/domain';
import { takePendingOps, resolveOp, failOp, isOnline } from '../data/queue';
import type { PendingOp, PendingOpName } from '../data/localDb';
import type { Repos } from '../store/useAppStore';

export interface ReplayResult {
  done: number;
  failed: number;
  /** 全部成功时 true（UI 可提示"已同步"） */
  drained: boolean;
}

type OpHandler = (payload: Record<string, unknown>, repos: Repos) => Promise<void>;

const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d);

/** 操作名 → 写路径（绕过 runOrQueue：重放时已确认在线，直写；失败由 failOp 记账重试） */
const HANDLERS: Record<PendingOpName, OpHandler> = {
  'hit.complete': async (payload, repos) => {
    const hitId = s(payload.hitId);
    const updated = await repos.hit.hits.update(hitId, { status: 'done', completedAt: s(payload.completedAt) } as Partial<Hit>);
    if (!updated) throw new Error(`hit.complete affected 0 rows for ${hitId}`);
  },
  'hit.status': async (payload, repos) => {
    const updated = await repos.hit.hits.update(s(payload.hitId), { status: s(payload.status) as HitStatus } as Partial<Hit>);
    if (!updated) throw new Error(`hit.status affected 0 rows for ${s(payload.hitId)}`);
  },
  'hit.upsert': async (payload, repos) => {
    const rows = Array.isArray(payload.hits) ? (payload.hits as Hit[]) : [];
    await repos.hit.hits.upsertMany(rows as unknown as (Hit & Record<string, unknown>)[]);
  },
  'feedback.create': async (payload, repos) => {
    await repos.feedback.feedbacks.insert(payload as never);
  },
  'session.create': async (payload, repos) => {
    await repos.feedback.sessions.insert(payload as never);
  },
  'session.end': async (payload, repos) => {
    const updated = await repos.feedback.sessions.update(s(payload.sessionId), {
      endedAt: s(payload.endedAt),
      hitCount: num(payload.hitCount),
    } as never);
    if (!updated) throw new Error(`session.end affected 0 rows for ${s(payload.sessionId)}`);
  },
  'summary.create': async (payload, repos) => {
    await repos.feedback.summaries.insert(payload as never);
  },
  'confusion.upsert': async (payload, repos) => {
    await repos.feedback.upsertConfusionPair(s(payload.userId), s(payload.wordA), s(payload.wordB));
  },
  'issue.create': async (payload, repos) => {
    await repos.feedback.createIssue(s(payload.wordId), s(payload.userId), s(payload.type) as never, payload.note ? s(payload.note) : undefined);
  },
  'pronunciation.log': async (payload, repos) => {
    await repos.feedback.logPronunciation(payload as never);
  },
  // 考查制单题结果（2026-10-15：直写云端缺列 PGRST204 / 断网时入队，补传重放）
  'bookWord.quiz': async (payload, repos) => {
    const bookWordId = s(payload.bookWordId);
    const patch = (payload.patch ?? {}) as Record<string, unknown>;
    const updated = await repos.word.updateBookWordQuiz(bookWordId, patch as never);
    if (!updated) throw new Error(`bookWord.quiz affected 0 rows for ${bookWordId}`);
  },
};

export { isOnline };

/**
 * 重放待补传队列。isOnline=false 时直接返回（UI 不必调用）。
 * 单条失败不阻断后续（failOp 记 retries/lastError，下次再试）。
 */
export async function replayPendingOps(repos: Repos, limit = 100): Promise<ReplayResult> {
  if (!isOnline()) return { done: 0, failed: 0, drained: false };
  const ops = await takePendingOps(limit);
  let done = 0;
  let failed = 0;
  for (const op of ops) {
    const handler = HANDLERS[op.name];
    if (!handler) {
      // 未知操作名：视为毒丸，直接移除避免永久阻塞队列
      await resolveOp(op.opId);
      failed += 1;
      continue;
    }
    try {
      await handler(op.payload, repos);
      await resolveOp(op.opId);
      done += 1;
    } catch (err) {
      await failOp(op as PendingOp, err);
      failed += 1;
    }
  }
  return { done, failed, drained: done + failed >= ops.length && failed === 0 && ops.length < limit };
}

/** 当前待补传条数（UI 徽标用） */
export async function countPendingOps(): Promise<number> {
  return (await takePendingOps(1000)).length;
}
