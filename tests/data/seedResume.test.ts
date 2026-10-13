/**
 * seedResume.test.ts —— 词书初始化「断点续传」回归锚点（2026-10-13）。
 *
 * 背景：初始化六级词库要写 5407 词 × 2 表（words / book_words）≈ 110 个分片请求；
 * 断网 / 超时中断后原实现只能从头再传（幂等但白跑）。现改为本机 localStorage 游标续传：
 *  - 游标只在「某分片已确认落库」之后前进 → 永不谎报进度；
 *  - 失败重试从断点所在分片边界继续，已成功的分片零请求；
 *  - 两张表各自独立进度（推进一张不得把另一张覆盖成 0）；
 *  - 整次成功后才清游标；种子文件行数变了（totals 对不上）则丢弃旧游标；
 *  - 存储不可用（无 localStorage / 读写抛错）→ 降级为「无游标」，绝不打断导入；
 *  - key 按 **userId** 隔离：同浏览器换账号不得继承他人进度（H）；userId 为假值时不使用游标（I）。
 *
 * 测试口径（沿用 backfillArpabet / resilience 的既有风格）：
 *  mock repo（记录每个分片收到的行数；可指定第 N 次 upsertWords 抛错）
 *  + stubGlobal('fetch') 返回内存种子 + localStorage shim（另测抛错版 / undefined 版降级）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CHUNK = 300;
/** 1000 词 → words 分片 4 个（300/300/300/100），便于构造「第 3 片失败」 */
const TOTAL = 1000;
const SEED = Array.from({ length: TOTAL }, (_, i) => ({
  lemma: `w${i}`,
  ipa: `/w${i}/`,
  translation: `t${i}`,
  frq: TOTAL - i,
  tags: ['cet6'],
}));

const h = vi.hoisted(() => ({
  wordsCalls: [] as number[],
  bookWordCalls: [] as number[],
  /** 1-based：第 N 次 upsertWords 调用抛错；-1 = 从不失败 */
  failWordsCall: -1,
  bookExists: false,
  createBookCalls: 0,
}));

vi.mock('../../src/data/repos/wordRepo', () => ({
  createWordRepo: () => ({
    getBook: async () => (h.bookExists ? { id: 'book_cet6_full', wordCount: 0 } : null),
    upsertWords: async (rows: unknown[]) => {
      h.wordsCalls.push(rows.length);
      if (h.failWordsCall === h.wordsCalls.length) throw new Error('boom-words');
    },
    upsertBookWords: async (rows: unknown[]) => {
      h.bookWordCalls.push(rows.length);
    },
    createBook: async (b: unknown) => {
      h.createBookCalls += 1;
      return b;
    },
  }),
}));

const { CET6_BOOK_ID, getSeedCursor, seedCursorKey, seedLibraryToCloud } = await import(
  '../../src/data/seedBootstrap'
);

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
function storedCursor(
  userId: string,
): { words: number; bookWords: number; totalWords: number; totalBookWords: number } | null {
  const raw = storage.get(seedCursorKey(CET6_BOOK_ID, userId));
  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  h.wordsCalls.length = 0;
  h.bookWordCalls.length = 0;
  h.failWordsCall = -1;
  h.bookExists = false;
  h.createBookCalls = 0;
  installLocalStorage();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(SEED), { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('seedLibraryToCloud 断点续传', () => {
  it('A. 分片失败即整体抛出，游标停在「已确认落库」的分片数（不谎报）', async () => {
    h.failWordsCall = 3; // 第 3 个 words 分片抛错
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words');

    expect(h.wordsCalls).toEqual([CHUNK, CHUNK, CHUNK]); // 前两片成功，第 3 片尝试后失败
    expect(storedCursor('u-1')).toEqual({ words: 600, bookWords: 0, totalWords: TOTAL, totalBookWords: TOTAL });
    expect(h.bookWordCalls).toEqual([]); // words 未完成，绝不进入 book_words
    expect(h.createBookCalls).toBe(0);
  });

  it('B. 保留游标重试：只传剩余分片（已成功分片零请求），随后完成并上报绝对进度', async () => {
    h.failWordsCall = 3;
    await expect(seedLibraryToCloud('u-1')).rejects.toThrow('boom-words');

    // 重试：清掉调用记录，不再注入失败
    h.wordsCalls.length = 0;
    h.failWordsCall = -1;
    const progress: { step: string; done: number; total: number }[] = [];
    const result = await seedLibraryToCloud('u-1', (p) => progress.push({ ...p }));

    expect(h.wordsCalls).toEqual([CHUNK, TOTAL - 3 * CHUNK]); // 只剩第 3、4 片（600..999）
    expect(h.bookWordCalls).toEqual([CHUNK, CHUNK, CHUNK, TOTAL - 3 * CHUNK]); // book_words 从未开始 → 全量
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

  it('D. 某表游标已到总行数：该表整步跳过（零请求）但仍上报该步完成', async () => {
    storage.set(
      seedCursorKey(CET6_BOOK_ID, 'u-1'),
      JSON.stringify({ words: TOTAL, bookWords: 0, totalWords: TOTAL, totalBookWords: TOTAL }),
    );
    const progress: { step: string; done: number; total: number }[] = [];
    await seedLibraryToCloud('u-1', (p) => progress.push({ ...p }));

    expect(h.wordsCalls).toEqual([]); // words 已满 → 零请求
    expect(h.bookWordCalls).toEqual([CHUNK, CHUNK, CHUNK, TOTAL - 3 * CHUNK]);
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
    expect(h.wordsCalls).toEqual([CHUNK, CHUNK, CHUNK, TOTAL - 3 * CHUNK]); // 无游标 → 从头全量
  });

  it('F. 种子文件行数变过（游标 totals 对不上）→ 丢弃旧游标，从头全量', async () => {
    storage.set(
      seedCursorKey(CET6_BOOK_ID, 'u-1'),
      JSON.stringify({ words: 600, bookWords: 0, totalWords: 999, totalBookWords: TOTAL }),
    );
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual([CHUNK, CHUNK, CHUNK, TOTAL - 3 * CHUNK]); // 未按 600 续传
  });

  it('G. 游标恰落在分片边界（< 总行数）→ 从该边界继续，不重传之前的整片', async () => {
    storage.set(
      seedCursorKey(CET6_BOOK_ID, 'u-1'),
      JSON.stringify({ words: 3 * CHUNK, bookWords: 0, totalWords: TOTAL, totalBookWords: TOTAL }),
    );
    await seedLibraryToCloud('u-1');
    expect(h.wordsCalls).toEqual([TOTAL - 3 * CHUNK]); // 只剩最后一片（900..999）
  });

  /**
   * H 是「游标必须按 userId 隔离」的护栏（2026-10-13 自查发现的真缺陷）：
   * 只按 bookId 存时，同浏览器换账号会继承上一账号的游标，且自校验只比种子行数、不比用户 →
   * 通过 → 新账号静默跳过前 N 行且不报错。
   * 变异验证：把 seedCursorKey 改回「不带 userId」后，本用例必须变红。
   */
  it('H. 同浏览器换账号：B 不继承 A 的游标（全量导入），且 B 的导入不动 A 的进度', async () => {
    // 账号 A 跑到中断：words 第 3 片失败 → A 的游标停在 600
    h.failWordsCall = 3;
    await expect(seedLibraryToCloud('A')).rejects.toThrow('boom-words');
    const aBefore = storage.get(seedCursorKey(CET6_BOOK_ID, 'A'));
    expect(aBefore).toBeTruthy();

    // 切到账号 B（同一 localStorage，不清存储）：B 的 key 不同 → 必须从 0 全量
    h.wordsCalls.length = 0;
    h.bookWordCalls.length = 0;
    h.failWordsCall = -1;
    await seedLibraryToCloud('B');
    expect(h.wordsCalls).toEqual([CHUNK, CHUNK, CHUNK, TOTAL - 3 * CHUNK]);
    expect(h.bookWordCalls).toEqual([CHUNK, CHUNK, CHUNK, TOTAL - 3 * CHUNK]);

    // A 的进度原封不动（逐字节相同）；B 成功后只清自己的
    expect(storage.get(seedCursorKey(CET6_BOOK_ID, 'A'))).toBe(aBefore);
    expect(storage.has(seedCursorKey(CET6_BOOK_ID, 'B'))).toBe(false);
  });

  it('I. userId 为假值：不使用游标（不读不写、不落 undefined 键），仅全量幂等', async () => {
    await seedLibraryToCloud('');
    expect(h.wordsCalls).toEqual([CHUNK, CHUNK, CHUNK, TOTAL - 3 * CHUNK]); // 全量
    expect(getSeedCursor('')).toBeNull();
    expect(storage.size).toBe(0); // 一个键都没写（尤其没有 seed-progress:undefined:...）
  });
});
