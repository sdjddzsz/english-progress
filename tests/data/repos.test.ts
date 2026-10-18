/**
 * repos.test.ts —— 数据访问层基本读写：
 * - Repository CRUD 走内存 mock 云数据库（supabase-js 风格构建器）；
 * - Dexie 本地镜像 / 离线队列走 fake-indexeddb；
 * - hit 确定性 ID 幂等 upsert；稳固信号聚合。
 * 云 SDK 适配器（真实 cloud.database）以接口 mock 覆盖——云环境激活后由 T05 集成回验。
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Repository, type CloudDatabaseLike, type PostgrestQuery } from '../../src/data/repository';
import { createHitRepo } from '../../src/data/repos/hitRepo';
import { createFeedbackRepo } from '../../src/data/repos/feedbackRepo';
import { createWordRepo, ID_BATCH } from '../../src/data/repos/wordRepo';
import { createPlanRepo } from '../../src/data/repos/planRepo';
import { hitDeterministicId } from '../../src/data/collections';
import { localDb } from '../../src/data/localDb';
import { enqueueOp, takePendingOps, resolveOp } from '../../src/data/queue';
import type { Hit, Tier } from '../../src/types/domain';
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

// ===== wordRepo.listWordsByIds 分片（URL 长度保护）=====
//
// 背景（用户实测阻断性 bug）：摸底页把全书 5407 个 wordId 一次性交给 `id=in.(…)`，
// URL ≈ 82,121 字符（SDK `urlLengthLimit` 是 8000，且它**只给错误附 hint、不切 POST 也不拦截**）
// ⇒ 浏览器报 `TypeError: Failed to fetch`。修法是把该查询在 repo 边界分片。

/**
 * 记录每次 `in(col, values)` 的 values 长度（其余调用透传给 MockDb）。
 * 用 Proxy 逐层重包：MockQuery 的链式方法**返回自身**，不在每次调用后重包就会在 `.select()` 之后漏记。
 */
class RecordingDb implements CloudDatabaseLike {
  readonly inSizes: number[] = [];
  constructor(private readonly inner: MockDb) {}
  from(table: string): PostgrestQuery {
    const wrap = (target: object): PostgrestQuery =>
      new Proxy(target, {
        get: (t, prop: PropertyKey) => {
          const v = (t as Record<PropertyKey, unknown>)[prop];
          if (typeof v !== 'function') return v;
          return (...args: unknown[]) => {
            if (prop === 'in') this.inSizes.push((args[1] as unknown[]).length);
            const r = (v as (...a: unknown[]) => unknown).apply(t, args);
            return r === t ? wrap(t) : r;
          };
        },
      }) as PostgrestQuery;
    return wrap(this.inner.from(table));
  }
}

/**
 * 种子派生的真值 —— **不得硬编码**，否则守门用例会退化成"一张写着数字的纸条"：
 * 将来种子出现更长 lemma 时它不会红，也就没人被迫重新推导 `ID_BATCH`。
 *
 * 两个种子文件都要看：线上 `book_words` 由 `src/data/seed/seed-cet6.json` 生成
 * （`deploy/gen-seed-sql.mjs`），而应用重新导入时 fetch 的是 `public/seed-cet6.json`；
 * 两者内容并不相同（md5 不同），故取**两者最大值** —— 谁变长都会重新报警。
 */
const SEED_FILES = ['public/seed-cet6.json', 'src/data/seed/seed-cet6.json'] as const;
const SEED_LEMMAS: string[] = SEED_FILES.flatMap((file) =>
  (JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8')) as { lemma: string }[]).map((w) => w.lemma),
);
/** 真实 id（`seedToDocs` 的 id 约定：`word_<lemma>`），去重后即摸底页会传入的全集 */
const SEED_IDS = [...new Set(SEED_LEMMAS.map((lemma) => `word_${lemma}`))];
const LONGEST_ID = SEED_IDS.reduce((a, b) => (b.length > a.length ? b : a), '');
/** 本仓已核对过的最长 lemma 长度；一旦超出 ⇒ 必须重新推导 ID_BATCH（由下一条断言强制） */
const KNOWN_MAX_LEMMA_LEN = 21;

describe('wordRepo.listWordsByIds 分片（URL 长度保护）', () => {
  const N = SEED_IDS.length; // 真实规模（由种子派生）

  function seeded(): RecordingDb {
    const db = new MockDb();
    db.tables.set(
      'words',
      SEED_IDS.map((id, i) => ({ id, lemma: id, ipa: '', senses: [], examples: [], frequency: i, tags: [] })),
    );
    return new RecordingDb(db);
  }

  it(`${N} 个真实 id → 切成多批（每批 ≤ ID_BATCH）、合并正确、无重复无遗漏`, async () => {
    const rec = seeded();
    const repo = createWordRepo(rec);
    const out = await repo.listWordsByIds(SEED_IDS);

    expect(rec.inSizes.length).toBe(Math.ceil(N / ID_BATCH));
    expect(Math.max(...rec.inSizes)).toBeLessThanOrEqual(ID_BATCH); // 每批不超过上界
    expect(rec.inSizes.reduce((a, b) => a + b, 0)).toBe(N); // 每个 id 恰好被覆盖一次
    expect(out.length).toBe(N); // 无遗漏
    expect(new Set(out.map((w) => w.id))).toEqual(new Set(SEED_IDS));
    expect(out.length).toBe(new Set(out.map((w) => w.id)).size); // 无重复
  });

  it('入参重复 id 先去重：按去重后数量分片，输出无重复', async () => {
    const rec = seeded();
    const repo = createWordRepo(rec);
    const dup = [SEED_IDS[0], SEED_IDS[0], SEED_IDS[1], SEED_IDS[1], SEED_IDS[2]];
    const out = await repo.listWordsByIds(dup);

    expect(rec.inSizes).toEqual([3]); // 去重后 3 个 → 单批
    expect(out.map((w) => w.id).sort()).toEqual([SEED_IDS[0], SEED_IDS[1], SEED_IDS[2]].sort());
  });

  it('空入参不发任何请求', async () => {
    const rec = seeded();
    const repo = createWordRepo(rec);
    expect(await repo.listWordsByIds([])).toEqual([]);
    expect(rec.inSizes).toEqual([]);
  });

  it('前提自检：两个种子文件内最长 lemma 长度 ≤ 已知值 —— 超出必须重新推导 ID_BATCH', () => {
    expect(LONGEST_ID.length - 'word_'.length).toBeLessThanOrEqual(KNOWN_MAX_LEMMA_LEN);
  });

  it('单批最坏 URL 远低于 urlLengthLimit(8000)：改大 ID_BATCH、或种子出现更长 lemma，都会让本条失败', () => {
    const BASE = 'https://english-progress.app.workbuddy.host/.cloud/database/rest/words?select=*&id=in.(';
    const worstUrl = (longestIdLen: number): number => BASE.length + ID_BATCH * (longestIdLen + 3) + 1;
    expect(worstUrl(LONGEST_ID.length)).toBeLessThan(8_000); // 请求行上限
    expect(worstUrl(LONGEST_ID.length)).toBeLessThanOrEqual(3_000); // 保留 ~3 倍余量（目标 ≤3KB）
    // 自更新的敏感性证明：同一公式对「更长的 id」会变红（当前 lemma ≤26 字符才守得住 3KB 余量）
    expect(worstUrl(30)).toBeGreaterThan(3_000);
  });
});

/**
 * updateWordTiers —— 摸底分层必须**批量**写（2026-10-13 线上「摸底分层 Failed to fetch」）：
 * 一次摸底 ~300 条 assignments，逐条 `updateWordTier` 就是 ~300 个串行请求，
 * 网关/连接一扛不住就整段 `Failed to fetch`，而且前面写过的已经落库、重试还会重复写。
 */
describe('wordRepo.updateWordTiers 批量改层（不是逐条 update）', () => {
  function seeded(n: number): { db: MockDb; rec: RecordingDb } {
    const db = new MockDb();
    db.tables.set(
      'book_words',
      Array.from({ length: n }, (_, i) => ({
        id: `bw_${i}`,
        bookId: 'b1',
        wordId: `word_${i}`,
        listNo: Math.floor(i / 50) + 1,
        orderInList: (i % 50) + 1,
        tier: 4,
        status: 'normal',
      })),
    );
    return { db, rec: new RecordingDb(db) };
  }

  it('300 条：按 id 分片读（3 批）+ 批量写，整体写完 300 条', async () => {
    const { rec } = seeded(300);
    const repo = createWordRepo(rec);
    const done = await repo.updateWordTiers(
      Array.from({ length: 300 }, (_, i) => ({ bookWordId: `bw_${i}`, tier: ((i % 4) + 1) as Tier })),
    );

    expect(done).toBe(300);
    // 读：ceil(300/100)=3 批；**不是** 300 次单条请求
    expect(rec.inSizes.length).toBe(3);
    expect(Math.max(...rec.inSizes)).toBeLessThanOrEqual(ID_BATCH);
    expect(rec.inSizes.reduce((a, b) => a + b, 0)).toBe(300);
  });

  it('层真的写进去了（读回校验，不只是"请求数变少"）', async () => {
    const { rec } = seeded(300);
    const repo = createWordRepo(rec);
    await repo.updateWordTiers([
      { bookWordId: 'bw_0', tier: 1 as Tier },
      { bookWordId: 'bw_1', tier: 3 as Tier },
    ]);
    const rows = await repo.listBookWords('b1');
    expect(rows.find((r) => r.id === 'bw_0')?.tier).toBe(1);
    expect(rows.find((r) => r.id === 'bw_1')?.tier).toBe(3);
    expect(rows.find((r) => r.id === 'bw_2')?.tier).toBe(4); // 没点到的一律不动
  });

  it('同一 id 重复出现以最后一条为准（同 lemma 多义项共享一条 book_word）', async () => {
    const { rec } = seeded(3);
    const repo = createWordRepo(rec);
    await repo.updateWordTiers([
      { bookWordId: 'bw_1', tier: 2 as Tier },
      { bookWordId: 'bw_1', tier: 3 as Tier },
    ]);
    const rows = await repo.listBookWords('b1');
    expect(rows.find((r) => r.id === 'bw_1')?.tier).toBe(3);
    expect(rec.inSizes).toEqual([1]); // 去重后只读 1 条
  });

  it('空入参 / id 不存在：不写无谓请求、返回 0', async () => {
    const { rec } = seeded(3);
    const repo = createWordRepo(rec);
    expect(await repo.updateWordTiers([])).toBe(0);
    expect(rec.inSizes).toEqual([]);
    expect(await repo.updateWordTiers([{ bookWordId: 'nope', tier: 2 as Tier }])).toBe(0);
  });
});

/**
 * resetRoundStreaks —— 新一轮开局轮标线归零（用户 2026-10-18）。
 * C1（2026-10-18）：旧实现收调用方的行、try/catch 静默吞失败 ⇒ 断网时云端残留旧值。
 * 现在按 id 读回原行只改两列（同 updateWordTiers 打法），并由 runOrQueue 入队补传；
 * skipAnsweredSince 防止补传把「入队后又答过题」的词误归零。
 */
describe('wordRepo.resetRoundStreaks 轮标线归零（读回原行→只改两列）', () => {
  function seeded(rows: Record<string, unknown>[]): { rec: RecordingDb } {
    const db = new MockDb();
    db.tables.set('book_words', rows);
    return { rec: new RecordingDb(db) };
  }

  const bw = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'bw_0',
    bookId: 'b1',
    wordId: 'word_0',
    listNo: 1,
    orderInList: 1,
    tier: 2,
    streak: 5,
    failStreak: 1,
    specialTraining: false,
    status: 'normal',
    quizDayStreak: 0,
    quizDayPassed: false,
    stage: 1,
    stageStreak: 2,
    ...over,
  });

  it('只归零真有计数/过关标记的行，其它列以云端现值为基底不动', async () => {
    const { rec } = seeded([
      bw({ id: 'bw_0', quizDayStreak: 2, quizDayPassed: false, tier: 2, streak: 5, stageStreak: 2 }),
      bw({ id: 'bw_1', quizDayStreak: 0, quizDayPassed: false }),
      bw({ id: 'bw_2', quizDayStreak: 0, quizDayPassed: true }),
    ]);
    const repo = createWordRepo(rec);
    expect(await repo.resetRoundStreaks(['bw_0', 'bw_1', 'bw_2'])).toBe(2);
    const rows = await repo.listBookWords('b1');
    const r0 = rows.find((r) => r.id === 'bw_0')!;
    expect(r0.quizDayStreak).toBe(0);
    expect(r0.quizDayPassed).toBe(false);
    // 读回基底：频率/毕业列不许被开局快照写旧
    expect(r0.tier).toBe(2);
    expect(r0.streak).toBe(5);
    expect(r0.stageStreak).toBe(2);
    expect(rows.find((r) => r.id === 'bw_1')!.quizDayStreak).toBe(0); // 本就 0，不写
  });

  it('skipAnsweredSince：入队后又答过题的词不归零（作答写回才是权威）', async () => {
    const since = '2026-10-18T10:00:00.000Z';
    const { rec } = seeded([
      bw({ id: 'bw_0', quizDayStreak: 1, lastQuizAt: '2026-10-18T09:00:00.000Z' }), // 答于入队前 → 归零
      bw({ id: 'bw_1', quizDayStreak: 1, lastQuizAt: '2026-10-18T10:30:00.000Z' }), // 答于入队后 → 不动
      bw({ id: 'bw_2', quizDayStreak: 1, lastQuizAt: undefined }), // 从未答过 → 归零
    ]);
    const repo = createWordRepo(rec);
    expect(await repo.resetRoundStreaks(['bw_0', 'bw_1', 'bw_2'], { skipAnsweredSince: since })).toBe(2);
    const rows = await repo.listBookWords('b1');
    expect(rows.find((r) => r.id === 'bw_0')!.quizDayStreak).toBe(0);
    expect(rows.find((r) => r.id === 'bw_1')!.quizDayStreak).toBe(1); // 保留
    expect(rows.find((r) => r.id === 'bw_2')!.quizDayStreak).toBe(0);
  });

  it('空入参 / id 不存在：不发请求、返回 0', async () => {
    const { rec } = seeded([bw({ id: 'bw_0', quizDayStreak: 2 })]);
    const repo = createWordRepo(rec);
    expect(await repo.resetRoundStreaks([])).toBe(0);
    expect(rec.inSizes).toEqual([]);
    expect(await repo.resetRoundStreaks(['nope'])).toBe(0);
  });
});
