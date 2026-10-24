/**
 * homeSummaryRpc.test.ts —— 云端聚合 RPC 语义（用户 2026-10-24：统计改云端算）。
 *
 * 钉死 mockDb.rpc 对两个 PG 函数的忠实实现（SQL 见 docs/交接-2026-10-24.md）：
 * owner_id 过滤、UTC 日分组、每天 distinct wordId、排序键、缺键默认值。
 * ⚠ 这些用例与云端 SQL 语义一一对应——mock 兜底 = 放生真实缺陷。
 */
import { describe, expect, it } from 'vitest';
import { MockDb } from '../helpers/mockDb';
import type { CloudDatabaseLike } from '../../src/data/repository';
import { createWordRepo } from '../../src/data/repos/wordRepo';

const TODAY = new Date().toISOString().slice(0, 10);
const isoDaysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

interface BwSeed {
  id: string;
  wordId: string;
  tier?: number;
  stage?: number;
  listNo?: number;
  orderInList?: number;
  lastQuizAt?: string | null;
  firstSeenAt?: string | null;
  specialTraining?: boolean;
  ownerId?: string;
}

function seedBookWords(db: MockDb, rows: BwSeed[]): void {
  db.tables.set(
    'book_words',
    rows.map((r) => ({
      id: r.id,
      bookId: 'b1',
      wordId: r.wordId,
      listNo: r.listNo ?? 1,
      orderInList: r.orderInList ?? 0,
      tier: r.tier ?? 2,
      stage: r.stage ?? 1,
      lastQuizAt: r.lastQuizAt ?? null,
      firstSeenAt: r.firstSeenAt ?? null,
      specialTraining: r.specialTraining ?? false,
      owner_id: r.ownerId ?? 'u1',
    })),
  );
}

describe('ep_home_summary（RPC 聚合）', () => {
  it('remaining/graduated 按 stage 分（stage>0 仍在池 / stage=0 已毕业）', async () => {
    const db = new MockDb();
    seedBookWords(db, [
      { id: '1', wordId: 'w1', stage: 1 },
      { id: '2', wordId: 'w2', stage: 2 },
      { id: '3', wordId: 'w3', stage: 0 },
      { id: '4', wordId: 'w4', stage: 0 },
    ]);
    const s = await createWordRepo(db).homeSummary('b1');
    expect(s.remaining).toBe(2);
    expect(s.graduated).toBe(2);
  });

  it('dailyCounts：同一天答多个词只算该词的次数；每天 distinct wordId', async () => {
    const db = new MockDb();
    seedBookWords(db, [
      { id: '1', wordId: 'w1', lastQuizAt: isoDaysAgo(0) },
      { id: '2', wordId: 'w2', lastQuizAt: isoDaysAgo(0) },
      { id: '3', wordId: 'w3', lastQuizAt: isoDaysAgo(1) },
    ]);
    const s = await createWordRepo(db).homeSummary('b1');
    expect(s.dailyCounts).toEqual([
      { date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), count: 1 },
      { date: TODAY, count: 2 },
    ]);
  });

  it('dailyCounts：15 天前的不进窗口；无 lastQuizAt 的不计入', async () => {
    const db = new MockDb();
    seedBookWords(db, [
      { id: '1', wordId: 'w1', lastQuizAt: isoDaysAgo(15) },
      { id: '2', wordId: 'w2', lastQuizAt: null },
      { id: '3', wordId: 'w3', lastQuizAt: isoDaysAgo(13) },
    ]);
    const s = await createWordRepo(db).homeSummary('b1');
    expect(s.dailyCounts).toHaveLength(1);
    expect(s.dailyCounts[0].count).toBe(1);
  });

  it('wordsByTier：按 tier 分组，组内按 listNo → orderInList → id 排序', async () => {
    const db = new MockDb();
    seedBookWords(db, [
      { id: 'a', wordId: 'w-a', tier: 1, listNo: 2, orderInList: 0 },
      { id: 'b', wordId: 'w-b', tier: 1, listNo: 1, orderInList: 5 },
      { id: 'c', wordId: 'w-c', tier: 1, listNo: 1, orderInList: 1 },
      { id: 'd', wordId: 'w-d', tier: 2 },
    ]);
    const s = await createWordRepo(db).homeSummary('b1');
    expect(s.wordsByTier[1]).toEqual(['w-c', 'w-b', 'w-a']); // listNo 1 的两条按 orderInList 排
    expect(s.wordsByTier[2]).toEqual(['w-d']);
    expect(s.tierCounts[1]).toBe(3);
    expect(s.tierCounts[2]).toBe(1);
  });

  it('owner 过滤：别的 owner 的行一概不算（云端 SQL 同口径）', async () => {
    const db = new MockDb();
    seedBookWords(db, [
      { id: '1', wordId: 'w1', ownerId: 'u1' },
      { id: '2', wordId: 'w2', ownerId: 'other-user', stage: 0 },
    ]);
    const s = await createWordRepo(db).homeSummary('b1');
    expect(s.remaining).toBe(1);
    expect(s.graduated).toBe(0);
  });

  it('空表/缺键 ⇒ 全零 + wordsByTier 空数组（不能是 undefined）', async () => {
    const db = new MockDb();
    const s = await createWordRepo(db).homeSummary('b1');
    expect(s.remaining).toBe(0);
    expect(s.graduated).toBe(0);
    expect(s.dailyCounts).toEqual([]);
    expect(s.wordsByTier).toEqual({ 1: [], 2: [], 3: [], 4: [] });
  });

  it('RPC 信封拆解：mock/SDK 回 {data,error} 信封，repo 必须取 data 的字段', async () => {
    // 2026-10-24 踩坑钉死：真 SDK 的 rpc() await 得到 processResponse 的信封，
    // 不是裸函数结果。wordRepo 若直接 cast 信封读字段 ⇒ 全部 undefined ⇒ 统计全 0 且不报错。
    const db = new MockDb();
    seedBookWords(db, [{ id: '1', wordId: 'w1', stage: 1 }]);
    const env = await db.rpc('ep_home_summary', { p_book_id: 'b1' });
    expect(env.error).toBeNull();
    expect(env.data).toHaveProperty('remaining', 1); // 信封里才有真数据
    const s = await createWordRepo(db).homeSummary('b1');
    expect(s.remaining).toBe(1); // repo 拆信封后拿到真值
  });

  it('RPC 出错（信封 error 非空）⇒ repo 抛错，不静默返回全零', async () => {
    // 真 SDK 遇到 404/500 时回 error 信封（不 throw）；repo 必须拆信封抛错，
    // 否则云函数缺失/故障会静默显示成全零统计（用户以为今天没答题）。
    const stub: CloudDatabaseLike = {
      from: () => {
        throw new Error('unused');
      },
      rpc: async () => ({ data: null, error: { message: 'function not found', code: '404' } }),
    };
    await expect(createWordRepo(stub).homeSummary('b1')).rejects.toThrow(/function not found/);
  });
});

describe('ep_stage_stats（RPC 聚合）', () => {
  it('byStage/specialByStage：按 stage 计数（含 0=已毕业）；特种训练单独计', async () => {
    const db = new MockDb();
    seedBookWords(db, [
      { id: '1', wordId: 'w1', stage: 1 },
      { id: '2', wordId: 'w2', stage: 1, specialTraining: true },
      { id: '3', wordId: 'w3', stage: 2, specialTraining: true },
      { id: '4', wordId: 'w4', stage: 0 },
      { id: '5', wordId: 'w5', stage: 1 },
    ]);
    const t = await createWordRepo(db).stageStatsSummary('b1');
    expect(t.byStage[0]).toBe(1);
    expect(t.byStage[1]).toBe(3);
    expect(t.byStage[2]).toBe(1);
    expect(t.byStage[3]).toBe(0);
    expect(t.byStage[4]).toBe(0);
    expect(t.specialByStage[1]).toBe(1);
    expect(t.specialByStage[2]).toBe(1);
  });

  it('空表 ⇒ 全 0（缺键给 0，不是 undefined）', async () => {
    const db = new MockDb();
    const t = await createWordRepo(db).stageStatsSummary('b1');
    expect(t.byStage).toEqual({ 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 });
    expect(t.specialByStage).toEqual({ 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 });
  });

  it('owner 过滤：别的 owner 的行一概不算', async () => {
    const db = new MockDb();
    seedBookWords(db, [
      { id: '1', wordId: 'w1', stage: 1, ownerId: 'u1' },
      { id: '2', wordId: 'w2', stage: 1, ownerId: 'other-user' },
    ]);
    const t = await createWordRepo(db).stageStatsSummary('b1');
    expect(t.byStage[1]).toBe(1);
  });
});

describe('ep_today_quiz（RPC 聚合）', () => {
  it('words/firstSeen + id 集合（lastQuizAt/firstSeenAt 按 UTC 日 = p_today）', async () => {
    const db = new MockDb();
    seedBookWords(db, [
      { id: '1', wordId: 'w1', lastQuizAt: isoDaysAgo(0), firstSeenAt: isoDaysAgo(0) },
      { id: '2', wordId: 'w2', lastQuizAt: isoDaysAgo(0), firstSeenAt: isoDaysAgo(1) }, // 昨天首见
      { id: '3', wordId: 'w3', lastQuizAt: isoDaysAgo(1) }, // 昨天答的，不算今天
    ]);
    const t = await createWordRepo(db).todayQuizSummary('b1', TODAY);
    expect(t.words).toBe(2);
    expect(t.firstSeen).toBe(1);
    expect(t.wordIds.sort()).toEqual(['w1', 'w2']);
    expect(t.firstSeenIds).toEqual(['w1']);
  });

  it('firstSeenAt 为空（老数据）⇒ firstSeen 0、集合空（回落本机当场补）', async () => {
    const db = new MockDb();
    seedBookWords(db, [{ id: '1', wordId: 'w1', lastQuizAt: isoDaysAgo(0) }]);
    const t = await createWordRepo(db).todayQuizSummary('b1', TODAY);
    expect(t.words).toBe(1);
    expect(t.firstSeen).toBe(0);
    expect(t.firstSeenIds).toEqual([]);
  });
});
