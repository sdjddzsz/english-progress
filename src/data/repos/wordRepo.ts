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
    listWordsByIds: (ids) =>
      ids.length === 0 ? Promise.resolve([]) : words.list([{ column: 'id', op: 'in', values: ids }]),
    updateWordTier: (bookWordId, tier) =>
      bookWords.update(bookWordId, { tier, tierUpdatedAt: new Date().toISOString() } as Partial<BookWord>),
    updateBookWordStatus: (bookWordId, status) => bookWords.update(bookWordId, { status } as Partial<BookWord>),
  };
}
