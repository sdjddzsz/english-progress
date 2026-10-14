/**
 * listAll.test.ts —— 「服务端静默截断 1000 行」的回归守卫（2026-10-13 线上事故）。
 *
 * ⚠⚠ 这是本项目至今最隐蔽的一个缺陷，因为它**不报错**：
 *   `Repository.list()` 不传 limit 时把 range 上界写成 `from + 1_000_000`，
 *   但**服务端（PostgREST）的 max-rows 默认上限是 1000**，超出部分被静默丢弃。
 *   实测：云端 book_words 有 5407 行时，`list()` 返回 `.length === 1000` ——
 *   **没有异常、没有告警，就是少了 4407 条**。
 *
 *   真实后果（用户 21:14 截图「现在显示没有词书」）：
 *    1. `rebuildWordBook` 只备份/只删除了前 1000 条 book_words，
 *       剩下 4407 条「从未被看见」；
 *    2. `books` 行已删、`book_words` 被删一半 ⇒ 用户直接看不到词书；
 *    3. 更长远：`refreshToday`（每日队列展开）也只读到 1000 词 ——
 *       **8296 词的词书里有 7296 个词永远排不进学习队列**，而界面看不出任何异常。
 *
 * MockDb 默认会截断到 1000（忠实模拟服务端），本组用例锁住 listAll 必须翻页读全。
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Repository } from '../../src/data/repository';
import { MockDb } from '../helpers/mockDb';

interface Doc {
  id: string;
  name: string;
  n: number;
}

async function seedRows(db: MockDb, table: string, rows: Doc[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 100) {
    await db.from(table).insert(rows.slice(i, i + 100) as unknown as Record<string, unknown>[]);
  }
}

const rows = (n: number): Doc[] =>
  Array.from({ length: n }, (_, i) => ({ id: `w${i}`, name: `n${i}`, n: i }));

describe('Repository.listAll（服务端 1000 行静默截断的根治）', () => {
  it('list() 在超 1000 行时确实会少数据（复现根因）', async () => {
    const db = new MockDb();
    await seedRows(db, 'book_words', rows(2500));
    const repo = new Repository<Doc>(db, 'book_words');
    const viaList = await repo.list([], {});
    const viaListAll = await repo.listAll([], {});
    // 这是事故的核心：list 少读（且不报错），listAll 读全
    expect(viaList.length).toBe(1000);
    expect(viaListAll.length).toBe(2500);
  });

  it('读全且顺序稳定（按 orderBy）', async () => {
    const db = new MockDb();
    await seedRows(db, 'book_words', rows(2500));
    const repo = new Repository<Doc>(db, 'book_words');
    const a = await repo.listAll([], { orderBy: 'n' });
    const b = await repo.listAll([], { orderBy: 'n' });
    expect(a.length).toBe(2500);
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(a[0].n).toBe(0);
    expect(a[2499].n).toBe(2499);
  });

  it('无 orderBy 时按主键 id 排序（分页必须有稳定序，否则会重复/漏行）', async () => {
    const db = new MockDb();
    await seedRows(db, 'book_words', rows(1200));
    const repo = new Repository<Doc>(db, 'book_words');
    const out = await repo.listAll([], {});
    expect(out.length).toBe(1200);
    expect(new Set(out.map((r) => r.id)).size).toBe(1200); // 无重复
  });

  it('带过滤条件时同样读全（重建路径就是带 bookId 过滤的）', async () => {
    const db = new MockDb();
    await seedRows(
      db,
      'book_words',
      Array.from({ length: 2000 }, (_, i) => ({ id: `w${i}`, name: 'x', n: i % 2 })),
    );
    const repo = new Repository<Doc>(db, 'book_words');
    const even = await repo.listAll([{ column: 'n', op: 'eq', value: 0 }], {});
    expect(even.length).toBe(1000); // 2000 行里的一半
    expect(even.every((r) => r.n === 0)).toBe(true);
  });

  it('结果数恰好是页大小整数倍时不会漏掉最后一页', async () => {
    const db = new MockDb();
    await seedRows(db, 'book_words', rows(2000));
    const repo = new Repository<Doc>(db, 'book_words');
    expect((await repo.listAll([], {})).length).toBe(2000);
  });

  it('超过 maxRows 时抛错（宁可报错也不能静默少数据）', async () => {
    const db = new MockDb();
    await seedRows(db, 'book_words', rows(300));
    const repo = new Repository<Doc>(db, 'book_words');
    await expect(repo.listAll([], { pageSize: 10, maxRows: 15 })).rejects.toBeDefined();
  });

  it('空表返回空数组（不空转）', async () => {
    const repo = new Repository<Doc>(new MockDb(), 'book_words');
    expect(await repo.listAll([], {})).toEqual([]);
  });

  it('支持自定义 pageSize（便于测试与特殊场景）', async () => {
    const db = new MockDb();
    await seedRows(db, 'book_words', rows(105));
    const repo = new Repository<Doc>(db, 'book_words');
    expect((await repo.listAll([], { pageSize: 10 })).length).toBe(105);
  });
});
