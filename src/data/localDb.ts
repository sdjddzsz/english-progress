/**
 * localDb.ts —— Dexie（IndexedDB）本地镜像（架构文档 §1.4 / §1.7）。
 * - hitsToday：当日队列镜像（日期切换时预拉，离线可刷词）
 * - pendingOps：离线写操作队列（op_id 幂等；补传顺序按 createdAt）
 * - audioMeta：音频缓存索引（T05 预合成时写）
 */
import Dexie, { type Table } from 'dexie';
import type { Hit } from '../types/domain';

export type PendingOpName =
  | 'hit.complete'
  | 'hit.status'
  | 'hit.upsert'
  | 'feedback.create'
  | 'session.create'
  | 'session.end'
  | 'summary.create'
  | 'confusion.upsert'
  | 'issue.create'
  | 'pronunciation.log'
  | 'bookWord.quiz';

export interface PendingOp {
  /** 幂等键（uuid）；重复补传同 op 无副作用 */
  opId: string;
  name: PendingOpName;
  payload: Record<string, unknown>;
  createdAt: string;
  retries: number;
  lastError?: string;
}

export interface AudioMeta {
  key: string; // `${wordId}|${mode}|${voice}`
  wordId: string;
  mode: string;
  sizeBytes: number;
  cachedAt: string;
}

export class EnglishProgressDb extends Dexie {
  hitsToday!: Table<Hit, string>;
  pendingOps!: Table<PendingOp, string>;
  audioMeta!: Table<AudioMeta, string>;

  constructor() {
    super('english_progress_local');
    this.version(1).stores({
      hitsToday: 'id, planId, scheduledDate, status, tier, roundNo',
      pendingOps: 'opId, createdAt',
      audioMeta: 'key, wordId',
    });
  }
}

export const localDb = new EnglishProgressDb();

/** 幂等操作 ID（crypto.randomUUID 不可用时降级） */
export function makeOpId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
