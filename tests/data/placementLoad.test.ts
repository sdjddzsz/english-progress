/**
 * placementLoad.test.ts —— 摸底加载/提交的**载荷边界**守门用例（2026-10-14）。
 *
 * 背景（用户实测阻断性故障）：
 *   1. 「开始摸底」阶段曾把整本 8296 个词的详情全拉下来（92 个请求 / 十几 MB）⇒ Failed to fetch；
 *   2. 修好加载后，**「答完 300 题点提交」又拉了一次全书 8296 行**（9 个分页请求）
 *      ⇒ 用户报「卡在摸底分层环节」。提交其实只需要本次答过的 ≤300 个词对应的 bookWord 行。
 *   3. `listBookWords` 的分页排序键曾用 `orderInList` —— 在 listSize=50 的切分下
 *      8296 行里只有 166 个不同值，**非唯一列 + Range 翻页**会让 Postgres 不保证跨页稳定。
 *
 * 这组用例把这三条钉死，避免日后回归。
 */
import { describe, expect, it } from 'vitest';
import { Repository } from '../../src/data/repository';
import { createWordRepo, ID_BATCH } from '../../src/data/repos/wordRepo';
import { MockDb } from '../helpers/mockDb';

interface Doc {
  id: string;
  name: string;
  tier: number;
  createdAt: string;
}

/** 造一条 book_word：id 用定长补零，保证字符串排序可预测；orderInList 每 50 行循环一次（模拟 listSize=50） */
function mkBookWord(i: number, bookId = 'b1'): Record<string, unknown> {
  return {
    id: `bw_${String(i).padStart(5, '0')}`,
    bookId,
    wordId: `w_${String(i).padStart(5, '0')}`,
    listNo: Math.floor(i / 50) + 1,
    orderInList: (i % 50) + 1,
    tier: (i % 4) + 1,
    tierUpdatedAt: '',
    status: 'normal',
  };
}

const wordIdOf = (i: number): string => `w_${String(i).padStart(5, '0')}`;

describe('摸底提交只取需要的行（listBookWordsByWordIds）', () => {
  it('只返回指定的 wordId，一行都不多拉', async () => {
    const repo = createWordRepo(new MockDb());
    await repo.upsertBookWords(Array.from({ length: 500 }, (_, i) => mkBookWord(i)) as never);

    const out = await repo.listBookWordsByWordIds('b1', [wordIdOf(10), wordIdOf(11), wordIdOf(12)]);

    expect(out.map((r) => r.wordId).sort()).toEqual([wordIdOf(10), wordIdOf(11), wordIdOf(12)]);
  });

  it('入参去重后分片：超过 ID_BATCH 时不会拼出超长 URL，且不重不漏', async () => {
    const repo = createWordRepo(new MockDb());
    const n = ID_BATCH + 20;
    await repo.upsertBookWords(Array.from({ length: n }, (_, i) => mkBookWord(i)) as never);

    const ids = Array.from({ length: n }, (_, i) => wordIdOf(i));
    const withDup = [...ids, ids[0], ids[1]];
    const out = await repo.listBookWordsByWordIds('b1', withDup);

    expect(out.length).toBe(n);
    expect(new Set(out.map((r) => r.wordId)).size).toBe(n);
  });

  it('空入参不发请求，直接返回空数组', async () => {
    const repo = createWordRepo(new MockDb());
    expect(await repo.listBookWordsByWordIds('b1', [])).toEqual([]);
    expect(await repo.listBookWordsByWordIds('b1', ['', ''])).toEqual([]);
  });

  it('不会把别的词书的行混进来', async () => {
    const repo = createWordRepo(new MockDb());
    await repo.upsertBookWords([
      mkBookWord(1, 'b1'),
      mkBookWord(2, 'b1'),
      mkBookWord(3, 'b2'),
    ] as never);

    const out = await repo.listBookWordsByWordIds('b1', [wordIdOf(1), wordIdOf(2), wordIdOf(3)]);
    expect(out.every((r) => r.bookId === 'b1')).toBe(true);
    expect(out.length).toBe(2);
  });
});

describe('各层词量用 count 统计（countBookWordsByTier）', () => {
  it('四个层各回一个数，总和等于总词量', async () => {
    const repo = createWordRepo(new MockDb());
    const n = 400; // tier 循环 1..4 ⇒ 每层 100
    await repo.upsertBookWords(Array.from({ length: n }, (_, i) => mkBookWord(i)) as never);

    const byTier = await repo.countBookWordsByTier('b1');

    expect(byTier).toEqual({ 1: 100, 2: 100, 3: 100, 4: 100 });
    expect(await repo.countBookWords('b1')).toBe(n);
  });
});

describe('listAll 的分页进度回调（长操作必须有可见进度）', () => {
  it('每读完一页回调一次，最后一次等于总行数', async () => {
    const db = new MockDb();
    const repo = new Repository<Doc>(db, 'books');
    await repo.insertMany(
      Array.from({ length: 2500 }, (_, i) => ({
        id: `d_${String(i).padStart(5, '0')}`,
        name: `n${i}`,
        tier: 1,
        createdAt: '',
      })),
    );

    const seen: number[] = [];
    const all = await repo.listAll([], { onPage: (loaded) => seen.push(loaded) });

    expect(all.length).toBe(2500);
    // mock 的 SERVER_MAX_ROWS=1000 ⇒ 1000 / 2000 / 2500 三页
    expect(seen).toEqual([1000, 2000, 2500]);
  });

  it('不足一页时只回调一次', async () => {
    const db = new MockDb();
    const repo = new Repository<Doc>(db, 'books');
    await repo.insertMany([{ id: 'd1', name: 'a', tier: 1, createdAt: '' }]);

    const seen: number[] = [];
    await repo.listAll([], { onPage: (loaded) => seen.push(loaded) });

    expect(seen).toEqual([1]);
  });
});

describe('listBookWords 的分页排序键必须唯一', () => {
  it('跨页翻 2500 行：不重不漏，且按主键 id 升序（证明用的是唯一键而非 orderInList）', async () => {
    const repo = createWordRepo(new MockDb());
    const n = 2500; // 超过 mock 的 SERVER_MAX_ROWS=1000，强制翻 3 页
    await repo.upsertBookWords(Array.from({ length: n }, (_, i) => mkBookWord(i)) as never);

    const rows = await repo.listBookWords('b1');

    expect(rows.length).toBe(n); // 一行不少
    expect(new Set(rows.map((r) => r.id)).size).toBe(n); // 一行不重

    // 关键断言：返回顺序是 id 升序。若有人把排序键改回 orderInList，
    // 顺序会变成 orderInList 序（1,2,3…50,1,2,3…）⇒ 这条立即失败。
    const ids = rows.map((r) => r.id);
    expect([...ids].sort()).toEqual(ids);
  });
});
