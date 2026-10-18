/**
 * sync.test.ts —— T05 离线端到端（架构验收：断网 10 hit 补传幂等）：
 * 1) 断网下 completeHit → 全部入 pending_ops，云端无变化；
 * 2) 联网 replayPendingOps → 10 条全部落地、队列清空；
 * 3) 重放幂等：再跑一次 replay → 0 条、无重复副作用；
 * 4) 部分失败（目标行缺失）→ failOp 记账留在队列，不阻断其他 op。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDb } from '../helpers/mockDb';
import { createToolContext } from '../helpers/toolContext';
import { localDb, type PendingOp } from '../../src/data/localDb';
import { enqueueOp } from '../../src/data/queue';
import { replayPendingOps } from '../../src/offline/syncManager';
import type { Repos } from '../../src/store/useAppStore';
import type { Hit } from '../../src/types/domain';

function hitFixture(i: number): Hit {
  return {
    id: `p1_w${i}_1_2026-10-10`,
    planId: 'p1',
    wordId: `w${i}`,
    userId: 'u1',
    tier: 3,
    roundNo: 1,
    listNo: 0,
    scheduledDate: '2026-10-10',
    modality: 'visual',
    status: 'pending',
    explain: { roundIdxInWindow: 0 },
  };
}

describe('离线补传（断网 10 hit 端到端）', () => {
  let repos: Repos;
  let mockDb: MockDb;

  beforeEach(async () => {
    vi.stubGlobal('navigator', { onLine: false }); // 断网
    mockDb = new MockDb();
    repos = createToolContext(mockDb).repos as unknown as Repos;
    await localDb.pendingOps.clear();
    // 预置 10 条 pending hit 到"云端"（mock 表）
    const hits = Array.from({ length: 10 }, (_, i) => hitFixture(i));
    await repos.hit.hits.upsertMany(hits as unknown as (Hit & Record<string, unknown>)[]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('断网：10 次完成全部入队，云端无变化', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await repos.hit.completeHit(hitFixture(i).id, '2026-10-10T08:00:00Z');
      expect(r).toBe('queued');
    }
    expect(await localDb.pendingOps.count()).toBe(10);
    // 云端状态未变
    const h0 = await repos.hit.getHit(hitFixture(0).id);
    expect(h0?.status).toBe('pending');
  });

  it('联网恢复：补传后云端全 done、队列清空；重放幂等（第二次 0 条）', async () => {
    // 断网入队 10 条
    for (let i = 0; i < 10; i++) {
      await repos.hit.completeHit(hitFixture(i).id, '2026-10-10T08:00:00Z');
    }
    vi.stubGlobal('navigator', { onLine: true }); // 联网恢复
    const r1 = await replayPendingOps(repos);
    expect(r1.done).toBe(10);
    expect(r1.failed).toBe(0);
    expect(await localDb.pendingOps.count()).toBe(0);
    for (let i = 0; i < 10; i++) {
      const h = await repos.hit.getHit(hitFixture(i).id);
      expect(h?.status).toBe('done');
      expect(h?.completedAt).toBe('2026-10-10T08:00:00Z');
    }
    // 幂等：队列已空，再跑一次无副作用
    const r2 = await replayPendingOps(repos);
    expect(r2.done).toBe(0);
    expect(r2.failed).toBe(0);
    const h0 = await repos.hit.getHit(hitFixture(0).id);
    expect(h0?.completedAt).toBe('2026-10-10T08:00:00Z');
  });

  it('重复 op_id 幂等 + 毒丸跳过：未知操作名不阻塞其余补传', async () => {
    await enqueueOp('hit.complete', { hitId: hitFixture(0).id, completedAt: '2026-10-10T08:00:00Z' }, undefined, 'op-dup');
    await enqueueOp('hit.complete', { hitId: hitFixture(0).id, completedAt: '2026-10-10T08:00:00Z' }, undefined, 'op-dup');
    await localDb.pendingOps.put({
      opId: 'op-poison',
      name: 'totally-unknown' as never,
      payload: {},
      createdAt: new Date().toISOString(),
      retries: 0,
    });
    vi.stubGlobal('navigator', { onLine: true });
    const r = await replayPendingOps(repos);
    expect(await localDb.pendingOps.count()).toBe(0);
    expect(r.done).toBe(1); // 同 opId 两条只算一条队列记录（put 幂等），成功 1
    expect(r.failed).toBe(1); // 毒丸被移除并计失败
    const h0 = await repos.hit.getHit(hitFixture(0).id);
    expect(h0?.status).toBe('done');
  });

  it('部分失败：hit 不存在 → failOp 留队列重试，不影响其余', async () => {
    for (let i = 0; i < 3; i++) {
      await enqueueOp('hit.complete', { hitId: hitFixture(i).id, completedAt: '2026-10-10T08:00:00Z' });
    }
    await enqueueOp('hit.complete', { hitId: 'missing-hit', completedAt: '2026-10-10T08:00:00Z' });
    vi.stubGlobal('navigator', { onLine: true });
    const r = await replayPendingOps(repos);
    expect(r.done).toBe(3);
    expect(r.failed).toBe(1);
    const remaining = (await localDb.pendingOps.toArray()) as PendingOp[];
    expect(remaining.length).toBe(1);
    expect(remaining[0].opId).toBeDefined();
    expect(remaining[0].payload['hitId']).toBe('missing-hit');
    expect(remaining[0].retries).toBe(1);
  });
});

/**
 * C1/C2（用户 2026-10-18）：轮标线归零与云端音频回传都改走离线队列——
 * 旧实现分别是 try/catch 静默吞 与 void 即发即忘，失败即永久丢失。
 */
describe('离线补传：bookWord.roundReset / audio.upload（2026-10-18 C1/C2）', () => {
  let repos: Repos;
  let mockDb: MockDb;

  beforeEach(async () => {
    vi.stubGlobal('navigator', { onLine: true });
    mockDb = new MockDb();
    repos = createToolContext(mockDb).repos as unknown as Repos;
    await localDb.pendingOps.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seedBookWords(rows: Record<string, unknown>[]): void {
    mockDb.tables.set('book_words', rows);
  }

  it('bookWord.roundReset：补传归零轮标线；skipAnsweredSince 之后的词不误伤', async () => {
    seedBookWords([
      { id: 'bw_0', bookId: 'b1', wordId: 'w0', listNo: 1, orderInList: 1, tier: 2, status: 'normal', quizDayStreak: 2, quizDayPassed: true, lastQuizAt: '2026-10-18T09:00:00.000Z' },
      { id: 'bw_1', bookId: 'b1', wordId: 'w1', listNo: 1, orderInList: 2, tier: 3, status: 'normal', quizDayStreak: 1, quizDayPassed: false, lastQuizAt: '2026-10-18T10:30:00.000Z' },
    ]);
    await enqueueOp('bookWord.roundReset', { ids: ['bw_0', 'bw_1'], since: '2026-10-18T10:00:00.000Z' });

    const r = await replayPendingOps(repos);
    expect(r.done).toBe(1);
    expect(r.failed).toBe(0);
    expect(await localDb.pendingOps.count()).toBe(0);

    const rows = await repos.word.listBookWords('b1');
    expect(rows.find((x) => x.id === 'bw_0')!.quizDayStreak).toBe(0);
    expect(rows.find((x) => x.id === 'bw_0')!.quizDayPassed).toBe(false);
    expect(rows.find((x) => x.id === 'bw_1')!.quizDayStreak).toBe(1); // 入队后又答过 → 不归零
  });

  it('audio.upload：无 CacheStorage（node 环境）→ 取不到字节直接出队，不卡队列', async () => {
    await enqueueOp('audio.upload', { cloudPath: 'shared/u1/tts-audio/longhuhu/abc.mp3', cacheKey: 'v2|k' });
    const r = await replayPendingOps(repos);
    expect(r.done).toBe(1);
    expect(r.failed).toBe(0);
    expect(await localDb.pendingOps.count()).toBe(0);
  });

  it('audio.upload：payload 缺字段 → 抛错留队列重试（不当毒丸静默丢弃）', async () => {
    await enqueueOp('audio.upload', { cloudPath: 'shared/u1/tts-audio/x.mp3' }); // 缺 cacheKey
    const r = await replayPendingOps(repos);
    expect(r.done).toBe(0);
    expect(r.failed).toBe(1);
    const remaining = (await localDb.pendingOps.toArray()) as PendingOp[];
    expect(remaining.length).toBe(1);
    expect(remaining[0].retries).toBe(1);
    expect(remaining[0].lastError).toContain('cacheKey');
  });
});
