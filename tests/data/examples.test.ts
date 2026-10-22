/**
 * examples-repo.test.ts —— exampleRepo（用户例句，用户 2026-10-22）：
 * 一词多条（每次生成追加一条，绝不覆盖）/ 按生成时间升序 / 删除 / 过滤他人数据。
 * mock 云数据库（tests/helpers/mockDb），不改线上数据。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createExampleRepo } from '../../src/data/repos/exampleRepo';
import { MockDb } from '../helpers/mockDb';
import type { BookWord } from '../../src/types/domain';

function bookWord(id: string, stage: BookWord['stage'], tier: BookWord['tier']): BookWord {
  return {
    id,
    bookId: 'b1',
    wordId: `w-${id}`,
    listNo: 1,
    orderInList: 0,
    tier,
    tierUpdatedAt: '2026-10-01T00:00:00.000Z',
    status: 'normal',
    streak: 0,
    failStreak: 0,
    specialTraining: false,
    quizDayStreak: 0,
    quizDayPassed: false,
    stage,
    stageStreak: 0,
  };
}

describe('exampleRepo（mock 云数据库）', () => {
  let db: MockDb;
  let repo: ReturnType<typeof createExampleRepo>;

  beforeEach(() => {
    db = new MockDb();
    repo = createExampleRepo(db);
  });

  it('同词两次生成 = 两条独立例句（追加，不覆盖）', async () => {
    await repo.addExample({ userId: 'u1', wordId: 'w1', senseId: 'abandon#0', lemma: 'abandon', en: 'A.', zh: '甲' });
    await repo.addExample({ userId: 'u1', wordId: 'w1', senseId: 'abandon#0', lemma: 'abandon', en: 'B.', zh: '乙' });
    const list = await repo.listExamplesForWord('u1', 'w1');
    expect(list.length).toBe(2);
    expect(list.map((x) => x.en)).toEqual(['A.', 'B.']);
    expect((db.tables.get('word_examples') ?? []).length).toBe(2);
  });

  it('source 默认 ai；en/zh 首尾空白被裁', async () => {
    const saved = await repo.addExample({
      userId: 'u1',
      wordId: 'w1',
      senseId: 'abandon#0',
      lemma: 'abandon',
      en: '  He abandoned it.  ',
      zh: '  他放弃了它。  ',
    });
    expect(saved.source).toBe('ai');
    expect(saved.en).toBe('He abandoned it.');
    expect(saved.zh).toBe('他放弃了它。');
  });

  it('不同词/不同用户互不干扰', async () => {
    await repo.addExample({ userId: 'u1', wordId: 'w1', senseId: 'a#0', lemma: 'a', en: 'A1', zh: '甲1' });
    await repo.addExample({ userId: 'u1', wordId: 'w2', senseId: 'b#0', lemma: 'b', en: 'B', zh: '乙' });
    await repo.addExample({ userId: 'u2', wordId: 'w1', senseId: 'a#0', lemma: 'a', en: 'A2', zh: '甲2' });
    const mine = await repo.listExamplesForWord('u1', 'w1');
    expect(mine.length).toBe(1);
    expect(mine[0].en).toBe('A1');
    expect((await repo.listExamplesForWord('u2', 'w1'))[0].en).toBe('A2');
    expect((await repo.listExamplesForWord('u1', 'w2'))[0].en).toBe('B');
  });

  it('删除后读不回；remove 返回是否真删了', async () => {
    const saved = await repo.addExample({ userId: 'u1', wordId: 'w1', senseId: 'a#0', lemma: 'a', en: 'X', zh: '某' });
    expect(await repo.removeExample(saved.id)).toBe(true);
    expect(await repo.removeExample(saved.id)).toBe(false); // 已删，第二次无行
    expect((await repo.listExamplesForWord('u1', 'w1')).length).toBe(0);
  });

  it('按生成时间升序（同毫秒补 id 字典序兜底）', async () => {
    await repo.addExample({ userId: 'u1', wordId: 'w1', senseId: 'a#0', lemma: 'a', en: '后', zh: 'hou' });
    await repo.addExample({ userId: 'u1', wordId: 'w1', senseId: 'a#0', lemma: 'a', en: '先', zh: 'xian' });
    const rows = db.tables.get('word_examples') ?? [];
    // 把第一条（"后"）的 createdAt 提前一分钟 ⇒ 排序应翻转为 ["后","先"]
    // （同一毫秒连存时服务端次序不定，这里把时间拉开才有排序可言）
    rows[0].createdAt = new Date(Date.parse(rows[0].createdAt as string) - 60000).toISOString();
    rows[0].updatedAt = rows[0].createdAt;
    const list = await repo.listExamplesForWord('u1', 'w1');
    expect(list.map((x) => x.en)).toEqual(['后', '先']);
  });
});

describe('wordRepo 阶段分页/计数（mock 云数据库）', () => {
  let db: MockDb;
  // 延迟 import：createWordRepo 依赖 getDb() 默认参数，注入 mock 即可
  let repo: ReturnType<typeof import('../../src/data/repos/wordRepo').createWordRepo>;

  beforeEach(async () => {
    db = new MockDb();
    const { createWordRepo } = await import('../../src/data/repos/wordRepo');
    repo = createWordRepo(db);
    // 12 行：stage1×10（tier 4/3/2/1 混合）、stage2×2
    const rows: BookWord[] = [];
    for (let i = 0; i < 12; i += 1) {
      const tier = ((i % 4) + 1) as BookWord['tier'];
      const stage: BookWord['stage'] = i < 10 ? 1 : 2;
      rows.push(bookWord(`bw-${String(i + 1).padStart(2, '0')}`, stage, tier));
    }
    db.tables.set('book_words', rows as unknown as Record<string, unknown>[]);
  });

  it('countBookWordsByStage 只数该阶段（stage=0 = 已毕业）', async () => {
    expect(await repo.countBookWordsByStage('b1', 1)).toBe(10);
    expect(await repo.countBookWordsByStage('b1', 2)).toBe(2);
    expect(await repo.countBookWordsByStage('b1', 0)).toBe(0);
  });

  it('listBookWordsPage：服务端 stage 过滤 + tier 降序（T4→T1）+ id 稳定次序', async () => {
    const page = await repo.listBookWordsPage('b1', { stage: 1, offset: 0, limit: 100 });
    expect(page.length).toBe(10);
    expect(page.every((r) => r.stage === 1)).toBe(true);
    const tiers = page.map((r) => r.tier);
    // 非递增序列才叫 tier.desc（相等允许）
    for (let i = 1; i < tiers.length; i += 1) expect(tiers[i]).toBeLessThanOrEqual(tiers[i - 1]);
  });

  it('listBookWordsPage：offset/limit 翻页不重不漏（id 唯一键兜底）', async () => {
    const p1 = await repo.listBookWordsPage('b1', { stage: 1, offset: 0, limit: 4 });
    const p2 = await repo.listBookWordsPage('b1', { stage: 1, offset: 4, limit: 4 });
    const p3 = await repo.listBookWordsPage('b1', { stage: 1, offset: 8, limit: 4 });
    expect([p1.length, p2.length, p3.length]).toEqual([4, 4, 2]);
    const all = [...p1, ...p2, ...p3].map((r) => r.id);
    expect(new Set(all).size).toBe(10); // 无重复
  });

  it('listBookWords 带 stage 过滤（兼容旧调用的全量路径不变）', async () => {
    const only2 = await repo.listBookWords('b1', { stage: 2 });
    expect(only2.length).toBe(2);
    const all = await repo.listBookWords('b1');
    expect(all.length).toBe(12);
  });
});
