/**
 * repos.test.ts —— 数据访问层基本读写：
 * - Repository CRUD 走内存 mock 云数据库（supabase-js 风格构建器）；
 * - Dexie 本地镜像 / 离线队列走 fake-indexeddb；
 * - hit 确定性 ID 幂等 upsert；稳固信号聚合。
 * 云 SDK 适配器（真实 cloud.database）以接口 mock 覆盖——云环境激活后由 T05 集成回验。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/data/repository';
import { createHitRepo } from '../../src/data/repos/hitRepo';
import { createFeedbackRepo } from '../../src/data/repos/feedbackRepo';
import { createWordRepo } from '../../src/data/repos/wordRepo';
import { createPlanRepo } from '../../src/data/repos/planRepo';
import { hitDeterministicId } from '../../src/data/collections';
import { localDb } from '../../src/data/localDb';
import { enqueueOp, takePendingOps, resolveOp } from '../../src/data/queue';
import type { Hit } from '../../src/types/domain';
import { MockDb } from '../helpers/mockDb';

// ===== Repository CRUD =====

interface Doc {
  id: string;
  name: string;
  tier: number;
  createdAt: string;
}

describe('Repository（mock 云数据库）', () => {
  let db: MockDb;
  let repo: Repository<Doc>;

  beforeEach(() => {
    db = new MockDb();
    repo = new Repository<Doc>(db, 'books');
  });

  it('insert → getById → update → list(filters) → remove', async () => {
    const created = await repo.insert({ name: '六级全量', tier: 4, createdAt: '2026-10-11T00:00:00Z' });
    expect(created.id).toBeTruthy();
    expect((await repo.getById(created.id))?.name).toBe('六级全量');

    const updated = await repo.update(created.id, { name: '六级全量 V2' });
    expect(updated?.name).toBe('六级全量 V2');

    await repo.insert({ name: '自建词书', tier: 2, createdAt: '2026-10-12T00:00:00Z' });
    const all = await repo.list([], { orderBy: 'createdAt' });
    expect(all.length).toBe(2);
    const filtered = await repo.list([{ column: 'tier', op: 'gte', value: 3 }]);
    expect(filtered.length).toBe(1);
    const inFilter = await repo.list([{ column: 'id', op: 'in', values: [created.id, 'nope'] }]);
    expect(inFilter.length).toBe(1);

    expect(await repo.remove(created.id)).toBe(true);
    expect(await repo.getById(created.id)).toBeNull();
    expect(await repo.remove(created.id)).toBe(false);
  });

  it('update 0 行受影响 → 返回 null（RLS 拦截/不存在不是成功）', async () => {
    expect(await repo.update('missing', { name: 'x' })).toBeNull();
  });

  it('upsertMany 幂等（hit 确定性 ID 去重）', async () => {
    const doc = { id: 'p1_w1_2_2026-10-12', name: 'hit', tier: 1, createdAt: '' };
    await repo.upsertMany([doc]);
    await repo.upsertMany([{ ...doc, name: 'hit-v2' }]);
    const rows = await repo.list();
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('hit-v2');
  });
});

// ===== hitRepo：确定性 ID + 当日镜像 + 离线队列 =====

function mkHit(over: Partial<Hit> = {}): Hit {
  const id = hitDeterministicId('p1', 'word_a', 2, '2026-10-12');
  return {
    id,
    planId: 'p1',
    wordId: 'word_a',
    userId: 'u1',
    tier: 3,
    roundNo: 2,
    listNo: 1,
    scheduledDate: '2026-10-12',
    modality: 'audio',
    status: 'pending',
    explain: { roundIdxInWindow: 1 },
    ...over,
  };
}

describe('hitRepo（mock 云 + fake-indexeddb）', () => {
  let db: MockDb;

  beforeEach(async () => {
    db = new MockDb();
    await localDb.hitsToday.clear();
    await localDb.pendingOps.clear();
  });

  it('确定性 ID 格式 {planId}_{wordId}_{roundNo}_{scheduledDate}', () => {
    expect(hitDeterministicId('p1', 'w1', 2, '2026-10-12')).toBe('p1_w1_2_2026-10-12');
  });

  it('upsertHits 幂等：重复写入不产生重复行', async () => {
    const repo = createHitRepo(db);
    const h = mkHit();
    await repo.upsertHits([h]);
    await repo.upsertHits([{ ...h, status: 'done' }]);
    const rows = await repo.hits.list([{ column: 'planId', op: 'eq', value: 'p1' }]);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('done');
  });

  it('getOverdueHits 只取 pending/overdue 且日期早于 beforeDate', async () => {
    const repo = createHitRepo(db);
    await repo.upsertHits([
      mkHit({ id: 'h1', wordId: 'w1', scheduledDate: '2026-10-10', status: 'pending' }),
      mkHit({ id: 'h2', wordId: 'w2', scheduledDate: '2026-10-10', status: 'done' }),
      mkHit({ id: 'h3', wordId: 'w3', scheduledDate: '2026-10-11', status: 'overdue' }),
      mkHit({ id: 'h4', wordId: 'w4', scheduledDate: '2026-10-12', status: 'pending' }),
    ]);
    const overdue = await repo.getOverdueHits('p1', '2026-10-12');
    expect(overdue.map((h) => h.id).sort()).toEqual(['h1', 'h3']);
  });

  it('completeHit：云端更新 + 本地镜像同步', async () => {
    const repo = createHitRepo(db);
    // 当日镜像只写 scheduledDate >= 今天 的行（历史不镜像）——用动态「今天」避免硬编码日期随系统时钟过期。
    const today = new Date().toISOString().slice(0, 10);
    const h = mkHit({ scheduledDate: today });
    await repo.upsertHits([h]);
    const res = await repo.completeHit(h.id, '2026-10-12T08:00:00Z');
    expect(res).toBe('ran');
    const after = await repo.getHit(h.id);
    expect(after?.status).toBe('done');
    expect(after?.completedAt).toBe('2026-10-12T08:00:00Z');
    const mirrored = await localDb.hitsToday.get(h.id);
    expect(mirrored?.status).toBe('done');
  });

  it('本地镜像与离线队列：入队 → 取出 → 消费', async () => {
    const repo = createHitRepo(db);
    await repo.mirrorToday([mkHit(), mkHit({ id: 'h2', wordId: 'w2' })]);
    expect((await repo.readTodayMirror()).length).toBe(2);
    await repo.clearTodayMirror();
    expect((await repo.readTodayMirror()).length).toBe(0);

    await enqueueOp('feedback.create', { hitId: 'h1' });
    const ops = await takePendingOps();
    expect(ops.length).toBe(1);
    expect(ops[0].name).toBe('feedback.create');
    await resolveOp(ops[0].opId);
    expect((await takePendingOps()).length).toBe(0);
  });
});

// ===== feedbackRepo：稳固信号聚合 =====

describe('feedbackRepo 稳固聚合（PRD §4.4.4 判定）', () => {
  it('秒认≥2 + 无 L2 + 听觉识别≥1 → steady；否则不稳固', () => {
    const db = new MockDb();
    const repo = createFeedbackRepo(db);
    const fb = (wordId: string, l1: 'instant' | 'recognized', modality: 'visual' | 'audio', l2: string[] = []) => ({
      id: `${wordId}_${modality}_${Math.random()}`,
      hitId: `h_${wordId}`,
      sessionId: 's1',
      wordId,
      userId: 'u1',
      l1State: l1,
      reactionMs: 500,
      l2Tags: l2 as never,
      l3Actions: [],
      modality,
      roundNo: 1,
      tier: 3 as const,
      device: 'mobile' as const,
      createdAt: '2026-10-12T08:00:00Z',
    });
    const steady = repo.aggregateSteadiness([
      fb('a', 'instant', 'visual'),
      fb('a', 'instant', 'visual'),
      fb('a', 'recognized', 'audio'),
      fb('b', 'instant', 'visual'),
      fb('b', 'instant', 'visual'), // 缺听觉识别
      fb('c', 'instant', 'visual'),
      fb('c', 'instant', 'audio', ['形近词混淆']), // 有 L2
    ]);
    const map = new Map(steady.map((s) => [s.wordId, s]));
    expect(map.get('a')?.steady).toBe(true);
    expect(map.get('b')?.steady).toBe(false);
    expect(map.get('c')?.steady).toBe(false);
  });
});

// ===== planRepo / wordRepo 基本读写 =====

describe('planRepo / wordRepo 基本读写（mock 云）', () => {
  it('plan 版本与轮次替换', async () => {
    const db = new MockDb();
    const repo = createPlanRepo(db);
    const plan = await repo.createPlan({
      bookId: 'b1',
      userId: 'u1',
      tierRounds: { 1: 2, 2: 2, 3: 3, 4: 3 },
      planMode: 'recommended',
      startDate: '2026-10-11',
      deadlineDate: '2026-12-05',
      sprintStartDate: '2026-12-05',
      dailyBudgetMin: 60,
      avgHitSec: 12,
      gapMinDays: 0,
      modalRatio: { 1: 0.7, 2: 0.5, 3: 0.3, 4: 0.2 },
      masteryDecayEnabled: true,
      version: 1,
      status: 'active',
      createdAt: '2026-10-11T00:00:00Z',
    });
    expect((await repo.getActivePlan('b1'))?.id).toBe(plan.id);
    await repo.savePlanVersion({
      planId: plan.id,
      versionNo: 1,
      snapshot: { tierRounds: plan.tierRounds },
      changedBy: 'user',
      reason: '初始创建',
      diffSummary: 'create',
      createdAt: '2026-10-11T00:00:00Z',
    });
    expect((await repo.listPlanVersions(plan.id)).length).toBe(1);
    await repo.replaceRounds(plan.id, [{ planId: plan.id, tier: 3, roundNo: 1, startDate: '2026-10-11', endDate: '2026-10-29', coverageTarget: 20, coveredCount: 0, status: 'pending' }]);
    expect((await repo.listRounds(plan.id)).length).toBe(1);
  });

  it('word 分层查询与 tier 更新', async () => {
    const db = new MockDb();
    const repo = createWordRepo(db);
    await repo.upsertWords([
      { id: 'w1', lemma: 'accommodate', ipa: '/əˈkɒm.ə.deɪt/', senses: [], examples: [], frequency: 12013, tags: ['cet6'] },
      { id: 'w2', lemma: 'bias', ipa: '/ˈbaɪ.əs/', senses: [], examples: [], frequency: 8642, tags: ['cet6'] },
    ] as never);
    await repo.upsertBookWords([
      { id: 'bw1', bookId: 'b1', wordId: 'w1', listNo: 1, orderInList: 1, tier: 3, tierUpdatedAt: '', status: 'normal' },
      { id: 'bw2', bookId: 'b1', wordId: 'w2', listNo: 1, orderInList: 2, tier: 2, tierUpdatedAt: '', status: 'normal' },
    ] as never);
    const t3 = await repo.listBookWords('b1', { tier: 3 });
    expect(t3.map((r) => r.wordId)).toEqual(['w1']);
    const updated = await repo.updateWordTier('bw1', 2);
    expect(updated?.tier).toBe(2);
    expect((await repo.getWordByLemma('bias'))?.id).toBe('w2');
  });
});
