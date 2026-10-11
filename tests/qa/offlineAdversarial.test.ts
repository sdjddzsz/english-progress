/**
 * qa/offlineAdversarial.test.ts —— QA 独立对抗性验证：离线补传（架构 §1.7 / S30）。
 * - 重复 op_id 交错到达：幂等去重，重放无二次副作用；
 * - 补传中单条反复失败：不阻塞其余 op，retries 递增；
 * - 未知操作名毒丸：直接移除不阻塞；
 * - 断网状态：replay 不取队列。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDb } from '../helpers/mockDb';
import { createToolContext } from '../helpers/toolContext';
import { localDb } from '../../src/data/localDb';
import { enqueueOp, takePendingOps } from '../../src/data/queue';
import { replayPendingOps } from '../../src/offline/syncManager';
import type { Repos } from '../../src/store/useAppStore';
import type { Hit } from '../../src/types/domain';

function hitFixture(i: number, status: Hit['status'] = 'pending'): Hit {
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
    status,
    explain: { roundIdxInWindow: 0 },
  };
}

describe('离线补传对抗', () => {
  let repos: Repos;

  beforeEach(async () => {
    vi.stubGlobal('navigator', { onLine: true });
    repos = createToolContext(new MockDb()).repos as unknown as Repos;
    await localDb.pendingOps.clear();
    await repos.hit.hits.upsertMany(
      [hitFixture(1), hitFixture(2), hitFixture(3)] as unknown as (Hit & Record<string, unknown>)[],
    );
  });

  it('同一 op_id 交错重复到达（入队两次）：队列只保留一条，重放一次', async () => {
    await enqueueOp('hit.complete', { hitId: 'p1_w1_1_2026-10-10', completedAt: '2026-10-10T10:00:00Z' }, undefined, 'dup-op-1');
    await enqueueOp('hit.complete', { hitId: 'p1_w1_1_2026-10-10', completedAt: '2026-10-10T11:00:00Z' }, undefined, 'dup-op-1');
    const ops = await takePendingOps(100);
    expect(ops.length).toBe(1);
    const r = await replayPendingOps(repos);
    expect(r).toMatchObject({ done: 1, failed: 0, drained: true });
    const hits = await repos.hit.hits.list([{ column: 'id', op: 'eq', value: 'p1_w1_1_2026-10-10' }]);
    expect((hits[0] as Hit).status).toBe('done');
    expect(await takePendingOps(100)).toHaveLength(0);
  });

  it('重放后同 op_id 再次到达（跨设备重复补传）：update 幂等无副作用，不产生重复行', async () => {
    await enqueueOp('hit.complete', { hitId: 'p1_w1_1_2026-10-10', completedAt: '2026-10-10T10:00:00Z' }, undefined, 'x-op-1');
    expect((await replayPendingOps(repos)).done).toBe(1);
    // 交错：另一设备同 op_id 重发
    await enqueueOp('hit.complete', { hitId: 'p1_w1_1_2026-10-10', completedAt: '2026-10-10T10:00:00Z' }, undefined, 'x-op-1');
    expect((await replayPendingOps(repos)).done).toBe(1);
    const hits = await repos.hit.hits.list([{ column: 'planId', op: 'eq', value: 'p1' }]);
    expect(hits.filter((h) => h.wordId === 'w1')).toHaveLength(1); // 无重复行
  });

  it('单条 op 反复失败（目标行缺失）：不阻塞其余 op，retries 递增、op 留在队列', async () => {
    await enqueueOp('hit.complete', { hitId: 'ghost-hit', completedAt: 'x' }, undefined, 'bad-op'); // 云端无此行
    await enqueueOp('hit.complete', { hitId: 'p1_w2_1_2026-10-10', completedAt: 'x' }, undefined, 'good-op');
    const r1 = await replayPendingOps(repos);
    expect(r1).toMatchObject({ done: 1, failed: 1 });
    const ops1 = await takePendingOps(100);
    expect(ops1.map((o) => o.opId)).toEqual(['bad-op']);
    expect(ops1[0].retries).toBe(1);
    // 再跑一次仍失败，retries=2，good op 不受影响
    const r2 = await replayPendingOps(repos);
    expect(r2.failed).toBe(1);
    const ops2 = await takePendingOps(100);
    expect(ops2[0].retries).toBe(2);
    expect(ops2[0].lastError).toContain('ghost-hit');
  });

  it('未知操作名毒丸：直接移除，不永久阻塞队列', async () => {
    await localDb.pendingOps.put({ opId: 'poison', name: 'mystery.op' as never, payload: { x: 1 }, createdAt: '2026-10-10T00:00:00Z', retries: 0 });
    await localDb.pendingOps.put({ opId: 'after-poison', name: 'hit.complete', payload: { hitId: 'p1_w3_1_2026-10-10', completedAt: 'x' }, createdAt: '2026-10-10T00:01:00Z', retries: 0 });
    const r = await replayPendingOps(repos);
    expect(r.failed).toBe(1);
    expect(r.done).toBe(1);
    const left = await takePendingOps(100);
    expect(left.map((o) => o.opId)).toEqual([]); // 毒丸被移除
  });

  it('断网时 replayPendingOps 直接返回，不消费队列', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await enqueueOp('hit.complete', { hitId: 'p1_w1_1_2026-10-10', completedAt: 'x' }, undefined, 'offline-op');
    const r = await replayPendingOps(repos);
    expect(r).toEqual({ done: 0, failed: 0, drained: false });
    expect((await takePendingOps(100))).toHaveLength(1);
  });

  it('多种 op 类型交错按 createdAt 顺序重放', async () => {
    await enqueueOp('hit.status', { hitId: 'p1_w1_1_2026-10-10', status: 'overdue' }, undefined, 'op-a');
    await enqueueOp('hit.complete', { hitId: 'p1_w2_1_2026-10-10', completedAt: 'x' }, undefined, 'op-b');
    const r = await replayPendingOps(repos);
    expect(r).toMatchObject({ done: 2, failed: 0 });
    const hits = await repos.hit.hits.list([{ column: 'planId', op: 'eq', value: 'p1' }]);
    const byId = new Map(hits.map((h) => [(h as Hit).id, (h as Hit).status]));
    expect(byId.get('p1_w1_1_2026-10-10')).toBe('overdue');
    expect(byId.get('p1_w2_1_2026-10-10')).toBe('done');
  });
});
