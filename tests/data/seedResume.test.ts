/**
 * seedResume.test.ts —— 词书初始化「断点续传」回归锚点（2026-10-13）。
 *
 * 背景：初始化六级词库要写 5407 词 × 2 表（words / book_words）≈ 110 个分片请求；
 * 断网 / 超时中断后原实现只能从头再传（幂等但白跑）。现改为本机 localStorage 游标续传。
 *
 * 设计不变量（用例逐条钉住）：
 *  - 游标只在「某分片已确认落库」之后前进 → 永不谎报进度（A）；
 *  - 失败重试从断点分片边界继续，已成功的分片零请求（B / G）；某表云端已齐则整步跳过（D）；
 *  - 两张表各自独立进度（推进一张不得把另一张覆盖成 0）；
 *  - 整次成功后才清游标（C）；`getBook` 命中早退不清游标（createBook 失败路径可续传，M）；
 *  - 存储不可用（无 localStorage / 读写抛错）→ 降级为「无游标」，绝不打断导入（E）；
 *  - key 按 **userId** 隔离：同浏览器换账号不得继承他人进度（H）；userId 为假值不使用游标（I）。
 *
 * 两处「不无条件信任游标」的硬校验（本轮由独立复核裁决补齐）：
 *  - **② 内容指纹**：同词数、不同内容 → 旧游标必须丢弃（F / J）；
 *  - **① 云端对账**：续传起点只到「云端确实已存在」的分片边界，绝不允许跳过云端不存在的行；
 *    对账 count 抛错 → 降级为全量，绝不沿用游标（K / L / N）；起点公式见 planStart 单测。
 *
 * 测试口径：mock repo（记录分片行数 / 对账 filters；可指定第 N 次 upsertWords 抛错、count 抛错、
 * createBook 抛错）+ stubGlobal('fetch') 返回内存种子 + localStorage shim。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CHUNK = 300;
/** repository.upsertMany 内部的子片大小（与 src/data/repository.ts 的 CHUNK_SIZE 一致） */
const SUB_CHUNK = 100;
/** 1000 词 → words 分片 4 个（300/300/300/100），便于构造「第 3 片失败」 */
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
  /** 对账请求收到的 filters（用于断言 words 必须按 owner_id 过滤） */
  wordsCountFilters: [] as unknown[][],
  bookWordsCountFilters: [] as unknown[][],
  /** 1-based：第 N 次 upsertWords 调用抛错；-1 = 从不失败 */
  failWordsCall: -1,
  /** 对账 count 抛错 */
  failWordsCount: false,
  /** createBook 抛错（撞 PK 23505 等） */
  failCreateBook: false,
  bookExists: false,
  createBookCalls: 0,
  /** 云端实测行数（count 返回值）—— 对账依据 */
  cloudWords: 0,
  cloudBookWords: 0,
  /**
   * 模拟 repository.upsertMany 的**内部 100 子片**：第 N 次子片尝试时抛错；-1 = 不失败。
   * 用于「300 片内的 100 粒度失败」——真实形态是子片非原子：先落的子片会留下。
   */
  failSubChunkAt: -1,
  subChunkAttempts: 0,
  /** 已落库的 words 行 id（用于「无缺口」断言） */
  landed: new Set<string>(),
}));

vi.mock('../../src/data/repos/wordRepo', () => ({
  createWordRepo: () => ({
    getBook: async () => (h.bookExists ? { id: 'book_cet6_full', wordCount: 0 } : null),
    upsertWords: async (rows: unknown[]) => {
      h.wordsCalls.push(rows.length);
      if (h.failWordsCall === h.wordsCalls.length) throw new Error('boom-words');
      // 与 repository.upsertMany 同构：内部再切 100 子片，任一子片抛错 → 整个 300 调用 reject
      for (let i = 0; i < rows.length; i += SUB_CHUNK) {
        h.subChunkAttempts += 1;
        if (h.failSubChunkAt === h.subChunkAttempts) throw new Error('boom-subchunk');
        for (const r of rows.slice(i, i + SUB_CHUNK)) h.landed.add((r as { id: string }).id);
      }
    },
    upsertBookWords: async (rows: unknown[]) => {
      h.bookWordCalls.push(rows.length);
    },
    createBook: async (b: unknown) => {
      h.createBookCalls += 1;
      if (h.failCreateBook) throw new Error('boom-createBook');
      return b;
    },
    words: {
      count: async (filters: unknown[]) => {
        h.wordsCountFilters.push(filters);
        if (h.failWordsCount) throw new Error('boom-count');
        return h.cloudWords;
      },
    },
    bookWords: {
      count: async (filters: unknown[]) => {
        h.bookWordsCountFilters.push(filters);
        return h.cloudBookWords;
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

beforeEach(() => {
  h.wordsCalls.length = 0;
  h.bookWordCalls.length = 0;
  h.wordsCountFilters.length = 0;
  h.bookWordsCountFilters.length = 0;
  h.failWordsCall = -1;
  h.failWordsCount = false;
  h.failCreateBook = false;
  h.bookExists = false;
  h.createBookCalls = 0;
  h.cloudWords = 0;
  h.cloudBookWords = 0;
  h.failSubChunkAt = -1;
  h.subChunkAttempts = 0;
  h.landed.clear();
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

    // 重试：清掉调用记录，不再注入失败；云端确实已有那 600 行（对账通过才允许续传）
    h.wordsCalls.length = 0;
    h.failWordsCall = -1;
    h.cloudWords = 600;
    const progress: { step: string; done: number; total: number }[] = [];
    const result = await seedLibraryToCloud('u-1', (p) => progress.push({ ...p }));

    expect(h.wordsCalls).toEqual([CHUNK, TOTAL - 3 * CHUNK]); // 只剩第 3、4 片（600..999）
    expect(h.bookWordCalls).toEqual(FULL_CHUNKS); // book_words 从未开始 → 全量
    expect(result.skipped).toBe(false);
    expect(h.createBookCalls).toBe(1);
    // UI 进度从断点起算（600/1000），不从 0 重跳
    expect(progress.find((p) => p.step === 'words')?.done).toBe(600);
  });

  it('C. 整次成功后才清除游标', async () => {
    await seedLibraryToCloud('u-1');
    expect(getSeedCursor('u-1')).toBeNull();
    expect(storage.has(seedCursorKey(CET6_BOOK_ID, 'u-1'))).toBe(false);
  });

  it('D. 某表云端已齐：该表整步跳过（零请求）但仍上报该步完成', async () => {
    setCursor('u-1', { words: TOTAL });
    h.cloudWords = TOTAL; // 云端实测已满
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
    await expect(seedLibraryToCloud('u-1')).resolves.toMatchObject({ skipped: false });

    // 完全没有 localStorage（node / worker / SSR 场景）
    h.wordsCalls.length = 0;
    vi.stubGlobal('localStorage', undefined);
    await expect(seedLibraryToCloud('u-1')).resolves.toMatchObject({ skipped: false });
    expect(h.wordsCalls).toEqual(FULL_CHUNKS); // 无游标 → 从头全量
  });

  it('F. 游标指纹与当前种子不符（种子变过）→ 丢弃旧游标，从头全量', async () => {
    setCursor('u-1', { words: 600, fingerprint: 'stale-fingerprint' });
    h.cloudWords = 600; // 若旧游标被误接受，这里会看到 [300, 100]
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual(FULL_CHUNKS); // 未按 600 续传
  });

  it('G. 游标恰落在分片边界（< 总行数，且云端已覆盖）→ 从该边界继续，不重传之前的整片', async () => {
    setCursor('u-1', { words: 3 * CHUNK });
    h.cloudWords = 3 * CHUNK; // 云端已有前 900 行
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual([TOTAL - 3 * CHUNK]); // 只剩最后一片（900..999）
  });

  /**
   * H 是「游标必须按 userId 隔离」的护栏（2026-10-13 自查发现的真缺陷）。
   * 注意 cloudWords 刻意给到 600 —— 让「串号游标」在**对账之后仍能得逞**，
   * 否则对账会替 key 隔离兜底，本用例就失去判别力。
   */
  it('H. 同浏览器换账号：B 不继承 A 的游标（全量导入），且 B 的导入不动 A 的进度', async () => {
    // 账号 A 跑到中断：words 第 3 片失败 → A 的游标停在 600
    h.failWordsCall = 3;
    h.cloudWords = 0;
    await expect(seedLibraryToCloud('A')).rejects.toThrow('boom-words');
    const aBefore = storage.get(seedCursorKey(CET6_BOOK_ID, 'A'));
    expect(aBefore).toBeTruthy();
    expect((JSON.parse(aBefore!) as CursorLike).words).toBe(600);

    // 切到账号 B（同一 localStorage，不清存储）：B 无自己的游标 → 必须从 0 全量
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    h.cloudWords = 600; // 云端已有 600 行：串号游标在此会得逞 → 用来验证隔离有效
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
    h.cloudWords = 600; // 若旧游标被误接受 → [300, 100]
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual(FULL_CHUNKS); // 指纹不符 → 丢弃游标 → 全量
  });

  /** K：缺陷① —— 游标超前于云端（分片「假成功」）时，绝不允许跳过云端不存在的行 */
  it('K. 游标超前于云端实测行数：起点回退，前 N 行绝不被跳过', async () => {
    // K1：游标 600 但云端一行都没有 → 起点 0，全量（修改前会是 [300, 100]，前 600 永久缺失）
    h.failWordsCall = 3;
    h.cloudWords = 0;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words');

    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    h.cloudWords = 0;
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual(FULL_CHUNKS);

    // K2：游标 600、云端只有 300 → 起点 = floor(300/300)*300 = 300（300..999 全部重写）
    h.cloudWords = 0;
    h.failWordsCall = 3;
    h.wordsCalls.length = 0;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words'); // 重新造出 600 游标
    expect(storedCursor('u-1')?.words).toBe(600);

    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    h.cloudWords = 300;
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual([CHUNK, CHUNK, TOTAL - 3 * CHUNK]); // 300..999
  });

  it('L. 对账 count 抛错 → 降级为全量，绝不沿用游标跳过', async () => {
    h.failWordsCall = 3;
    h.cloudWords = 0;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words'); // 造出 600 游标

    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    h.cloudWords = 600; // 若沿用游标 → [300, 100]
    h.failWordsCount = true; // 但对账请求本身失败
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual(FULL_CHUNKS);
  });

  it('M. createBook 抛错：游标保留（可续传），且不会静默产出「声称 N 词却更少」的书', async () => {
    h.failCreateBook = true;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-createBook');
    expect(h.createBookCalls).toBe(1);
    expect(getSeedCursor('u-1')).not.toBeNull(); // 游标保留，未在失败路径被清
    expect(h.bookExists).toBe(false); // 书行未落地 → 不存在「书声称 1000 词」的静默状态（用户看到的是报错）

    // 重试：云端仍 0 行 → 陈留游标不得造成跳过
    h.failCreateBook = false;
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual(FULL_CHUNKS);
    expect(getSeedCursor('u-1')).toBeNull(); // 成功后才清
  });

  it('N. 对账请求的过滤条件：words 必须按 owner_id（其 RLS 是 USING(true)），book_words 按 bookId+owner_id', async () => {
    await seedLibraryToCloud('u-1');
    expect(h.wordsCountFilters[0]).toEqual([{ column: 'owner_id', op: 'eq', value: 'u-1' }]);
    expect(h.bookWordsCountFilters[0]).toEqual([
      { column: 'bookId', op: 'eq', value: CET6_BOOK_ID },
      { column: 'owner_id', op: 'eq', value: 'u-1' },
    ]);
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
    h.cloudWords = 600;
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
});
