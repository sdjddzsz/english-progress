/**
 * session.ts —— 摸底断点续做（用户 2026-10-13：不能一退出/一中断就从头再来）。
 *
 * 摸底一次 300 个判定单位，答到一半退出（关页面、刷新、误触导航）后必须能回到**中断的那一条**，
 * 否则等于把已答的几十上百条全部作废 —— 比"凭感觉自评"还自欺欺人。
 *
 * 存本机 localStorage（按 userId + bookId 隔离）。理由：
 * - 这只是未提交的草稿，落云端要建表 + RLS，收益不抵成本；
 * - 提交写库后即清除，不留垃圾；
 * - 同一浏览器同一词书的草稿才有效，换设备重做是合理的。
 */
import type { L1State } from '../../types/domain';
import type { PlacementSenseItem } from './sampling';

const VERSION = 1;

export interface PlacementSession {
  version: number;
  bookId: string;
  /** 首次开始时间（界面上要显示"这是哪一次摸底"） */
  startedAt: string;
  /** 最后一条作答的时间（判断是否过期） */
  updatedAt: string;
  items: PlacementSenseItem[];
  /** 当前停在items 的哪个下标 */
  idx: number;
  /** senseId → 初评（含核对后的最终判定） */
  responses: Record<string, L1State>;
  /** senseId → 是否经核对改判过 */
  selfChecked: Record<string, boolean>;
}

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 隐私模式 / 禁用存储
  }
}

export function sessionKey(userId: string, bookId: string): string {
  return `ep-placement-${userId}-${bookId}`;
}

export function saveSession(userId: string, s: PlacementSession): void {
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(sessionKey(userId, s.bookId), JSON.stringify({ ...s, version: VERSION, updatedAt: new Date().toISOString() }));
  } catch {
    // 配额超限：草稿丢了不影响已提交数据，静默
  }
}

export function loadSession(userId: string, bookId: string): PlacementSession | null {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(sessionKey(userId, bookId));
    if (!raw) return null;
    const p = JSON.parse(raw) as PlacementSession;
    if (p?.version !== VERSION || !Array.isArray(p.items) || p.items.length === 0) return null;
    if (p.bookId !== bookId) return null;
    return p;
  } catch {
    return null;
  }
}

export function clearSession(userId: string, bookId: string): void {
  const ls = storage();
  if (!ls) return;
  try {
    ls.removeItem(sessionKey(userId, bookId));
  } catch {
    // ignore
  }
}

/** 已答条数（界面显示"继续摸底"时用） */
export function answeredCount(s: PlacementSession): number {
  return Object.keys(s.responses ?? {}).length;
}
