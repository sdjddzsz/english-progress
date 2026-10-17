/**
 * notes.test.ts —— noteRepo（单词笔记，用户 2026-10-17）：
 * 确定性 id 一词一记 / 保存幂等覆盖 / 删除 / 按更新时间倒序列出。
 * mock 云数据库（tests/helpers/mockDb），不改线上数据。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createNoteRepo } from '../../src/data/repos/noteRepo';
import { MockDb } from '../helpers/mockDb';

describe('noteRepo（mock 云数据库）', () => {
  let db: MockDb;
  let repo: ReturnType<typeof createNoteRepo>;

  beforeEach(() => {
    db = new MockDb();
    repo = createNoteRepo(db);
  });

  it('noteId = {userId}_{wordId}（一词一记的确定性 id）', () => {
    expect(repo.noteId('u1', 'w1')).toBe('u1_w1');
  });

  it('首次保存 → 可读回；再次保存 → 覆盖同一条（不产生第二行）', async () => {
    await repo.saveNote({ userId: 'u1', wordId: 'w1', lemma: 'archive', content: ' archival 形容词义易混', source: 'quiz:1' });
    const got = await repo.getNote('u1', 'w1');
    expect(got).not.toBeNull();
    expect(got?.lemma).toBe('archive');
    expect(got?.source).toBe('quiz:1');

    await repo.saveNote({ userId: 'u1', wordId: 'w1', lemma: 'archive', content: '改过的笔记', source: 'quiz:1' });
    const got2 = await repo.getNote('u1', 'w1');
    expect(got2?.content).toBe('改过的笔记');
    const rows = db.tables.get('word_notes') ?? [];
    expect(rows.length).toBe(1);
    // 覆盖时 createdAt 保留首次创建时间
    expect(got2?.createdAt).toBe(got?.createdAt);
  });

  it('不同词/不同用户互不干扰', async () => {
    await repo.saveNote({ userId: 'u1', wordId: 'w1', lemma: 'a', content: '甲的', source: 'quiz:1' });
    await repo.saveNote({ userId: 'u1', wordId: 'w2', lemma: 'b', content: '乙的', source: 'manual' });
    await repo.saveNote({ userId: 'u2', wordId: 'w1', lemma: 'a', content: '别人的', source: 'quiz:1' });
    expect((await repo.getNote('u1', 'w1'))?.content).toBe('甲的');
    expect((await repo.getNote('u2', 'w1'))?.content).toBe('别人的');
    expect((await repo.getNote('u1', 'w2'))?.content).toBe('乙的');
  });

  it('删除后读不回', async () => {
    await repo.saveNote({ userId: 'u1', wordId: 'w1', lemma: 'a', content: 'x', source: 'quiz:1' });
    expect(await repo.removeNote('u1', 'w1')).toBe(true);
    expect(await repo.getNote('u1', 'w1')).toBeNull();
  });

  it('listNotes 只回该用户的笔记（updatedAt 降序）', async () => {
    await repo.saveNote({ userId: 'u1', wordId: 'w1', lemma: 'a', content: '早', source: 'quiz:1' });
    await repo.saveNote({ userId: 'u2', wordId: 'w9', lemma: 'z', content: '别人的', source: 'quiz:1' });
    await repo.saveNote({ userId: 'u1', wordId: 'w2', lemma: 'b', content: '晚', source: 'manual' });
    // 模拟 w1 是一分钟前保存的（同一毫秒内连存顺序不定，这里把时间拉开才有排序可言）
    const rows = db.tables.get('word_notes') ?? [];
    const w1 = rows.find((r) => r.wordId === 'w1') as { updatedAt: string };
    w1.updatedAt = new Date(Date.parse(w1.updatedAt) - 60000).toISOString();
    const list = await repo.listNotes('u1');
    expect(list.length).toBe(2);
    expect(list.every((n) => n.userId === 'u1')).toBe(true);
    // 后保存的排在前面（updatedAt 降序）
    expect(list[0].content).toBe('晚');
  });

  it('保存前后空白被裁掉；空内容不该由仓库层拦（UI 已禁用）', async () => {
    await repo.saveNote({ userId: 'u1', wordId: 'w1', lemma: 'a', content: '  hello  ', source: 'quiz:1' });
    expect((await repo.getNote('u1', 'w1'))?.content).toBe('hello');
  });
});
