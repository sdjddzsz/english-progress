/**
 * wordRepo.ts —— books / words / book_words 读写 + ECDICT 查询。
 * 词书-词关联（BookWord）持有难度层 tier（Q1 决策）。
 */
import type { Book, BookWord, Tier, Word, WordBookmark, WordStatus } from '../../types/domain';
import { getDb } from '../cloud';
import { Repository, type CloudDatabaseLike, type Filter } from '../repository';

export interface WordRepo {
  readonly books: Repository<Book>;
  readonly words: Repository<Word>;
  readonly bookWords: Repository<BookWord>;
  readonly bookmarks: Repository<WordBookmark>;

  createBook(book: Omit<Book, 'id'> & { id?: string }): Promise<Book>;
  getBook(id: string): Promise<Book | null>;
  listBooks(userId: string): Promise<Book[]>;

  upsertWords(words: (Word & Record<string, unknown>)[]): Promise<void>;
  getWordByLemma(lemma: string): Promise<Word | null>;
  /** 前缀搜索（词形开头匹配）；传空串返回前 limit 个（词书/生词本列表用） */
  searchWordsByPrefix(prefix: string, limit?: number): Promise<Word[]>;

  /** 导入词书：批量写 book_words（tier/list 归属） */
  upsertBookWords(rows: (BookWord & Record<string, unknown>)[]): Promise<void>;
  listBookWords(bookId: string, opts?: { tier?: Tier; listNo?: number; status?: WordStatus }): Promise<BookWord[]>;
  listWordsByIds(ids: string[]): Promise<Word[]>;
  updateWordTier(bookWordId: string, tier: Tier): Promise<BookWord | null>;
  updateBookWordStatus(bookWordId: string, status: WordStatus): Promise<BookWord | null>;
  /**
   * **批量**改层 —— 必须成批，不可逐条（2026-10-13 线上「摸底分层 Failed to fetch」的成因之一）：
   * 一次摸底提交 ~300 条 assignments，逐条 `update` 就是 ~300 个串行请求，
   * 网关/连接扛不住就会整个 `Failed to fetch`（且前面写过的已经落库，重试还会重复写）。
   * 做法：按 id 分片读回原行 → 改 tier → 分片 upsert ⇒ 请求数 2×ceil(n/100)。
   * @returns 实际落库的行数（只读回到的那些；id 不存在则不计）
   */
  updateWordTiers(pairs: { bookWordId: string; tier: Tier }[]): Promise<number>;
  /** 词书总词量（**只数不读**：不要为了算一个比值把整本 8296 行拉下来） */
  countBookWords(bookId: string): Promise<number>;

  // ===== 收藏 / 生词本（用户 2026-10-13 要求的基础功能）=====

  /** 收藏（幂等：id 固定为 `{userId}_{wordId}`，重复收藏覆盖同一条） */
  addBookmark(input: Omit<WordBookmark, 'id'> & { id?: string }): Promise<WordBookmark>;
  /** 取消收藏 */
  removeBookmark(userId: string, wordId: string): Promise<void>;
  /** 生词本列表（按收藏时间倒序） */
  listBookmarks(userId: string): Promise<WordBookmark[]>;
  /** 批量查是否已收藏（详情页/词卡打星用，避免 N+1 查询） */
  listBookmarkedWordIds(userId: string, wordIds: string[]): Promise<Set<string>>;
}

/**
 * `id=in.(…)` **单批** id 数上界 —— 防止 URL 超过请求行上限。
 *
 * 依据（按线上真实数据实测，非拍脑袋）：
 *  - `public/seed-cet6.json` 共 8296 词，id 形如 `word_<lemma>`，长度 min/avg/max = 7 / 12.2 / **21**；
 *  - 不分片时该次查询的 URL ≈ **82,121 字符**（`joined` 未编码 71,221 + 逗号被编码为 `%2C`），
 *    是 SDK `urlLengthLimit`(8000) 的 **10 倍**，也超常见网关/服务器的 **8KB 请求行**上限
 *    ⇒ 浏览器直接报 `TypeError: Failed to fetch`。
 *    ⚠ SDK 的 `urlLengthLimit` **只是给错误附一段 hint**（`lib/index.js` 的 fetch 错误分支），
 *    **既不替你切 POST、也不在发出前拦截** —— 所以「超长就失败」这件事必须由调用方（这里）防住。
 *  - 取 100/批：最坏 `100 × (21 + 3) = 2400` 字符（+3 = 逗号编码 `%2C`）+ base ≈ **2.5KB** ⇒ 3 倍余量；
 *  - 100 与 `Repository.CHUNK_SIZE` 一致，读写分片粒度统一。
 *
 * 导出仅为测试/审计引用（改大它会让「最坏 URL < 8000」的用例失败，从而强制重新推导）。
 */
export const ID_BATCH = 100;

/** 分片读的并发上限：8296/100 = 83 批，串行约 83 个 RTT；限 5 并发兼顾时延与网关压力 */
const ID_BATCH_CONCURRENCY = 5;

/** 限并发映射（结果顺序与输入一致）—— 避免几十个批一次性打满连接 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1; // 单线程、无 await 间隔 ⇒ 无需加锁
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export function createWordRepo(db: CloudDatabaseLike = getDb()): WordRepo {
  const books = new Repository<Book>(db, 'books');
  const words = new Repository<Word>(db, 'words');
  const bookWords = new Repository<BookWord>(db, 'book_words');
  const bookmarks = new Repository<WordBookmark>(db, 'word_bookmarks');

  /** 收藏确定性 ID：同一用户同一词永远只有一条（收藏幂等、取消幂等） */
  const bookmarkId = (userId: string, wordId: string): string => `${userId}_${wordId}`;

  return {
    books,
    words,
    bookWords,
    bookmarks,

    createBook: (book) => books.insert(book),
    getBook: (id) => books.getById(id),
    listBooks: (userId) => books.listAll([{ column: 'userId', op: 'eq', value: userId }], { orderBy: 'createdAt' }),

    upsertWords: (rows) => words.upsertMany(rows),
    getWordByLemma: async (lemma) => {
      const rows = await words.list([{ column: 'lemma', op: 'eq', value: lemma }], { limit: 1 });
      return rows[0] ?? null;
    },
    searchWordsByPrefix: (prefix, limit = 20) =>
      prefix.trim() === ''
        ? words.list([], { orderBy: 'lemma', ascending: true, limit })
        : words.list([{ column: 'lemma', op: 'gte', value: prefix.trim() }], { orderBy: 'lemma', ascending: true, limit }),

    upsertBookWords: (rows) => bookWords.upsertMany(rows),
    /**
     * ⚠ 必须走 `listAll`（自动翻页）而不是 `list`：
     *   服务端 PostgREST 的 max-rows 默认上限是 **1000**，不翻页就会静默只回前 1000 条。
     *   实测（2026-10-13）：5407 行的 book_words 表上，`list` 只返回 1000 条、不报错 ——
     *   导致重建只删/只备份 1000 条（剩 4407 条形同不存在），
     *   且每日队列只会调度到前 1000 个词，词书其余部分永远排不进学习。
     *   详见 `Repository.listAll` 的注释。
     */
    listBookWords: async (bookId, opts) => {
      const filters: Filter[] = [{ column: 'bookId', op: 'eq', value: bookId }];
      if (opts?.tier != null) filters.push({ column: 'tier', op: 'eq', value: opts.tier });
      if (opts?.listNo != null) filters.push({ column: 'listNo', op: 'eq', value: opts.listNo });
      if (opts?.status != null) filters.push({ column: 'status', op: 'eq', value: opts.status });
      return bookWords.listAll(filters, { orderBy: 'orderInList', ascending: true });
    },
    /**
     * 按 id 批量取词 —— **必须分片**：入参可能上千（摸底页传入全书 8296 个 wordId），
     * 单次 `id=in.(…)` 的 URL 会达到 ~82KB，远超请求行上限 ⇒ 浏览器 `Failed to fetch`。
     * 语义：入参先**去重**（避免同一 id 在多批重复取回），各批并发取回后按批序拼接；
     * 输出天然无重复（id 是主键、入参已去重），顺序与批量分片一致（调用方按 id 建 map，不依赖顺序）。
     */
    listWordsByIds: async (ids) => {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return [];
      const batches: string[][] = [];
      for (let i = 0; i < unique.length; i += ID_BATCH) batches.push(unique.slice(i, i + ID_BATCH));
      const pages = await mapLimit(batches, ID_BATCH_CONCURRENCY, (batch) =>
        words.list([{ column: 'id', op: 'in', values: batch }]),
      );
      return pages.flat();
    },
    updateWordTier: (bookWordId, tier) =>
      bookWords.update(bookWordId, { tier, tierUpdatedAt: new Date().toISOString() } as Partial<BookWord>),
    updateBookWordStatus: (bookWordId, status) => bookWords.update(bookWordId, { status } as Partial<BookWord>),
    updateWordTiers: async (pairs) => {
      // 同一 id 多次出现时以最后一条为准（摸底里同 lemma 的多个义项共享一条 book_word）
      const wanted = new Map<string, Tier>();
      for (const p of pairs) {
        if (p && typeof p.bookWordId === 'string' && p.bookWordId) wanted.set(p.bookWordId, p.tier);
      }
      const ids = [...wanted.keys()];
      if (ids.length === 0) return 0;
      const batches: string[][] = [];
      for (let i = 0; i < ids.length; i += ID_BATCH) batches.push(ids.slice(i, i + ID_BATCH));
      const pages = await mapLimit(batches, ID_BATCH_CONCURRENCY, (batch) =>
        bookWords.list([{ column: 'id', op: 'in', values: batch }], { limit: batch.length }),
      );
      const now = new Date().toISOString();
      const patched = pages
        .flat()
        .filter((r) => wanted.has(r.id))
        .map(
          (r) =>
            ({ ...r, tier: wanted.get(r.id) as Tier, tierUpdatedAt: now }) as BookWord & Record<string, unknown>,
        );
      if (patched.length === 0) return 0;
      await bookWords.upsertMany(patched);
      return patched.length;
    },
    countBookWords: (bookId) => bookWords.count([{ column: 'bookId', op: 'eq', value: bookId }]),

    // ===== 收藏 / 生词本 =====

    addBookmark: async (input) => {
      const id = input.id ?? bookmarkId(input.userId, input.wordId);
      // upsertMany 返回 void（仓库契约），而调用方需要拿到落库后的行 → 写完按确定性 id 读回
      await bookmarks.upsertMany([{ ...input, id } as WordBookmark & Record<string, unknown>]);
      const rows = await bookmarks.list([{ column: 'id', op: 'eq', value: id }], { limit: 1 });
      if (rows[0]) return rows[0];
      // 读回为空（极端情况下 RLS 过滤）时返回本地构造的行：调用方至少拿到确定性 id，
      // 不把「写成功但读不到」伪装成失败（该集合 RLS 为 owner-only，命中即本人行）
      return { ...input, id } as WordBookmark;
    },
    removeBookmark: async (userId, wordId) => {
      await bookmarks.remove(bookmarkId(userId, wordId));
    },
    listBookmarks: (userId) =>
      bookmarks.listAll([{ column: 'userId', op: 'eq', value: userId }], { orderBy: 'createdAt', ascending: false }),
    listBookmarkedWordIds: async (userId, wordIds) => {
      const ids = [...new Set(wordIds)].filter(Boolean);
      if (ids.length === 0) return new Set<string>();
      // 与 listWordsByIds 同理：id=in.(…) 必须分片，否则 URL 超请求行上限（实测 7000 个 id ≈ 82KB）
      const batches: string[][] = [];
      for (let i = 0; i < ids.length; i += ID_BATCH) batches.push(ids.slice(i, i + ID_BATCH));
      const pages = await mapLimit(batches, ID_BATCH_CONCURRENCY, (batch) =>
        bookmarks.list(
          [
            { column: 'userId', op: 'eq', value: userId },
            { column: 'wordId', op: 'in', values: batch },
          ],
          { limit: batch.length },
        ),
      );
      return new Set(pages.flat().map((b) => b.wordId));
    },
  };
}
