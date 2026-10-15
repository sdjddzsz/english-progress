/**
 * pool.test.ts —— 考查制选词池（用户 2026-10-15 拍板 A：今日页与考查页共用）逐条钉死。
 */
import { describe, expect, it } from 'vitest';
import type { BookWord } from '../../src/types/domain';
import { selectQuizPool } from '../../src/features/quiz/pool';

let seq = 0;
function bw(overrides: Partial<BookWord>): BookWord {
  seq += 1;
  return {
    id: `bw${seq}`,
    bookId: 'book1',
    wordId: `w${seq}`,
    listNo: 1,
    orderInList: seq,
    tier: 3,
    tierUpdatedAt: '2026-10-01T00:00:00Z',
    status: 'normal',
    streak: 0,
    failStreak: 0,
    specialTraining: false,
    quizDayStreak: 0,
    quizDayPassed: false,
    ...overrides,
  };
}

const NOW = new Date('2026-10-15T10:00:00Z');
const daysAgo = (n: number, hour = 2): string =>
  new Date(Date.UTC(2026, 9, 15 - n, hour)).toISOString();

describe('selectQuizPool：进池', () => {
  it('无 lastQuizAt 的词必进池', () => {
    const r = selectQuizPool([bw({ tier: 2 })], NOW);
    expect(r.pool).toHaveLength(1);
  });
  it('按层间隔过滤：T4 隔 1 天可再考，T1 隔 4 天', () => {
    const r = selectQuizPool(
      [
        bw({ tier: 4, lastQuizAt: daysAgo(1) }), // 昨天 ⇒ 间隔 1 满足
        bw({ tier: 1, lastQuizAt: daysAgo(1) }), // 昨天 ⇒ 间隔 4 不满足
        bw({ tier: 1, lastQuizAt: daysAgo(4) }), // 4 天前 ⇒ 满足
      ],
      NOW,
    );
    expect(r.pool).toHaveLength(2);
    expect(r.pool.map((b) => b.tier).sort()).toEqual([1, 4]);
  });
  it('毕业词（streak≥5）不进池', () => {
    const r = selectQuizPool([bw({ streak: 5 }), bw({ streak: 4 })], NOW);
    expect(r.pool).toHaveLength(1);
    expect(r.graduated).toBe(1);
  });
  it('特种训练按 T4 间隔（1 天）必考，无视本层间隔：T1 昨天=今天可考', () => {
    const r = selectQuizPool([bw({ tier: 1, specialTraining: true, lastQuizAt: daysAgo(1) })], NOW);
    expect(r.pool).toHaveLength(1);
  });
  it('特种训练同日已考的不再进池（同日不重复）', () => {
    const r = selectQuizPool(
      [bw({ specialTraining: true, lastQuizAt: daysAgo(0, 9), quizDayPassed: false })],
      NOW,
    );
    expect(r.pool).toHaveLength(0);
  });
  it('当天已过关（quizDayPassed 且 lastQuizAt 是今天）不进池', () => {
    const r = selectQuizPool([bw({ lastQuizAt: daysAgo(0, 9), quizDayPassed: true })], NOW);
    expect(r.pool).toHaveLength(0);
  });
});

describe('selectQuizPool：排序', () => {
  it('特种训练优先 → 层高优先 → 久未考优先', () => {
    const normal = bw({ tier: 2, lastQuizAt: daysAgo(3) });
    const special = bw({ tier: 1, specialTraining: true, lastQuizAt: daysAgo(1) });
    const t4 = bw({ tier: 4, lastQuizAt: daysAgo(1) });
    const t4Older = bw({ tier: 4, lastQuizAt: daysAgo(2) });
    const r = selectQuizPool([normal, special, t4, t4Older], NOW);
    expect(r.pool.map((b) => b.id)).toEqual([special.id, t4Older.id, t4.id, normal.id]);
  });
});

describe('selectQuizPool：统计', () => {
  it('total = 全部行数；graduated 只统计 streak 达标', () => {
    const r = selectQuizPool([bw({ streak: 5 }), bw({ streak: 5 }), bw({}), bw({})], NOW);
    expect(r.total).toBe(4);
    expect(r.graduated).toBe(2);
    expect(r.pool).toHaveLength(2);
  });
});
