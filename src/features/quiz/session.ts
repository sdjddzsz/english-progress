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
import { clampSenseIndex } from '../senses';
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

/**
 * 恢复单条快照前先净化（用户 2026-10-18：「删了正在考的释义后刷新，卡在空白页没法推进」）：
 * 快照里的 senseIndex 是**删释义之前**存的，词条的义项后来变少 ⇒ 越界 ⇒ 主卡片渲染条件
 * `senseOf` 为空 ⇒ 题卡消失；而每次刷新都从同一份快照恢复 ⇒ 刷新几次都一样，彻底卡死。
 *
 * 净化规则：
 *  - senseIndex 收敛到有效范围（clampSenseIndex：删当前项顺移下一个、删前面项对齐前移）；
 *  - **未作答**且锚点被移动过 ⇒ 丢掉旧 options/correctKey，让题目按新义项重出
 *    （否则 buildQuestion 看到已有选项直接返回 null，考的還是已删掉的那个义项）；
 *  - 已作答 ⇒ 保留原选项供回看（历史判定不重放）。
 * 没越界的原样返回（引用稳定）。
 */
export function restoreSnapshotItem(s: QuizItemSnapshot, word: Word): QuizItemSnapshot {
  const clamped = clampSenseIndex(word, s.senseIndex);
  if (clamped === s.senseIndex) return s;
  const out: QuizItemSnapshot = { ...s, senseIndex: clamped };
  if (s.verdict === undefined) {
    delete out.options;
    delete out.correctKey;
  }
  return out;
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
