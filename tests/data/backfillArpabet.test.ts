/**
 * backfillArpabet.test.ts —— T8 单测：Map 构建 / patch 计算 / 空 seed / 全未命中 / 幂等重跑同结果。
 * mock repo + mock fetch（架构增量 §八）。断言依据：§六 T8 验收 + §5.5。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  backfillArpabetFromSeed,
  buildArpabetMap,
  computeWordPatch,
  type BackfillRepo,
  type BackfillResult,
  type SeedEntry,
} from '../../src/data/backfillArpabet';
import { CET6_BOOK_ID } from '../../src/data/seedBootstrap';
import type { BookWord, Word } from '../../src/types/domain';

// ===== 纯函数 =====

describe('buildArpabetMap', () => {
  it('跳过无 arpabet 的未命中条目；lemma 统一 trim+小写', () => {
    const map = buildArpabetMap([
      { lemma: 'Academy', arpabet: 'AH0 K AE1 D AH0 M IY0' },
      { lemma: 'wilful' }, // 无 arpabet
      { lemma: ' eagle ', arpabet: 'IY1 G AH0 L' },
    ]);
    expect(map.size).toBe(2);
    expect(map.get('academy')).toBe('AH0 K AE1 D AH0 M IY0');
    expect(map.get('eagle')).toBe('IY1 G AH0 L');
    expect(map.has('wilful')).toBe(false);
  });
});

describe('computeWordPatch', () => {
  const map = buildArpabetMap([{ lemma: 'academy', arpabet: 'AH0 K AE1 D AH0 M IY0' }]);
  const word = (lemma: string): Word => ({ id: `word_${lemma}`, lemma, ipa: '/old/', senses: [], examples: [], frequency: 0, tags: [] });

  it('命中：arpabet 原值 + 派生 ipa', () => {
    expect(computeWordPatch(word('academy'), map)).toEqual({ arpabet: 'AH0 K AE1 D AH0 M IY0', ipa: '/ə.ˈkæ.də.mi/' });
  });

  it('未命中 → null', () => {
    expect(computeWordPatch(word('zzz'), map)).toBeNull();
  });

  it('音素非法 → null（保留原 ipa）', () => {
    const bad = buildArpabetMap([{ lemma: 'bad', arpabet: 'XY1 Z' }]);
    expect(computeWordPatch(word('bad'), bad)).toBeNull();
  });
});

// ===== mock repo（内存云，支持跨调用读回）=====

function mkWord(lemma: string, over: Partial<Word> = {}): Word {
  return { id: `word_${lemma}`, lemma, ipa: `/${lemma}-ecd/`, senses: [], examples: [], frequency: 1, tags: ['cet6'], ...over };
}

function mkBookWord(wordId: string, i: number): BookWord {
  return { id: `bw_${i}`, bookId: CET6_BOOK_ID, wordId, listNo: 1, orderInList: i + 1, tier: 3, tierUpdatedAt: '', status: 'normal', streak: 0, failStreak: 0, specialTraining: false, quizDayStreak: 0, quizDayPassed: false };
}

function mkRepo(seedWords: Word[]): { repo: BackfillRepo; store: Map<string, Word>; upsertLog: (Word & Record<string, unknown>)[][] } {
  const store = new Map<string, Word>(seedWords.map((w) => [w.id, w]));
  const bookWords = seedWords.map((w, i) => mkBookWord(w.id, i));
  const upsertLog: (Word & Record<string, unknown>)[][] = [];
  const repo: BackfillRepo = {
    listBookWords: async () => bookWords,
    listWordsByIds: async (ids) => ids.map((id) => store.get(id)).filter((w): w is Word => Boolean(w)),
    upsertWords: async (rows) => {
      upsertLog.push(rows.map((r) => ({ ...r })));
      for (const r of rows) store.set(String(r.id), { ...(store.get(String(r.id)) ?? {}), ...r } as Word);
    },
  };
  return { repo, store, upsertLog };
}

const SEED: SeedEntry[] = [
  { lemma: 'academy', arpabet: 'AH0 K AE1 D AH0 M IY0' },
  { lemma: 'eagle', arpabet: 'IY1 G AH0 L' },
  // wilful 不在 map（未命中）
];

function fetchSeedOf(seed: SeedEntry[]): () => Promise<SeedEntry[]> {
  return async () => seed;
}

// ===== 回填主流程 =====

describe('backfillArpabetFromSeed', () => {
  it('命中写 arpabet+派生 ipa；未命中保留原 ipa、不写 arpabet', async () => {
    const { repo, store, upsertLog } = mkRepo([mkWord('academy'), mkWord('eagle'), mkWord('wilful')]);
    const res = await backfillArpabetFromSeed({ fetchSeed: fetchSeedOf(SEED), repo });

    expect(res).toMatchObject<Partial<BackfillResult>>({ total: 3, updated: 2, skipped: 1, errors: [] });
    expect(res.missed).toEqual(['wilful']);

    const academy = store.get('word_academy');
    expect(academy?.arpabet).toBe('AH0 K AE1 D AH0 M IY0');
    expect(academy?.ipa).toBe('/ə.ˈkæ.də.mi/');
    const wilful = store.get('word_wilful');
    expect(wilful?.arpabet).toBeUndefined();
    expect(wilful?.ipa).toBe('/wilful-ecd/'); // 原值未动
    expect(upsertLog.flat().some((r) => r.lemma === 'wilful')).toBe(false); // 未命中不进 upsert
  });

  it('进度回调：done 递增到 total，updated/skipped 汇总', async () => {
    const { repo } = mkRepo([mkWord('academy'), mkWord('wilful')]);
    const seen: number[] = [];
    const res = await backfillArpabetFromSeed({
      fetchSeed: fetchSeedOf(SEED),
      repo,
      onProgress: (p) => seen.push(p.done),
    });
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(res.total);
  });

  it('幂等：连跑两次，updated 数相同且写入值逐字节一致', async () => {
    const { repo, upsertLog } = mkRepo([mkWord('academy'), mkWord('eagle')]);
    const run = () => backfillArpabetFromSeed({ fetchSeed: fetchSeedOf(SEED), repo });

    const first = await run();
    const firstPayload = JSON.stringify(upsertLog);
    upsertLog.length = 0;
    const second = await run();
    const secondPayload = JSON.stringify(upsertLog);

    expect(second.updated).toBe(first.updated);
    expect(second.updated).toBe(2);
    expect(secondPayload).toBe(firstPayload); // 逐字节一致（确定性派生）
  });

  it('空 seed → 全部未命中，不 upsert', async () => {
    const { repo, upsertLog } = mkRepo([mkWord('academy')]);
    const res = await backfillArpabetFromSeed({ fetchSeed: fetchSeedOf([]), repo });
    expect(res).toMatchObject({ total: 1, updated: 0, skipped: 1 });
    expect(upsertLog).toHaveLength(0);
  });

  it('全未命中 → updated=0，missed 记录且不写 arpabet', async () => {
    const { repo, store } = mkRepo([mkWord('wilful'), mkWord('northwards')]);
    const res = await backfillArpabetFromSeed({ fetchSeed: fetchSeedOf(SEED), repo });
    expect(res).toMatchObject({ total: 2, updated: 0, skipped: 2 });
    expect(res.missed.sort()).toEqual(['northwards', 'wilful']);
    expect(store.get('word_wilful')?.arpabet).toBeUndefined();
  });

  it('fetchSeed 失败 → errors 非空、total=0（可原样重跑）', async () => {
    const { repo } = mkRepo([mkWord('academy')]);
    const res = await backfillArpabetFromSeed({
      fetchSeed: async () => {
        throw new Error('seed dataset fetch failed: HTTP 500');
      },
      repo,
    });
    expect(res.total).toBe(0);
    expect(res.errors[0]).toContain('HTTP 500');
  });

  it('upsertWords 失败 → errors 记录，其余继续（可重跑）', async () => {
    const store = new Map<string, Word>([['word_academy', mkWord('academy')]]);
    const repo: BackfillRepo = {
      listBookWords: async () => [mkBookWord('word_academy', 0)],
      listWordsByIds: async (ids) => ids.map((id) => store.get(id)).filter((w): w is Word => Boolean(w)),
      upsertWords: vi.fn(async () => {
        throw new Error('[words] upsert failed (code=42501)');
      }),
    };
    const res = await backfillArpabetFromSeed({ fetchSeed: fetchSeedOf(SEED), repo });
    expect(res.updated).toBe(1);
    expect(res.errors[0]).toContain('42501');
  });

  it('missed 清单上限 50（完整计数看 skipped）', async () => {
    const words = Array.from({ length: 60 }, (_, i) => mkWord(`miss${i}`));
    const { repo } = mkRepo(words);
    const res = await backfillArpabetFromSeed({ fetchSeed: fetchSeedOf(SEED), repo });
    expect(res.skipped).toBe(60);
    expect(res.missed).toHaveLength(50);
  });
});
