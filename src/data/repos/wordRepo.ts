/**
 * wordRepo.ts —— books / words / book_words 读写 + ECDICT 查询。
 * 词书-词关联（BookWord）持有难度层 tier（Q1 决策）。
 */
import type { Book, BookWord, Tier, Word, WordStatus } from '../../types/domain';
import { getDb } from '../cloud';
import { Repository, type CloudDatabaseLike, type Filter } from '../repository';

export interface WordRepo {
  readonly books: Repository<Book>;
  readonly words: Repository<Word>;
  readonly bookWords: Repository<BookWord>;

  createBook(book: Omit<Book, 'id'> & { id?: string }): Promise<Book>;
  getBook(id: string): Promise<Book | null>;
  listBooks(userId: string): Promise<Book[]>;

  upsertWords(words: (Word & Record<string, unknown>)[]): Promise<void>;
  getWordByLemma(lemma: string): Promise<Word | null>;
  searchWordsByPrefix(prefix: string, limit?: number): Promise<Word[]>;

  /** 导入词书：批量写 book_words（tier/list 归属） */
  upsertBookWords(rows: (BookWord & Record<string, unknown>)[]): Promise<void>;
  listBookWords(bookId: string, opts?: { tier?: Tier; listNo?: number; status?: WordStatus }): Promise<BookWord[]>;
  listWordsByIds(ids: string[]): Promise<Word[]>;
  updateWordTier(bookWordId: string, tier: Tier): Promise<BookWord | null>;
  updateBookWordStatus(bookWordId: string, status: WordStatus): Promise<BookWord | null>;
}

/**
 * `id=in.(…)` **单批** id 数上界 —— 防止 URL 超过请求行上限。
 *
 * 依据（按线上真实数据实测，非拍脑袋）：
 *  - `public/seed-cet6.json` 共 5407 词，id 形如 `word_<lemma>`，长度 min/avg/max = 7 / 12.2 / **21**；
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

/** 分片读的并发上限：5407/100 = 55 批，串行约 55 个 RTT；限 5 并发兼顾时延与网关压力 */
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

  return {
    books,
    words,
    bookWords,

    createBook: (book) => books.insert(book),
    getBook: (id) => books.getById(id),
    listBooks: (userId) => books.list([{ column: 'userId', op: 'eq', value: userId }], { orderBy: 'createdAt' }),

    upsertWords: (rows) => words.upsertMany(rows),
    getWordByLemma: async (lemma) => {
      const rows = await words.list([{ column: 'lemma', op: 'eq', value: lemma }], { limit: 1 });
      return rows[0] ?? null;
    },
    searchWordsByPrefix: (prefix, limit = 20) =>
      words.list([{ column: 'lemma', op: 'gte', value: prefix }], { orderBy: 'lemma', ascending: true, limit }),

    upsertBookWords: (rows) => bookWords.upsertMany(rows),
    listBookWords: async (bookId, opts) => {
      const filters: Filter[] = [{ column: 'bookId', op: 'eq', value: bookId }];
      if (opts?.tier != null) filters.push({ column: 'tier', op: 'eq', value: opts.tier });
      if (opts?.listNo != null) filters.push({ column: 'listNo', op: 'eq', value: opts.listNo });
      if (opts?.status != null) filters.push({ column: 'status', op: 'eq', value: opts.status });
      return bookWords.list(filters, { orderBy: 'orderInList', ascending: true });
    },
    /**
     * 按 id 批量取词 —— **必须分片**：入参可能上千（摸底页传入全书 5407 个 wordId），
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
  };
}
