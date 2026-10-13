/**
 * seedResume.test.ts —— 词书初始化「断点续传」回归锚点（2026-10-13）。
 *
 * 背景：初始化六级词库要写 5407 词 × 2 表（words / book_words）≈ 110 个分片请求；
 * 断网 / 超时中断后原实现只能从头再传（幂等但白跑）。现改为本机 localStorage 游标续传。
 *
 * 设计不变量（用例逐条钉住）：
 *  - 游标只在「某分片已确认落库」之后前进 → 永不谎报进度（A / O）；
 *  - 失败重试从断点分片边界继续，已成功的分片零请求（B / G）；某表云端已齐则整步跳过（D）；
 *  - 两张表各自独立进度（推进一张不得把另一张覆盖成 0）；
 *  - 整次成功后才清游标（C）；createBook 失败路径保留游标（M）；
 *  - 存储不可用（无 localStorage / 读写抛错）→ 降级为「无游标」，绝不打断导入（E）；
 *  - key 按 **userId** 隔离（H）；userId 为假值不使用游标（I）。
 *
 * 三道「不无条件信任游标 / 不留静默缺口」的硬保证：
 *  - **② 内容指纹**：同词数、不同内容 → 旧游标必须丢弃（F / J）；指纹须与 seedToDocs 同序（P / Q）；
 *  - **① 云端对账**：续传起点只到「云端确实已存在」的分片边界；对账 count 抛错 → 全量（L / N）；
 *    起点公式见 planStart 单测（它只是**优化**，错了会被 ③ 逮住）；
 *  - **③ 终局校验（身份集合判据）+ 一次性全量回退**：判据是
 *    「期望种子 id 集合 ⊆ 云端实存 id 集合」（两表各一遍，只取 id、按 owner 作用域、分页读全）。
 *    它一次消掉整类「计数不含身份」的假设 —— 前缀洞（K）、另有别的词源（U）、别的账号的行（U2）
 *    全被逮住并回退修复；读失败 / 分页截断 → fail closed、不建书且不做无意义重写（V）。
 *
 * 测试口径：mock repo 的 `count` / `listIds` **由按 owner 分域的真实落库集合推导**，
 * 并且**尊重 filters**（`words` 无 owner 过滤时返回**并集**，模拟其 RLS `USING(true)` ——
 * 这正是「漏过滤 ⇒ 子集判据被别人的行满足 ⇒ 假通过」的机制）；`upsertWords` 与
 * `repository.upsertMany` 同构（内部再切 100 子片），支持「静默 no-op（假成功）」与「抛错」两种注入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CHUNK = 300;
/** repository.upsertMany 内部的子片大小（与 src/data/repository.ts 的 CHUNK_SIZE 一致） */
const SUB_CHUNK = 100;
/** 终局校验分页读 id 的页大小（与 src/data/seedBootstrap.ts 的 ID_PAGE 一致） */
const ID_PAGE = 1000;
/** 1000 词 → words 分片 4 个（300/300/300/100） */
const TOTAL = 1000;
const SEED = Array.from({ length: TOTAL }, (_, i) => ({
  lemma: `w${i}`,
  ipa: `/w${i}/`,
  translation: `t${i}`,
  frq: TOTAL - i,
  tags: ['cet6'],
}));
/** 同词数、不同内容（只改中间一个 lemma，首尾不变）—— 专打「只比行数不比内容」的缺陷② */
const SEED_CHANGED = SEED.map((w, i) => (i === 500 ? { ...w, lemma: 'w500-changed' } : w));
/** 全量导入时的分片序列 */
const FULL_CHUNKS = [CHUNK, CHUNK, CHUNK, TOTAL - 3 * CHUNK];

type Row = { column: string; op: string; value: unknown };

const h = vi.hoisted(() => ({
  /** 当前「会话用户」：upsert 落库时归属之（模拟服务端 DEFAULT auth.uid()） */
  owner: 'u-1',
  wordsByOwner: new Map<string, Set<string>>(),
  bookWordsByOwner: new Map<string, Set<string>>(),
  /** 写入侧收到过的 id（用于断言「期望集合与写入同批」） */
  writtenWordIds: [] as string[],
  writtenBookWordIds: [] as string[],
  wordsCalls: [] as number[],
  bookWordCalls: [] as number[],
  /** 对账 / 终局校验请求收到的 filters */
  wordsCountFilters: [] as unknown[][],
  bookWordsCountFilters: [] as unknown[][],
  wordsListIdsFilters: [] as unknown[][],
  bookWordsListIdsFilters: [] as unknown[][],
  wordsCountCalls: 0,
  wordsListIdsCalls: 0,
  bookWordsListIdsCalls: 0,
  /** 1-based：第 N 次 upsertWords 调用抛错；-1 = 从不 */
  failWordsCall: -1,
  /** 1-based：第 N 次 words count 调用抛错（一次性）；-1 = 从不 */
  failWordsCountAt: -1,
  /** 从第 N 次 words count 调用起永久抛错；-1 = 从不 */
  failWordsCountFrom: -1,
  /** 1-based：第 N 次子片写入抛错（模拟单请求失败）；-1 = 从不 */
  failSubChunkAt: -1,
  /** 1-based：第 N 次 listIds 调用抛错（模拟读失败）；-1 = 从不 */
  failListIdsAt: -1,
  /** ≥0：分页读最多只吐出这么多条（模拟**静默截断**）；-1 = 不截断 */
  idsTruncateTo: -1,
  subChunkAttempts: 0,
  /** 「假成功」注入 1：这些全局子片序号静默不落库（返回成功） */
  dropOnce: new Set<number>(),
  /** 「假成功」注入 2：每个整片内第 N 个子片永远静默不落库；-1 = 从不 */
  dropAlwaysInBatch: -1,
  /** createBook 抛错（撞 PK 23505 等） */
  failCreateBook: false,
  bookExists: false,
  createBookCalls: 0,
}));

vi.mock('../../src/data/repos/wordRepo', () => {
  /** 从 filters 里取某列的等值（模拟 PostgREST `col=eq.value`） */
  const val = (filters: Row[], col: string): string | null => {
    const f = filters.find((x) => x.column === col);
    return f ? String(f.value) : null;
  };
  /** 稳定序分页；idsTruncateTo ≥ 0 时模拟服务端**静默截断** */
  const page = (all: Iterable<string>, offset: number, limit: number): string[] => {
    const sorted = [...all].sort();
    const capped = h.idsTruncateTo >= 0 ? sorted.slice(0, h.idsTruncateTo) : sorted;
    return capped.slice(offset, offset + limit);
  };
  const union = (byOwner: Map<string, Set<string>>): Set<string> => {
    const all = new Set<string>();
    for (const s of byOwner.values()) for (const id of s) all.add(id);
    return all;
  };
  /**
   * words 的读：无 owner 过滤时返回**并集** —— 忠实模拟其 RLS `USING(true)`（全世界可读）。
   * 这正是「漏 owner 过滤 ⇒ 读到别人的 id ⇒ 子集判据假通过」的机制。
   */
  const wordsIds = (filters: Row[]): Set<string> => {
    const owner = val(filters, 'owner_id');
    return owner === null ? union(h.wordsByOwner) : (h.wordsByOwner.get(owner) ?? new Set<string>());
  };
  /** book_words 的读：其 RLS 是 owner-only ⇒ 无 owner 过滤时只会拿到**自己**的行 */
  const bookWordsIds = (filters: Row[]): Set<string> => {
    const owner = val(filters, 'owner_id');
    return h.bookWordsByOwner.get(owner ?? h.owner) ?? new Set<string>();
  };
  const setOf = (byOwner: Map<string, Set<string>>, owner: string): Set<string> => {
    let s = byOwner.get(owner);
    if (!s) {
      s = new Set<string>();
      byOwner.set(owner, s);
    }
    return s;
  };

  return {
    createWordRepo: () => ({
      getBook: async () => (h.bookExists ? { id: 'book_cet6_full', wordCount: 0 } : null),
      upsertWords: async (rows: unknown[]) => {
        h.wordsCalls.push(rows.length);
        for (const r of rows) h.writtenWordIds.push((r as { id: string }).id);
        if (h.failWordsCall === h.wordsCalls.length) throw new Error('boom-words');
        const landed = setOf(h.wordsByOwner, h.owner);
        // 与 repository.upsertMany 同构：内部再切 100 子片；支持「抛错」与「静默 no-op（假成功）」
        for (let i = 0; i < rows.length; i += SUB_CHUNK) {
          h.subChunkAttempts += 1;
          if (h.failSubChunkAt === h.subChunkAttempts) throw new Error('boom-subchunk');
          const silent = h.dropOnce.has(h.subChunkAttempts) || h.dropAlwaysInBatch === i / SUB_CHUNK + 1;
          if (silent) continue;
          for (const r of rows.slice(i, i + SUB_CHUNK)) landed.add((r as { id: string }).id);
        }
      },
      upsertBookWords: async (rows: unknown[]) => {
        h.bookWordCalls.push(rows.length);
        const landed = setOf(h.bookWordsByOwner, h.owner);
        for (const r of rows) {
          landed.add((r as { id: string }).id);
          h.writtenBookWordIds.push((r as { id: string }).id);
        }
      },
      createBook: async (b: unknown) => {
        h.createBookCalls += 1;
        if (h.failCreateBook) throw new Error('boom-createBook');
        return b;
      },
      words: {
        count: async (filters: unknown[]) => {
          h.wordsCountFilters.push(filters);
          h.wordsCountCalls += 1;
          if (h.failWordsCountAt === h.wordsCountCalls) throw new Error('boom-count');
          if (h.failWordsCountFrom > 0 && h.wordsCountCalls >= h.failWordsCountFrom) throw new Error('boom-count');
          return wordsIds(filters as Row[]).size;
        },
        listIds: async (filters: unknown[], opts: { offset?: number; limit?: number }) => {
          h.wordsListIdsFilters.push(filters);
          h.wordsListIdsCalls += 1;
          if (h.failListIdsAt === h.wordsListIdsCalls) throw new Error('boom-listIds');
          return page(wordsIds(filters as Row[]), opts.offset ?? 0, opts.limit ?? ID_PAGE);
        },
      },
      bookWords: {
        count: async (filters: unknown[]) => {
          h.bookWordsCountFilters.push(filters);
          return bookWordsIds(filters as Row[]).size;
        },
        listIds: async (filters: unknown[], opts: { offset?: number; limit?: number }) => {
          h.bookWordsListIdsFilters.push(filters);
          h.bookWordsListIdsCalls += 1;
          if (h.failListIdsAt === h.bookWordsListIdsCalls) throw new Error('boom-listIds');
          return page(bookWordsIds(filters as Row[]), opts.offset ?? 0, opts.limit ?? ID_PAGE);
        },
      },
    }),
  };
});

const { CET6_BOOK_ID, getSeedCursor, planStart, seedCursorKey, seedFingerprint, seedLibraryToCloud, seedToDocs } =
  await import('../../src/data/seedBootstrap');

/** 当前 SEED / 变更后 SEED 的内容指纹（游标本体里的唯一接受判据） */
const FP = seedFingerprint(SEED);
const FP_CHANGED = seedFingerprint(SEED_CHANGED);

type CursorLike = { words: number; bookWords: number; totalWords: number; totalBookWords: number; fingerprint: string };

// ===== 工具 =====

let storage: Map<string, string>;

function installLocalStorage(): void {
  storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
    key: (i: number) => Array.from(storage.keys())[i] ?? null,
    get length() {
      return storage.size;
    },
  });
}

function storedCursor(userId: string): CursorLike | null {
  const raw = storage.get(seedCursorKey(CET6_BOOK_ID, userId));
  return raw ? (JSON.parse(raw) as CursorLike) : null;
}

function setCursor(userId: string, c: { words: number; bookWords?: number; fingerprint?: string }): void {
  storage.set(
    seedCursorKey(CET6_BOOK_ID, userId),
    JSON.stringify({
      words: c.words,
      bookWords: c.bookWords ?? 0,
      totalWords: TOTAL,
      totalBookWords: TOTAL,
      fingerprint: c.fingerprint ?? FP,
    }),
  );
}

function stubSeed(seed: unknown[]): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(seed), { status: 200 })));
}

/**
 * 某 owner 云端实存的词 id（word 侧）。
 * ⚠ 缺键时必须**建并挂回 map**（不能返回游离 Set），否则预置会静默丢失。
 */
function landedOf(owner = h.owner): Set<string> {
  let s = h.wordsByOwner.get(owner);
  if (!s) {
    s = new Set<string>();
    h.wordsByOwner.set(owner, s);
  }
  return s;
}

/** 预置：某 owner 云端已有前 n 个种子词 */
function seedCloudWords(n: number, owner = h.owner): void {
  const s = landedOf(owner);
  for (let i = 0; i < n; i += 1) s.add(`word_w${i}`);
}

/** 预置：某 owner 云端有任意一批 id */
function seedCloudIds(ids: Iterable<string>, owner = h.owner): void {
  const s = landedOf(owner);
  for (const id of ids) s.add(id);
}

function resetCloud(): void {
  h.wordsByOwner.clear();
  h.bookWordsByOwner.clear();
}

beforeEach(() => {
  h.owner = 'u-1';
  resetCloud();
  h.writtenWordIds.length = 0;
  h.writtenBookWordIds.length = 0;
  h.wordsCalls.length = 0;
  h.bookWordCalls.length = 0;
  h.wordsCountFilters.length = 0;
  h.bookWordsCountFilters.length = 0;
  h.wordsListIdsFilters.length = 0;
  h.bookWordsListIdsFilters.length = 0;
  h.wordsCountCalls = 0;
  h.wordsListIdsCalls = 0;
  h.bookWordsListIdsCalls = 0;
  h.failWordsCall = -1;
  h.failWordsCountAt = -1;
  h.failWordsCountFrom = -1;
  h.failSubChunkAt = -1;
  h.failListIdsAt = -1;
  h.idsTruncateTo = -1;
  h.subChunkAttempts = 0;
  h.dropOnce = new Set<number>();
  h.dropAlwaysInBatch = -1;
  h.failCreateBook = false;
  h.bookExists = false;
  h.createBookCalls = 0;
  installLocalStorage();
  stubSeed(SEED);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('planStart（云端对账起点，只是优化）', () => {
  it('对账失败(null) → 0（全量）；云端不足 → 回退到该行数所在分片边界；云端充足 → 取游标', () => {
    expect(planStart(600, null, TOTAL)).toBe(0); // 对账失败绝不沿用游标
    expect(planStart(600, 0, TOTAL)).toBe(0); // 云端 0 行 → 从 0 全量
    expect(planStart(600, 300, TOTAL)).toBe(300); // 云端只有 300 → 退到 300
    expect(planStart(600, 600, TOTAL)).toBe(600);
    expect(planStart(601, 900, TOTAL)).toBe(600); // 向下对齐分片边界
  });
});

describe('seedLibraryToCloud 断点续传', () => {
  it('A. 分片失败即整体抛出，游标停在「已确认落库」的分片数（不谎报）', async () => {
    h.failWordsCall = 3; // 第 3 个 words 分片抛错
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words');

    expect(h.wordsCalls).toEqual([CHUNK, CHUNK, CHUNK]);
    expect(landedOf().size).toBe(2 * CHUNK); // 只有前两片真落库
    expect(storedCursor('u-1')).toEqual({
      words: 600,
      bookWords: 0,
      totalWords: TOTAL,
      totalBookWords: TOTAL,
      fingerprint: FP,
    });
    expect(h.bookWordCalls).toEqual([]);
    expect(h.createBookCalls).toBe(0);
  });

  it('B. 保留游标重试：只传剩余分片（已成功分片零请求），随后完成并上报绝对进度', async () => {
    h.failWordsCall = 3;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words');

    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    const progress: { step: string; done: number; total: number }[] = [];
    const result = await seedLibraryToCloud('u-1', (p) => progress.push({ ...p }));

    expect(h.wordsCalls).toEqual([CHUNK, TOTAL - 3 * CHUNK]); // 只剩第 3、4 片（600..999）
    expect(h.bookWordCalls).toEqual(FULL_CHUNKS);
    expect(result.skipped).toBe(false);
    expect(result.reverted).toBe(false);
    expect(h.createBookCalls).toBe(1);
    expect(progress.find((p) => p.step === 'words')?.done).toBe(600); // 进度从断点起算
  });

  it('C. 整次成功后才清除游标', async () => {
    const result = await seedLibraryToCloud('u-1');
    expect(result.reverted).toBe(false);
    expect(getSeedCursor('u-1')).toBeNull();
    expect(storage.has(seedCursorKey(CET6_BOOK_ID, 'u-1'))).toBe(false);
  });

  it('D. 某表云端已齐：该表整步跳过（零请求）但仍上报该步完成', async () => {
    seedCloudWords(TOTAL);
    setCursor('u-1', { words: TOTAL });
    const progress: { step: string; done: number; total: number }[] = [];
    await seedLibraryToCloud('u-1', (p) => progress.push({ ...p }));

    expect(h.wordsCalls).toEqual([]); // words 已满 → 零请求
    expect(h.bookWordCalls).toEqual(FULL_CHUNKS);
    expect(progress.some((p) => p.step === 'words' && p.done === TOTAL && p.total === TOTAL)).toBe(true);
  });

  it('E. 存储不可用（读写抛错 / 无 localStorage）：降级为无游标，导入照常完成', async () => {
    const boom = () => {
      throw new Error('storage denied');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
    await expect(seedLibraryToCloud('u-1')).resolves.toMatchObject({ skipped: false, reverted: false });

    // 完全没有 localStorage（node / worker / SSR 场景）；视作另一套独立场景
    h.wordsCalls.length = 0;
    resetCloud();
    vi.stubGlobal('localStorage', undefined);
    await expect(seedLibraryToCloud('u-1')).resolves.toMatchObject({ skipped: false });
    expect(h.wordsCalls).toEqual(FULL_CHUNKS);
  });

  it('F. 游标指纹与当前种子不符（种子变过）→ 丢弃旧游标，从头全量', async () => {
    setCursor('u-1', { words: 600, fingerprint: 'stale-fingerprint' });
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual(FULL_CHUNKS);
  });

  it('G. 游标恰落在分片边界（< 总行数，且云端已覆盖）→ 从该边界继续，不重传之前的整片', async () => {
    seedCloudWords(3 * CHUNK);
    setCursor('u-1', { words: 3 * CHUNK });
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual([TOTAL - 3 * CHUNK]);
  });

  /**
   * H：key 必须按 userId 隔离。云端刻意预置 B 自己的 600 行 —— 让「串号游标」在
   * 对账后**仍会改变续传起点**（`min(600,600)=600`），否则本用例失去判别力。
   * 注：终局身份校验已经把「串号游标造成静默少词」这条封死，所以 H 现在的角色是
   * 「隔离性金丝雀」：泄漏会让 B 少写一轮（起点 600 而非 0）。
   */
  it('H. 同浏览器换账号：B 不继承 A 的游标（全量导入），且 B 的导入不动 A 的进度', async () => {
    h.owner = 'A';
    h.failWordsCall = 3;
    await expect(seedLibraryToCloud('A')).rejects.toThrow('boom-words');
    const aBefore = storage.get(seedCursorKey(CET6_BOOK_ID, 'A'));
    expect(aBefore).toBeTruthy();
    expect((JSON.parse(aBefore!) as CursorLike).words).toBe(600);
    expect(landedOf('A').size).toBe(600);

    // 切到账号 B：B 有自己的 600 行，但没有自己的游标 → 必须从 0 全量
    h.owner = 'B';
    seedCloudWords(600, 'B');
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    await seedLibraryToCloud('B');
    expect(h.wordsCalls).toEqual(FULL_CHUNKS); // 串号游标会让这里变成 [300,100]
    expect(h.bookWordCalls).toEqual(FULL_CHUNKS);

    expect(storage.get(seedCursorKey(CET6_BOOK_ID, 'A'))).toBe(aBefore); // A 原封不动
    expect(storage.has(seedCursorKey(CET6_BOOK_ID, 'B'))).toBe(false); // B 成功后只清自己的
  });

  /**
   * I：userId 为假值时不使用游标（不读不写、不落 `undefined` 键），且全量写。
   * 由于「按身份读回」读的是 owner='' 这一域（空）⇒ 期望的 1000 个种子 id 一个都不在里面
   * ⇒ 校验必然不通过 ⇒ 响亮失败且绝不建书（fail closed：无法归属的写入不允许被声称成功）。
   */
  it('I. userId 为假值：不使用游标（不读不写、不落 undefined 键）；且无法按身份校验 → 响亮失败、绝不建书', async () => {
    await expect(seedLibraryToCloud('')).rejects.toThrow(/校验未通过/);
    expect(h.wordsCalls[0]).toBe(CHUNK); // 从 0 全量写（未沿用游标）
    expect(getSeedCursor('')).toBeNull();
    expect(storage.size).toBe(0); // 一个键都没写（尤其没有 seed-progress:undefined:...）
    expect(h.createBookCalls).toBe(0);
  });

  it('J. 同词数、不同内容：指纹判据丢弃旧游标（否则前半旧内容、后半新内容会静默错位）', async () => {
    h.failWordsCall = 3;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words');
    expect(storedCursor('u-1')?.fingerprint).toBe(FP);
    expect(FP_CHANGED).not.toBe(FP);

    stubSeed(SEED_CHANGED); // 种子内容变了、词数不变
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    const result = await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual(FULL_CHUNKS); // 指纹不符 → 丢弃游标 → 全量
    // 旧内容的行成了「孤儿行」（id 由 lemma 派生）⇒ 多出来的 id 必须被**子集判据天然放行**，
    // 不得判失败（这正是判据用「集合 ⊆」而非任何「计数比较」的原因：计数比较会让换种子后永久无法建书）
    expect(landedOf().size).toBe(TOTAL + 1);
    expect(result.reverted).toBe(false);
  });

  /**
   * K：**前缀缺失** —— `planStart` 的 min() 公式的活体反例。
   * 云端只有「后缀」（rows 600..999），游标却声称已满 1000 ⇒ min(1000,400,1000)=400 ⇒ 起点 300
   * ⇒ 0..299 会被跳过。min() 抓不到，**终局身份校验抓得到**（缺 0..299 共 300 个种子 id）。
   */
  it('K. 前缀缺失 + 游标称满：min() 会留下前缀洞，终局身份校验兜底补齐（绝不静默少词）', async () => {
    for (let i = 600; i < TOTAL; i += 1) landedOf().add(`word_w${i}`); // 云端只有后缀 400 行
    setCursor('u-1', { words: TOTAL }); // 游标谎称已满
    const result = await seedLibraryToCloud('u-1');

    expect(h.wordsCalls[0]).toBe(CHUNK); // 首轮起点 300 ⇒ 0..299 没写（这就是洞）
    expect(result.reverted).toBe(true); // 身份校验发现缺 300 个 id → 触发一次全量回退
    expect(h.wordsCalls.slice(-4)).toEqual(FULL_CHUNKS); // 回退从 0 整片重写
    expect(landedOf().size).toBe(TOTAL); // 补齐：1000 行全在
    expect(h.createBookCalls).toBe(1);
    expect(getSeedCursor('u-1')).toBeNull();
  });

  it('L. 续传前对账 count 抛错 → 不使用游标（起点 0 全量），终局校验仍能通过并正常建书', async () => {
    h.failWordsCall = 3;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words'); // 造出 600 游标

    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    h.wordsCountCalls = 0;
    h.failWordsCountAt = 1; // 本次「续传前对账」请求失败（一次性）
    const result = await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual(FULL_CHUNKS); // 起点 0（未沿用游标）
    expect(result.reverted).toBe(false); // 已走全量，无需再回退
    expect(h.createBookCalls).toBe(1);
  });

  it('M. createBook 抛错：游标保留（可续传），且不会静默产出「声称 N 词却更少」的书', async () => {
    h.failCreateBook = true;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-createBook');
    expect(h.createBookCalls).toBe(1);
    expect(getSeedCursor('u-1')).not.toBeNull(); // 失败路径保留游标，未清
    expect(h.bookExists).toBe(false);
    expect(landedOf().size).toBe(TOTAL); // 两表其实已写满（身份校验已通过），只是建书那步失败

    // 重试：云端确实已齐（这是身份校验认证过的完整，不是「因陈留游标而错跳」）
    h.failCreateBook = false;
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    const result = await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual([]);
    expect(h.bookWordCalls).toEqual([]);
    expect(result.reverted).toBe(false);
    expect(h.createBookCalls).toBe(2);
    expect(getSeedCursor('u-1')).toBeNull();
  });

  it('N. 所有读请求都必须按 owner 作用域：words 用 owner_id（RLS 是 USING(true)），book_words 用 bookId+owner_id', async () => {
    await seedLibraryToCloud('u-1');
    const wordScope: Row[] = [{ column: 'owner_id', op: 'eq', value: 'u-1' }];
    const bwScope: Row[] = [
      { column: 'bookId', op: 'eq', value: CET6_BOOK_ID },
      { column: 'owner_id', op: 'eq', value: 'u-1' },
    ];
    expect(h.wordsCountFilters.length).toBeGreaterThan(0);
    for (const f of h.wordsCountFilters) expect(f).toEqual(wordScope);
    expect(h.wordsListIdsFilters.length).toBeGreaterThan(0); // 终局身份校验的 id 读也必须带 owner
    for (const f of h.wordsListIdsFilters) expect(f).toEqual(wordScope);
    expect(h.bookWordsCountFilters.length).toBeGreaterThan(0);
    for (const f of h.bookWordsCountFilters) expect(f).toEqual(bwScope);
    expect(h.bookWordsListIdsFilters.length).toBeGreaterThan(0);
    for (const f of h.bookWordsListIdsFilters) expect(f).toEqual(bwScope);
  });

  it('O. 300 片内的 100 粒度失败：游标不前移（不谎报 300），重试整片重写 → 无缺口', async () => {
    h.failSubChunkAt = 2; // 第 1 个整片内的第 2 个 100 子片失败（前 100 行已落库）
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-subchunk');

    expect(h.wordsCalls).toEqual([CHUNK]);
    expect(h.subChunkAttempts).toBe(2);
    expect(landedOf().size).toBe(SUB_CHUNK);
    expect(storedCursor('u-1')).toBeNull(); // 游标一次都没写 → 绝不声称「已确认 300」

    h.failSubChunkAt = -1;
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls[0]).toBe(CHUNK); // 起点 0（整片重写）
    expect(landedOf().size).toBe(TOTAL); // 每个 word id 都在库里 → 无缺口
    expect(getSeedCursor('u-1')).toBeNull();
  });

  it('P. 指纹确定性：同一文件连跑两次同值 → 旧游标被接受（续传生效，不会误判为「种子变过」）', async () => {
    const fp = seedFingerprint(SEED);
    expect(seedFingerprint(SEED)).toBe(fp); // 纯函数幂等

    h.failWordsCall = 3;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words');
    expect(storedCursor('u-1')?.fingerprint).toBe(fp);

    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual([CHUNK, TOTAL - 3 * CHUNK]); // 只补 600 之后
  });

  it('Q. 指纹对顺序敏感：内部两词对调（首尾与词数均不变）→ 指纹不同', () => {
    const swapped = [...SEED];
    [swapped[100], swapped[101]] = [swapped[101], swapped[100]];
    expect(swapped.length).toBe(SEED.length);
    expect(swapped[0]).toBe(SEED[0]);
    expect(swapped[SEED.length - 1]).toBe(SEED[SEED.length - 1]);
    expect(seedFingerprint(swapped)).not.toBe(seedFingerprint(SEED));
  });

  it('R. 中段分片静默 no-op（假成功）→ 终局身份校验发现缺失 → 清游标 + 全量重写一次 → 达标后正常建书', async () => {
    h.dropOnce = new Set([5]); // 第 2 个整片的第 2 个子片（rows 400..499）静默不落库
    const result = await seedLibraryToCloud('u-1');

    expect(landedOf().size).toBe(TOTAL); // 最终无缺口
    expect(result.reverted).toBe(true);
    expect(h.createBookCalls).toBe(1);
    expect(h.wordsCalls).toEqual([...FULL_CHUNKS, ...FULL_CHUNKS]); // 首轮 + 回退
    expect(getSeedCursor('u-1')).toBeNull();
  });

  it('S. 永久吞掉某分片（回退也修不好）→ 恰好一次回退后响亮失败、绝不 createBook，错误含缺失条数与样例 id', async () => {
    h.dropAlwaysInBatch = 2; // 每个整片的第 2 个子片永远不落库 → 恒定缺 300 行
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow(/words 缺 300 条/);
    expect(h.createBookCalls).toBe(0); // 绝不建书
    expect(h.wordsCalls).toEqual([...FULL_CHUNKS, ...FULL_CHUNKS]); // **恰好一次**回退（两轮，不是三轮）
    expect(landedOf().size).toBe(TOTAL - 3 * SUB_CHUNK);
  });

  it('T. happy path：每表 1 组分页 id 读（合计 2 组）、零回退、零重复写', async () => {
    const result = await seedLibraryToCloud('u-1');
    expect(h.wordsListIdsCalls).toBe(1); // 1000 条 < ID_PAGE ⇒ 1 页
    expect(h.bookWordsListIdsCalls).toBe(1);
    expect(result.reverted).toBe(false);
    expect(h.wordsCalls).toEqual(FULL_CHUNKS);
    expect(h.bookWordCalls).toEqual(FULL_CHUNKS);
    expect(h.createBookCalls).toBe(1);
  });

  /**
   * U：本判据升级的**直接动机**。该 owner 另有 300 个**别的 id**，同时缺 300 个**种子 id**，
   * 总数恰好等于期望 ⇒ 任何「计数比较」（`===` 或 `>=`）都会放行 → 静默少词。
   * 身份集合判据必须检出并回退修好。
   */
  it('U. 另有别的词源 id + 缺同样多的种子 id（总数恰好相等）→ 计数判据会放行，身份判据必须检出并修好', async () => {
    seedCloudIds(Array.from({ length: 300 }, (_, i) => `word_other_${i}`)); // 别的来源的 300 个 id
    h.dropOnce = new Set([5, 6, 7]); // 首轮让种子 id 400..699 静默不落库（正好 300 条）
    const result = await seedLibraryToCloud('u-1');

    // 首轮结束时：300 别的 id + 700 种子 id = 1000 = 期望总数 ⇒ 计数比较看不出来
    expect(result.reverted).toBe(true);
    for (const i of [400, 500, 600, 699]) expect(landedOf().has(`word_w${i}`)).toBe(true); // 已补齐
    expect(landedOf().size).toBe(TOTAL + 300); // 种子 1000 + 别的 300
    expect(h.createBookCalls).toBe(1);
  });

  /**
   * U2：那些「别的 id」归属**另一个账号**。若读请求漏了 owner 过滤，`words` 的 RLS（USING(true)）
   * 会让我们读到别人的行 —— 而别人导过同一份种子，恰好含我们缺的那些 id ⇒ 子集判据**被别人的行满足**、
   * 假通过、静默少词。本条专验 owner 作用域（配合 N 的 filters 断言）。
   */
  it('U2. 缺的种子 id 由「另一个账号」持有 → 漏 owner 过滤会被别人的行满足（假通过）；必须按 owner 检出并修好', async () => {
    const other = new Set<string>();
    for (let i = 400; i < 700; i += 1) other.add(`word_w${i}`); // 别的账号恰好持有我们缺的 300 个
    h.wordsByOwner.set('other-user', other);
    h.dropOnce = new Set([5, 6, 7]); // 我们这边缺 400..699
    const result = await seedLibraryToCloud('u-1');

    expect(result.reverted).toBe(true); // 漏过滤时这里会是 false（被别人的行满足 → 假通过）
    expect(landedOf().size).toBe(TOTAL); // 我们自己的 1000 行补齐（不靠别人的行）
    for (const i of [400, 500, 600, 699]) expect(landedOf().has(`word_w${i}`)).toBe(true);
    expect(landedOf('other-user').size).toBe(300); // 别人的数据没被我们算进来、也没被改写
    expect(h.createBookCalls).toBe(1);
  });

  it('V. 分页读被静默截断 / 读失败 → 不得判通过：fail closed（响亮失败、不建书、且不做无意义全量重写）', async () => {
    // (a) 计数说 1000，但分页只吐出 600 条（模拟服务端静默截断）
    h.idsTruncateTo = 600;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow(/无法校验/);
    expect(h.createBookCalls).toBe(0);
    expect(h.wordsCalls).toEqual(FULL_CHUNKS); // 只写了一轮：没有触发无意义的回退重写

    // (b) 读请求本身失败
    resetCloud();
    h.idsTruncateTo = -1;
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.wordsListIdsCalls = 0;
    h.failListIdsAt = 1;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow(/无法校验/);
    expect(h.createBookCalls).toBe(0);
    expect(h.wordsCalls).toEqual(FULL_CHUNKS);
  });

  it('W. 期望 id 集合由 seedToDocs 结果直接取（与写入同一批，防日后两边漂移）', async () => {
    const expected = seedToDocs(SEED, CET6_BOOK_ID, 50);
    await seedLibraryToCloud('u-1');
    expect([...h.writtenWordIds].sort()).toEqual(expected.words.map((w) => w.id).sort());
    expect([...h.writtenBookWordIds].sort()).toEqual(expected.bookWords.map((b) => b.id).sort());
  });

  it('X. 分页读全：2500 词（> ID_PAGE）→ 每表 3 次分页读、校验通过、正常建书', async () => {
    const big = Array.from({ length: 2500 }, (_, i) => ({
      lemma: `b${i}`,
      ipa: `/b${i}/`,
      translation: `t${i}`,
      frq: 2500 - i,
      tags: ['cet6'],
    }));
    stubSeed(big);
    const result = await seedLibraryToCloud('u-1');
    expect(h.wordsListIdsCalls).toBe(3); // offset 0/1000/2000（第 3 页 500 条 → 短页结束）
    expect(h.bookWordsListIdsCalls).toBe(3);
    expect(result.reverted).toBe(false);
    expect(h.createBookCalls).toBe(1);
  });
});
