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
 *  - key 按 **userId** 隔离：同浏览器换账号不得继承他人进度（H）；userId 为假值不使用游标（I）。
 *
 * 三道「不无条件信任游标 / 不留静默缺口」的硬保证：
 *  - **② 内容指纹**：同词数、不同内容 → 旧游标必须丢弃（F / J）；指纹须与 seedToDocs 同序（P / Q）；
 *  - **① 云端对账**：续传起点只到「云端确实已存在」的分片边界；对账 count 抛错 → 全量，绝不沿用游标
 *    （L / N）；起点公式见 planStart 单测；
 *  - **③ 终局校验 + 一次性全量回退**：min() 只保证「起点 ≤ 云端计数」，**证明不了起点之前的行存在**
 *    （缺失集是「前缀」时它无能为力 —— K 就是这么构造的）。故写入结束后直接**数**两表：
 *    不足 → 清游标 + 无条件全量重写一次 → 再数；仍不足 → 响亮失败、绝不 createBook（R / S / T / U）。
 *
 * 测试口径：mock repo 的 `count` **由真实落库集合（landed）推导**（而非 stub 常量），因为终局校验要求
 * 「成功」必须建立在真实写入之上；`upsertWords` 与 repository.upsertMany 同构（内部再切 100 子片），
 * 支持「静默 no-op」（假成功）与「抛错」两种故障注入。fetch 用 stubGlobal，localStorage 用内存 shim。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CHUNK = 300;
/** repository.upsertMany 内部的子片大小（与 src/data/repository.ts 的 CHUNK_SIZE 一致） */
const SUB_CHUNK = 100;
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

const h = vi.hoisted(() => ({
  wordsCalls: [] as number[],
  bookWordCalls: [] as number[],
  /** 对账 / 终局校验请求收到的 filters */
  wordsCountFilters: [] as unknown[][],
  bookWordsCountFilters: [] as unknown[][],
  wordsCountCalls: 0,
  /** 1-based：第 N 次 upsertWords 调用抛错；-1 = 从不 */
  failWordsCall: -1,
  /** 1-based：第 N 次 words count 调用抛错（一次性）；-1 = 从不 */
  failWordsCountAt: -1,
  /** 从第 N 次 words count 调用起永久抛错；-1 = 从不 */
  failWordsCountFrom: -1,
  /** 1-based：第 N 次子片写入抛错（模拟单请求失败）；-1 = 从不 */
  failSubChunkAt: -1,
  subChunkAttempts: 0,
  /** 「假成功」注入 1：这些全局子片序号静默不落库（返回成功） */
  dropOnce: new Set<number>(),
  /** 「假成功」注入 2：每个整片内第 N 个子片永远静默不落库；-1 = 从不 */
  dropAlwaysInBatch: -1,
  /** 真实落库集合 —— count 由它推导 */
  landed: new Set<string>(),
  landedBookWords: new Set<string>(),
  /** createBook 抛错（撞 PK 23505 等） */
  failCreateBook: false,
  bookExists: false,
  createBookCalls: 0,
}));

vi.mock('../../src/data/repos/wordRepo', () => ({
  createWordRepo: () => ({
    getBook: async () => (h.bookExists ? { id: 'book_cet6_full', wordCount: 0 } : null),
    upsertWords: async (rows: unknown[]) => {
      h.wordsCalls.push(rows.length);
      if (h.failWordsCall === h.wordsCalls.length) throw new Error('boom-words');
      // 与 repository.upsertMany 同构：内部再切 100 子片；支持「抛错」与「静默 no-op（假成功）」两种注入
      for (let i = 0; i < rows.length; i += SUB_CHUNK) {
        h.subChunkAttempts += 1;
        if (h.failSubChunkAt === h.subChunkAttempts) throw new Error('boom-subchunk');
        const silent = h.dropOnce.has(h.subChunkAttempts) || h.dropAlwaysInBatch === i / SUB_CHUNK + 1;
        if (silent) continue;
        for (const r of rows.slice(i, i + SUB_CHUNK)) h.landed.add((r as { id: string }).id);
      }
    },
    upsertBookWords: async (rows: unknown[]) => {
      h.bookWordCalls.push(rows.length);
      for (const r of rows) h.landedBookWords.add((r as { id: string }).id);
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
        return h.landed.size; // 动态：真实落库量
      },
    },
    bookWords: {
      count: async (filters: unknown[]) => {
        h.bookWordsCountFilters.push(filters);
        return h.landedBookWords.size;
      },
    },
  }),
}));

const { CET6_BOOK_ID, getSeedCursor, planStart, seedCursorKey, seedFingerprint, seedLibraryToCloud } =
  await import('../../src/data/seedBootstrap');

/** 当前 SEED / 变更后 SEED 的内容指纹（游标本体里的唯一接受判据） */
const FP = seedFingerprint(SEED);
const FP_CHANGED = seedFingerprint(SEED_CHANGED);

type CursorLike = { words: number; bookWords: number; totalWords: number; totalBookWords: number; fingerprint: string };

// ===== localStorage shim =====

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

/** 直接读回指定用户持久化的游标（解析 JSON；无则 null） */
function storedCursor(userId: string): CursorLike | null {
  const raw = storage.get(seedCursorKey(CET6_BOOK_ID, userId));
  return raw ? (JSON.parse(raw) as CursorLike) : null;
}

/** 预置一个游标（默认用与当前 SEED 相符的指纹） */
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

/** 让 /seed-cet6.json 返回给定种子 */
function stubSeed(seed: unknown[]): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(seed), { status: 200 })));
}

/** 预置云端已落库前 n 个词（模拟「云端已有部分行」） */
function seedCloudWords(n: number): void {
  for (let i = 0; i < n; i += 1) h.landed.add(`word_w${i}`);
}

/** 清空云端（把两次运行当成两套独立云端场景用） */
function resetCloud(): void {
  h.landed.clear();
  h.landedBookWords.clear();
}

beforeEach(() => {
  h.wordsCalls.length = 0;
  h.bookWordCalls.length = 0;
  h.wordsCountFilters.length = 0;
  h.bookWordsCountFilters.length = 0;
  h.wordsCountCalls = 0;
  h.failWordsCall = -1;
  h.failWordsCountAt = -1;
  h.failWordsCountFrom = -1;
  h.failSubChunkAt = -1;
  h.subChunkAttempts = 0;
  h.dropOnce = new Set<number>();
  h.dropAlwaysInBatch = -1;
  h.landed.clear();
  h.landedBookWords.clear();
  h.failCreateBook = false;
  h.bookExists = false;
  h.createBookCalls = 0;
  installLocalStorage();
  stubSeed(SEED);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('planStart（云端对账起点）', () => {
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

    expect(h.wordsCalls).toEqual([CHUNK, CHUNK, CHUNK]); // 前两片成功，第 3 片尝试后失败
    expect(h.landed.size).toBe(2 * CHUNK); // 只有前两片真落库
    expect(storedCursor('u-1')).toEqual({
      words: 600,
      bookWords: 0,
      totalWords: TOTAL,
      totalBookWords: TOTAL,
      fingerprint: FP,
    });
    expect(h.bookWordCalls).toEqual([]); // words 未完成，绝不进入 book_words
    expect(h.createBookCalls).toBe(0);
  });

  it('B. 保留游标重试：只传剩余分片（已成功分片零请求），随后完成并上报绝对进度', async () => {
    h.failWordsCall = 3;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words');

    // 重试：云端确实已有那 600 行（对账通过才允许续传）
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    const progress: { step: string; done: number; total: number }[] = [];
    const result = await seedLibraryToCloud('u-1', (p) => progress.push({ ...p }));

    expect(h.wordsCalls).toEqual([CHUNK, TOTAL - 3 * CHUNK]); // 只剩第 3、4 片（600..999）
    expect(h.bookWordCalls).toEqual(FULL_CHUNKS); // book_words 从未开始 → 全量
    expect(result.skipped).toBe(false);
    expect(result.reverted).toBe(false); // 续传路径不该触发全量回退
    expect(h.createBookCalls).toBe(1);
    // UI 进度从断点起算（600/1000），不从 0 重跳
    expect(progress.find((p) => p.step === 'words')?.done).toBe(600);
  });

  it('C. 整次成功后才清除游标', async () => {
    const result = await seedLibraryToCloud('u-1');
    expect(result.reverted).toBe(false);
    expect(getSeedCursor('u-1')).toBeNull();
    expect(storage.has(seedCursorKey(CET6_BOOK_ID, 'u-1'))).toBe(false);
  });

  it('D. 某表云端已齐：该表整步跳过（零请求）但仍上报该步完成', async () => {
    seedCloudWords(TOTAL); // 云端实测已满
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

    // 完全没有 localStorage（node / worker / SSR 场景）；把云端重置，视作另一套独立场景
    h.wordsCalls.length = 0;
    resetCloud();
    vi.stubGlobal('localStorage', undefined);
    await expect(seedLibraryToCloud('u-1')).resolves.toMatchObject({ skipped: false });
    expect(h.wordsCalls).toEqual(FULL_CHUNKS); // 无游标 → 从头全量
  });

  it('F. 游标指纹与当前种子不符（种子变过）→ 丢弃旧游标，从头全量', async () => {
    setCursor('u-1', { words: 600, fingerprint: 'stale-fingerprint' });
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual(FULL_CHUNKS); // 未按 600 续传
  });

  it('G. 游标恰落在分片边界（< 总行数，且云端已覆盖）→ 从该边界继续，不重传之前的整片', async () => {
    seedCloudWords(3 * CHUNK); // 云端已有前 900 行
    setCursor('u-1', { words: 3 * CHUNK });
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual([TOTAL - 3 * CHUNK]); // 只剩最后一片（900..999）
  });

  /**
   * H 是「游标必须按 userId 隔离」的护栏（2026-10-13 自查发现的真缺陷）。
   * 注意：`landed` 里刻意留有 A 那轮的 600 行 —— 让「串号游标」在**对账之后仍能得逞**
   * （min(600, 600) = 600），否则对账会替 key 隔离兜底、本用例失去判别力。
   */
  it('H. 同浏览器换账号：B 不继承 A 的游标（全量导入），且 B 的导入不动 A 的进度', async () => {
    // 账号 A 跑到中断：words 第 3 片失败 → A 的游标停在 600，云端有 600 行
    h.failWordsCall = 3;
    await expect(seedLibraryToCloud('A')).rejects.toThrow('boom-words');
    const aBefore = storage.get(seedCursorKey(CET6_BOOK_ID, 'A'));
    expect(aBefore).toBeTruthy();
    expect((JSON.parse(aBefore!) as CursorLike).words).toBe(600);
    expect(h.landed.size).toBe(600);

    // 切到账号 B（同一 localStorage，不清存储）：B 无自己的游标 → 必须从 0 全量
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    await seedLibraryToCloud('B');
    expect(h.wordsCalls).toEqual(FULL_CHUNKS);
    expect(h.bookWordCalls).toEqual(FULL_CHUNKS);

    // A 的进度原封不动（逐字节相同）；B 成功后只清自己的
    expect(storage.get(seedCursorKey(CET6_BOOK_ID, 'A'))).toBe(aBefore);
    expect(storage.has(seedCursorKey(CET6_BOOK_ID, 'B'))).toBe(false);
  });

  it('I. userId 为假值：不使用游标（不读不写、不落 undefined 键），仅全量幂等', async () => {
    await seedLibraryToCloud('');
    expect(h.wordsCalls).toEqual(FULL_CHUNKS); // 全量
    expect(getSeedCursor('')).toBeNull();
    expect(storage.size).toBe(0); // 一个键都没写（尤其没有 seed-progress:undefined:...）
  });

  /** J：缺陷② —— 种子「改了内容但行数不变」时，旧游标必须被指纹判据丢弃 */
  it('J. 同词数、不同内容：指纹判据丢弃旧游标（否则前半旧内容、后半新内容会静默错位）', async () => {
    h.failWordsCall = 3;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words');
    expect(storedCursor('u-1')?.fingerprint).toBe(FP);
    expect(FP_CHANGED).not.toBe(FP); // 指纹判据本身对内容敏感

    stubSeed(SEED_CHANGED); // 种子内容变了、词数不变
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    const result = await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual(FULL_CHUNKS); // 指纹不符 → 丢弃游标 → 全量
    // 旧内容的行成了「孤儿行」（id 由 lemma 派生）⇒ 实测**大于**期望，终局校验不得因此判失败
    // （这正是终局校验用「守下界 >=」而非严格 === 的原因；用 === 会让换种子后永久无法建书）
    expect(h.landed.size).toBe(TOTAL + 1);
    expect(result.reverted).toBe(false);
  });

  /**
   * K：**前缀缺失** —— 我报备的那个规格 B 残留洞的活体构造。
   * 云端只有「后缀」（rows 600..999，共 400 行），游标却声称已满 1000。
   * min(1000, 400, 1000) = 400 → 起点 300 ⇒ **前 300 行会被永久跳过**（单靠 min() 公式无法发现）。
   * 终局校验直接数表（700 ≠ 1000）→ 清游标 + 全量重写 → 补齐到 1000 → 才建书。
   */
  it('K. 前缀缺失 + 游标称满：min() 会留下前缀洞，终局校验兜底补齐（绝不静默少词）', async () => {
    for (let i = 600; i < TOTAL; i += 1) h.landed.add(`word_w${i}`); // 云端只有后缀 400 行
    setCursor('u-1', { words: TOTAL }); // 游标谎称已满
    const result = await seedLibraryToCloud('u-1');

    // 首轮：起点 = floor(min(1000,400,1000)/300)*300 = 300 ⇒ 0..299 没被写（这就是洞）
    expect(h.wordsCalls[0]).toBe(CHUNK);
    expect(result.reverted).toBe(true); // 终局校验发现短缺（700 ≠ 1000）→ 触发一次全量回退
    expect(h.wordsCalls.slice(-4)).toEqual(FULL_CHUNKS); // 回退从 0 整片重写
    expect(h.landed.size).toBe(TOTAL); // 前缀洞被补齐：1000 行全在
    expect(h.createBookCalls).toBe(1); // 补齐后才建书
    expect(getSeedCursor('u-1')).toBeNull(); // 成功后才清游标
  });

  it('L. 续传前对账 count 抛错 → 不使用游标（起点 0 全量），终局校验仍能通过并正常建书', async () => {
    h.failWordsCall = 3;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words'); // 造出 600 游标

    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    h.wordsCountCalls = 0; // 计数器按「本轮运行」重新起算
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
    expect(h.bookExists).toBe(false); // 书行未落地 → 不存在「书声称 1000 词」的静默状态
    expect(h.landed.size).toBe(TOTAL); // 两表其实已写满（终局校验已通过），只是建书那步失败

    // 重试：云端确实已齐（这不是「因陈留游标而错跳」，而是终局校验认证过的完整）
    h.failCreateBook = false;
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    const result = await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual([]); // 云端已齐 → 零请求
    expect(result.reverted).toBe(false);
    expect(h.createBookCalls).toBe(2);
    expect(getSeedCursor('u-1')).toBeNull(); // 成功后才清
  });

  it('N. 对账/终局校验的过滤条件：words 必须按 owner_id（其 RLS 是 USING(true)），book_words 按 bookId+owner_id', async () => {
    await seedLibraryToCloud('u-1');
    expect(h.wordsCountFilters).toHaveLength(2); // 续传前对账 + 终局校验
    for (const f of h.wordsCountFilters) {
      expect(f).toEqual([{ column: 'owner_id', op: 'eq', value: 'u-1' }]);
    }
    expect(h.bookWordsCountFilters).toHaveLength(2);
    for (const f of h.bookWordsCountFilters) {
      expect(f).toEqual([
        { column: 'bookId', op: 'eq', value: CET6_BOOK_ID },
        { column: 'owner_id', op: 'eq', value: 'u-1' },
      ]);
    }
  });

  /**
   * O：覆盖缺口①（裁决方点名）—— 300 片**内部**的 100 子片失败。
   * 真实形态：子片非原子（先落的子片留在库里），但整个 300 调用 reject。
   * 要钉住的是「不谎报 / 不缺口」：游标一次都不写（该片整体视为未确认），重试整片重写。
   */
  it('O. 300 片内的 100 粒度失败：游标不前移（不谎报 300），重试整片重写 → 无缺口', async () => {
    h.failSubChunkAt = 2; // 第 1 个整片内的第 2 个 100 子片失败（前 100 行已落库）
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-subchunk');

    expect(h.wordsCalls).toEqual([CHUNK]); // 只尝试了第 1 个整片
    expect(h.subChunkAttempts).toBe(2);
    expect(h.landed.size).toBe(SUB_CHUNK); // 只有第 1 个子片落了库
    expect(storedCursor('u-1')).toBeNull(); // 游标一次都没写 → 绝不声称「已确认 300」

    // 重试：从 0 整片重写（而非从 100 或 300 续），最终 1000 个 word id 全部落库 → 无缺口
    h.failSubChunkAt = -1;
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls[0]).toBe(CHUNK); // 起点 0（整片重写）
    expect(h.landed.size).toBe(TOTAL); // 每个 word id 都在库里 → 无缺口
    expect(getSeedCursor('u-1')).toBeNull(); // 成功后清游标
  });

  /**
   * P：落实裁决方提醒 2 —— 指纹必须「生成过程与 seedToDocs 同序」，否则同一文件两次跑会算出不同值。
   * 端到端验证：同一文件连跑两次 → 写入的指纹 == 当次算出的指纹 → 旧游标被接受（续传生效）。
   */
  it('P. 指纹确定性：同一文件连跑两次同值 → 旧游标被接受（续传生效，不会误判为「种子变过」）', async () => {
    const fp = seedFingerprint(SEED);
    expect(seedFingerprint(SEED)).toBe(fp); // 纯函数幂等

    h.failWordsCall = 3;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words');
    expect(storedCursor('u-1')?.fingerprint).toBe(fp); // 游标里的指纹 = 当次算出的指纹

    // 同一文件再跑（同序）→ 指纹相等 → 游标被接受 → 走续传而非全量
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual([CHUNK, TOTAL - 3 * CHUNK]); // 只补 600 之后
  });

  /** Q：指纹对顺序敏感（首尾不变，仅内部两词对调）→ 故必须与 seedToDocs 同序遍历 */
  it('Q. 指纹对顺序敏感：内部两词对调（首尾与词数均不变）→ 指纹不同', () => {
    const swapped = [...SEED];
    [swapped[100], swapped[101]] = [swapped[101], swapped[100]];
    expect(swapped.length).toBe(SEED.length);
    expect(swapped[0]).toBe(SEED[0]); // 首未变
    expect(swapped[SEED.length - 1]).toBe(SEED[SEED.length - 1]); // 末未变
    expect(seedFingerprint(swapped)).not.toBe(seedFingerprint(SEED)); // 差异只可能来自校验和
  });

  /** R：③ 的核心正例 —— 同一次运行内的**中段**假成功（upsert 返回成功但没落库） */
  it('R. 中段分片静默 no-op（假成功）→ 终局校验发现短缺 → 清游标 + 全量重写一次 → 达标后正常建书', async () => {
    h.dropOnce = new Set([5]); // 第 2 个整片的第 2 个子片（rows 400..499）静默不落库
    const result = await seedLibraryToCloud('u-1');

    expect(h.landed.size).toBe(TOTAL); // 最终无缺口
    expect(result.reverted).toBe(true); // 触发过一次全量回退
    expect(h.createBookCalls).toBe(1);
    expect(h.wordsCalls).toEqual([...FULL_CHUNKS, ...FULL_CHUNKS]); // 首轮 4 片 + 回退从 0 再 4 片
    expect(getSeedCursor('u-1')).toBeNull(); // 成功后才清游标
  });

  /** S：③ 的负例 —— 回退也修不好，必须响亮失败，绝不 createBook */
  it('S. 永久吞掉某分片（回退也修不好）→ 响亮失败、绝不 createBook，错误含实测/期望数', async () => {
    h.dropAlwaysInBatch = 2; // 每个整片的第 2 个子片永远不落库 → 恒定缺 300 行
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow(/words 实测 700 \/ 期望 1000/);
    expect(h.createBookCalls).toBe(0); // 绝不建书
    expect(h.landed.size).toBe(TOTAL - 3 * SUB_CHUNK); // 就是缺那 300 行
  });

  /** T：③ 不得把回退变成常态 —— happy path 每表恰好 2 次 count、零重复写 */
  it('T. happy path：每表恰好 2 次 count（续传前对账 + 终局校验）、零回退、零重复写', async () => {
    const result = await seedLibraryToCloud('u-1');
    expect(h.wordsCountFilters).toHaveLength(2);
    expect(h.bookWordsCountFilters).toHaveLength(2);
    expect(result.reverted).toBe(false);
    expect(h.wordsCalls).toEqual(FULL_CHUNKS); // 只写一遍
    expect(h.bookWordCalls).toEqual(FULL_CHUNKS);
    expect(h.createBookCalls).toBe(1);
  });

  /** U：终局校验本身拿不到计数 → 无法证明 → 不得静默成功 */
  it('U. 终局校验的 count 自身失败 → 不得静默成功：抛响亮错误、绝不 createBook', async () => {
    h.failWordsCountFrom = 2; // 第 2 次 words count（= 终局校验）起永久失败
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow(/words 实测 -1/);
    expect(h.createBookCalls).toBe(0); // 无法证明就不建书
    expect(h.landed.size).toBe(TOTAL); // 行其实都写了（只是证明不了）
  });
});
