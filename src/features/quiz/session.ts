/**
 * session.ts —— 考查会话快照（用户 2026-10-15：答题中途退出重进，必须回到原进度，
 * 而不是把答过的词放过去、又从池子头部另起一轮）。
 *
 * 存储：localStorage（同步、关页面不丢）。key 按用户+词书隔离；**同一天有效，隔天作废**
 * （每日队列本来就该隔天重排）。词书重建后 bookWordId 消失的条目恢复时自动过滤。
 *
 * 纯模块、零 React 依赖；QuizPage 在 start（读）与 items/idx 变化（写）时调用。
 */
import type { BookWord, Word } from '../../types/domain';
import type { DistractorCandidate } from './distractors';
import type { QuizVerdict } from './judging';

/** 可序列化的单题快照（QuizItem 的存储形态：bookWord/word 由 id 引用，恢复时回查） */
export interface QuizItemSnapshot {
  bookWordId: string;
  wordId: string;
  senseIndex: number;
  /** 本轮内第几次作答该词（恢复后继续按原计数放行，用户 2026-10-17 首答规则依赖它） */
  attemptNo?: number;
  /** 已放行/已晋级标记（进度显示用，恢复后原样回显） */
  released?: boolean;
  promoted?: boolean;
  options?: DistractorCandidate[];
  correctKey?: string;
  verdict?: QuizVerdict;
  pickedKey?: string;
  askedAt?: number;
}

export interface QuizSessionSnapshot {
  /** 快照创建日期（UTC YYYY-MM-DD）；隔天失效 */
  date: string;
  items: QuizItemSnapshot[];
  idx: number;
  stats: { skilled: number; graduated: number; special: number; dayPassed: number; total: number };
  todayLeft: number;
}

const keyOf = (userId: string, bookId: string): string => `ep-quiz-session:${userId}:${bookId}`;

const utcToday = (): string => new Date().toISOString().slice(0, 10);

export function hasStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

export function loadSession(userId: string, bookId: string): QuizSessionSnapshot | null {
  if (!hasStorage() || !userId || !bookId) return null;
  try {
    const raw = localStorage.getItem(keyOf(userId, bookId));
    if (!raw) return null;
    const snap = JSON.parse(raw) as QuizSessionSnapshot;
    if (snap.date !== utcToday() || !Array.isArray(snap.items) || snap.items.length === 0) {
      clearSession(userId, bookId);
      return null;
    }
    return snap;
  } catch {
    return null; // 脏数据当作没有会话
  }
}

export function saveSession(
  userId: string,
  bookId: string,
  snap: Omit<QuizSessionSnapshot, 'date'>,
): void {
  if (!hasStorage() || !userId || !bookId) return;
  try {
    localStorage.setItem(keyOf(userId, bookId), JSON.stringify({ date: utcToday(), ...snap }));
  } catch {
    // 写满/隐私模式：静默放弃（会话恢复是体验增强，不阻断学习）
  }
}

export function clearSession(userId: string, bookId: string): void {
  if (!hasStorage() || !userId || !bookId) return;
  try {
    localStorage.removeItem(keyOf(userId, bookId));
  } catch {
    // 忽略
  }
}

/** QuizItem ↔ 快照的组装（QuizPage 用） */
export interface SessionSourceItem {
  bookWord: BookWord;
  word: Word;
  senseIndex: number;
  attemptNo?: number;
  released?: boolean;
  promoted?: boolean;
  options?: DistractorCandidate[];
  correctKey?: string;
  verdict?: QuizVerdict;
  pickedKey?: string;
  askedAt?: number;
}

export function toSnapshots(items: SessionSourceItem[]): QuizItemSnapshot[] {
  return items.map((it) => ({
    bookWordId: it.bookWord.id,
    wordId: it.bookWord.wordId,
    senseIndex: it.senseIndex,
    ...(it.attemptNo ? { attemptNo: it.attemptNo } : {}),
    ...(it.released !== undefined ? { released: it.released } : {}),
    ...(it.promoted !== undefined ? { promoted: it.promoted } : {}),
    ...(it.options ? { options: it.options } : {}),
    ...(it.correctKey ? { correctKey: it.correctKey } : {}),
    ...(it.verdict ? { verdict: it.verdict } : {}),
    ...(it.pickedKey ? { pickedKey: it.pickedKey } : {}),
    ...(it.askedAt ? { askedAt: it.askedAt } : {}),
  }));
}
