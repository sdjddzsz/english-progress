/**
 * session.test.ts —— 考查会话快照（用户 2026-10-15：中途退出重进回到原进度）。
 * node 环境无 localStorage ⇒ 用内存 Map 桩 globalThis.localStorage。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearSession, loadSession, saveSession, toSnapshots, type QuizSessionSnapshot } from '../../src/features/quiz/session';

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
