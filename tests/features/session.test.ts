/**
 * session.test.ts —— 考查会话快照（用户 2026-10-15：中途退出重进回到原进度）。
 * node 环境无 localStorage ⇒ 用内存 Map 桩 globalThis.localStorage。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSession,
  loadSession,
  restoreSnapshotItem,
  saveSession,
  toSnapshots,
  type QuizItemSnapshot,
  type QuizSessionSnapshot,
} from '../../src/features/quiz/session';
import type { Word } from '../../src/types/domain';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  // 回到今天（防其他用例污染）
  jest_date_reset();
});
function jest_date_reset(): void {
  // 占位：session.ts 用真实 Date；隔天失效用例直接改快照日期字段
}

describe('考查会话快照', () => {
  const uid = 'u1';
  const book = 'book1';
  const valid: Omit<QuizSessionSnapshot, 'date'> = {
    items: [
      { bookWordId: 'bw1', wordId: 'w1', senseIndex: 0, verdict: 'skilled', pickedKey: 'w1#0' },
      { bookWordId: 'bw2', wordId: 'w2', senseIndex: 1 },
    ],
    idx: 1,
    stats: { skilled: 1, graduated: 0, special: 0, dayPassed: 0, total: 2 },
    todayLeft: 2,
  };

  it('存后能读回，idx/stats 原样', () => {
    saveSession(uid, book, valid);
    const snap = loadSession(uid, book);
    expect(snap).not.toBeNull();
    expect(snap?.idx).toBe(1);
    expect(snap?.items).toHaveLength(2);
    expect(snap?.items[0].verdict).toBe('skilled');
  });

  it('按用户+词书隔离', () => {
    saveSession(uid, book, valid);
    expect(loadSession('u2', book)).toBeNull();
    expect(loadSession(uid, 'book2')).toBeNull();
  });

  it('隔天快照作废并清除', () => {
    saveSession(uid, book, valid);
    const key = `ep-quiz-session:${uid}:${book}`;
    const raw = JSON.parse(store.get(key)!) as QuizSessionSnapshot;
    raw.date = '2020-01-01'; // 模拟隔天
    store.set(key, JSON.stringify(raw));
    expect(loadSession(uid, book)).toBeNull();
    expect(store.has(key)).toBe(false);
  });

  it('脏 JSON 当作没有会话', () => {
    store.set(`ep-quiz-session:${uid}:${book}`, '{broken');
    expect(loadSession(uid, book)).toBeNull();
  });

  it('clearSession 删除', () => {
    saveSession(uid, book, valid);
    clearSession(uid, book);
    expect(loadSession(uid, book)).toBeNull();
  });

  it('toSnapshots：只保留可序列化字段，bookWord/word 转 id 引用', () => {
    const snap = toSnapshots([
      {
        bookWord: { id: 'bw9', wordId: 'w9' } as never,
        word: { id: 'w9', lemma: 'x' } as never,
        senseIndex: 2,
        verdict: 'unknown',
        pickedKey: 'k',
      },
    ]);
    expect(snap).toEqual([
      { bookWordId: 'bw9', wordId: 'w9', senseIndex: 2, verdict: 'unknown', pickedKey: 'k' },
    ]);
  });
});

describe('restoreSnapshotItem：删释义后的坏快照净化（用户 2026-10-18）', () => {
  const word: Word = {
    id: 'w1', lemma: 'record', ipa: '', arpabet: '', pos: '', frequency: 0, tags: [], senses: [],
    sensesDetail: [
      { senseId: 'record#0', lemma: 'record', pos: 'n.', zh: '记录', pronunciationKey: 'k', arpabet: '', ipa: '' },
      { senseId: 'record#1', lemma: 'record', pos: 'v.', zh: '录制', pronunciationKey: 'k', arpabet: '', ipa: '' },
    ],
    examples: [],
  };
  const base: QuizItemSnapshot = { bookWordId: 'bw1', wordId: 'w1', senseIndex: 1, attemptNo: 1 };

  it('未作答 + 越界 ⇒ 收敛锚点并丢掉旧选项（按新义项重出，不考已删义项）', () => {
    const stale: QuizItemSnapshot = {
      ...base,
      options: [{ zh: '录制', pos: 'v.', lemma: 'record', order: 0, key: 'w1#1' }],
      correctKey: 'w1#1',
    };
    const out = restoreSnapshotItem(stale, word);
    expect(out.senseIndex).toBe(1); // 两义项时 1 不越界，原样
    expect(restoreSnapshotItem(stale, { ...word, sensesDetail: word.sensesDetail!.slice(0, 1) }).senseIndex).toBe(0);
    const deleted = restoreSnapshotItem(stale, { ...word, sensesDetail: word.sensesDetail!.slice(0, 1) });
    expect(deleted.options).toBeUndefined();
    expect(deleted.correctKey).toBeUndefined();
  });

  it('已作答 + 越界 ⇒ 只收敛锚点，保留原选项供回看', () => {
    const answered: QuizItemSnapshot = {
      ...base,
      senseIndex: 1,
      verdict: 'skilled',
      options: [{ zh: '录制', pos: 'v.', lemma: 'record', order: 0, key: 'w1#1' }],
      correctKey: 'w1#1',
    };
    const out = restoreSnapshotItem(answered, { ...word, sensesDetail: word.sensesDetail!.slice(0, 1) });
    expect(out.senseIndex).toBe(0);
    expect(out.options).toHaveLength(1); // 历史判定不重放
  });

  it('没越界 ⇒ 原样返回（引用稳定）', () => {
    expect(restoreSnapshotItem(base, word)).toBe(base);
  });
});
