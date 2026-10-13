/**
 * insertId.test.ts —— `Repository.insert` 必须自动生成 id（线上 23502 的根治守卫）。
 *
 * ⚠ 这是一条真实故障的回归测试（2026-10-13 21:00 线上暴露）：
 *   用户点「确认重建词书」报
 *   `[tier_snapshots] null value in column "id" ... violates not-null constraint (23502)`。
 *
 * 根因：云端 **25 张表的 `id` 列全部是 `text NOT NULL` 且没有默认值**（实测已逐表确认），
 * 而 `Repository.insert(doc: Omit<T,'id'> & { id?: string })` 把 id 标成**可选** ——
 * 于是「不传 id」在类型检查上完全合法，在运行期直接炸。
 * 当时两个调用点都踩了：`rebuildWordBook`（备份分层快照）与 `PlacementPage.saveTierSnapshot`。
 *
 * 为什么以前测试是绿的：`tests/helpers/mockDb.ts` 里有一行
 * `if (!d.id) d.id = 'gen_' + seq++` —— **替缺失 id 兜了假值**，把真实故障掩盖掉了。
 * 该 mock 已改为忠实模拟 PG（缺 id → 报 23502），所以这组用例现在能真正守住它。
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Repository, newDocId } from '../../src/data/repository';
import type { TierSnapshot } from '../../src/types/domain';
import { MockDb } from '../helpers/mockDb';

describe('newDocId（通用 id 生成）', () => {
  it('生成非空字符串', () => {
    const id = newDocId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(10);
  });

  it('每次调用都不同（不会撞）', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newDocId()));
    expect(ids.size).toBe(2000);
  });

  it('形如 UUID v4（36 字符、4 个连字符、版本位为 4）', () => {
    const id = newDocId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id[14]).toBe('4'); // 版本号
  });
});

describe('Repository.insert 的 id 自动生成（23502 回归守卫）', () => {
  interface Doc {
    id: string;
    name: string;
    tier: number;
  }

  it('不传 id 也能插入成功（原本会在云端报 23502）', async () => {
    const repo = new Repository<Doc>(new MockDb(), 'books');
    const created = await repo.insert({ name: '六级词书', tier: 4 });
    expect(created.id).toBeTruthy();
    expect(typeof created.id).toBe('string');
  });

  it('不传 id 时，插入的行真的进了表（能按生成的 id 读回）', async () => {
    const repo = new Repository<Doc>(new MockDb(), 'books');
    const created = await repo.insert({ name: '自建词书', tier: 2 });
    const readBack = await repo.getById(created.id);
    expect(readBack?.name).toBe('自建词书');
  });

  it('显式传 id 时原样使用（幂等写入路径不受影响）', async () => {
    const repo = new Repository<Doc>(new MockDb(), 'book_words');
    const created = await repo.insert({ id: 'bw_book_record', name: 'record', tier: 4 });
    expect(created.id).toBe('bw_book_record');
  });

  it('连续插入多条，id 互不重复（不会互相覆盖）', async () => {
    const repo = new Repository<Doc>(new MockDb(), 'books');
    const a = await repo.insert({ name: 'A', tier: 1 });
    const b = await repo.insert({ name: 'B', tier: 2 });
    const c = await repo.insert({ name: 'C', tier: 3 });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect((await repo.list([], {})).length).toBe(3);
  });

  /**
   * 线上实际报错的两个调用点：用 TierSnapshot 形状复现，
   * 确认它们各自的字段组合都不会再因缺 id 而炸。
   */
  it('tier_snapshots 形状的插入（备份路径）不再缺 id', async () => {
    const repo = new Repository<TierSnapshot>(new MockDb(), 'tier_snapshots');
    const created = await repo.insert({
      userId: 'user-1',
      sampledWordIds: [],
      responses: {},
      computedTiers: {},
      calibratedAt: '2026-10-13T13:00:00.000Z',
    });
    expect(created.id).toBeTruthy();
  });

  it('mockDb 不再替缺失 id 兜假值（否则本组测试会假绿）', async () => {
    // 直接对 mock 塞一个无 id 的文档：必须像 PG 一样报 23502
    const db = new MockDb();
    const repo = new Repository<Doc>(db, 'books');
    const raw = (db as unknown as { from(t: string): { insert(d: unknown): { select(): Promise<unknown> } } }).from(
      'books',
    );
    await expect(
      (raw.insert({ name: 'no-id', tier: 1 }) as { select(): Promise<unknown> }).select(),
    ).rejects.toBeDefined();
    // 同时确认正常路径仍可用（避免把 mock 改死了）
    await expect(repo.insert({ name: 'with-id', tier: 1 })).resolves.toBeTruthy();
  });
});
