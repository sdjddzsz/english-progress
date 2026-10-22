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
  /**
   * 用户长按编辑/删除义项后的写回（用户 2026-10-18）。
   * 整行 upsert（lemma 冲突即更新）——words 表 RLS 只放行 insert 通道，
   * 单独 PATCH 会被拒；词级 senses/pos 已由 applySenseEdit/applySenseDelete 同步好，这里只负责落库。
   */
  updateWordSenses(word: Word): Promise<void>;
  /**
   * 新一轮开局：轮标线批量归零（用户 2026-10-18「进入新一轮的单词得从零开始计数」）。
   * 打法同 updateWordTiers：按 id 分片**读回原行** → 只改 quizDayStreak/quizDayPassed 两列 → upsert。
   * 为什么不收调用方的行、要读回：① 云端值才是权威，读回能顺带修掉昔日失败残留的旧值；
   * ② 离线补传重放时以云端现值为基底，不会把调用方开局快照的其它列（tier/streak…）写旧；
   * ③ skipAnsweredSince 让「入队后又答过题」的词不被归零误伤——作答自己的写回才权威。
   * 两列本就是 0/未过关的行不写（无变化不落库）。
   * @returns 实际归零的行数
   */
  resetRoundStreaks(ids: string[], opts?: { skipAnsweredSince?: string }): Promise<number>;
  getWordByLemma(lemma: string): Promise<Word | null>;
  /** 前缀搜索（词形开头匹配）；传空串返回前 limit 个（词书/生词本列表用） */
  searchWordsByPrefix(prefix: string, limit?: number): Promise<Word[]>;

  /** 导入词书：批量写 book_words（tier/list 归属） */
  upsertBookWords(rows: (BookWord & Record<string, unknown>)[]): Promise<void>;
  listBookWords(
    bookId: string,
    opts?: {
      tier?: Tier;
      listNo?: number;
      status?: WordStatus;
      /** 四阶段制（2026-10-22）：按阶段过滤（服务端） */
      stage?: BookWord['stage'];
      onPage?: (loaded: number) => void;
    },
  ): Promise<BookWord[]>;
  listWordsByIds(ids: string[]): Promise<Word[]>;
  updateWordTier(bookWordId: string, tier: Tier): Promise<BookWord | null>;
  /**
   * 考查制单题结果写回（用户 2026-10-14 新判定机制）：
   * tier / streak / failStreak / specialTraining / lastQuizAt 一次落库。
   * 单题单请求（一次考查 50 题 = 50 个串行写，逐题发生、频率低，可接受；
   * 与「批量改层必须成批」的教训不冲突——那是 300 条同刻写入的场景）。
   */
  updateBookWordQuiz(
    bookWordId: string,
    patch: {
      tier: Tier;
      streak: number;
      failStreak: number;
      specialTraining: boolean;
      lastQuizAt: string;
      quizDayStreak: number;
      quizDayPassed: boolean;
      /** 四阶段制（用户 2026-10-15）：阶段与阶段内连续熟练次数一并落库 */
      stage?: BookWord['stage'];
      stageStreak?: number;
    },
  ): Promise<BookWord | null>;
  updateBookWordStatus(bookWordId: string, status: WordStatus): Promise<BookWord | null>;
  /**
   * 重置单个词的考查进度（用户 2026-10-15：词书页行内手动重置）。
   * 考查 6 字段清零 + tier 回 T4（「清除重来」语义），tierUpdatedAt 记录操作时间。
   */
  resetQuizProgress(bookWordId: string): Promise<BookWord | null>;
  /**
   * 重置全书考查进度（用户 2026-10-15：进度坏完了清除重来）。
   * 只重置**有进度痕迹**的行（streak/failStreak/lastQuizAt/quizDayStreak/specialTraining 任一非默认），
   * 避免对 8296 行无差别 upsert。返回实际重置的行数。
   */
  resetAllQuizProgress(bookId: string): Promise<number>;
  /**
   * **批量**改层 —— 必须成批，不可逐条（2026-10-13 线上「摸底分层 Failed to fetch」的成因之一）：
   * 一次摸底提交 ~300 条 assignments，逐条 `update` 就是 ~300 个串行请求，
   * 网关/连接扛不住就会整个 `Failed to fetch`（且前面写过的已经落库，重试还会重复写）。
   * 做法：按 id 分片读回原行 → 改 tier → 分片 upsert ⇒ 请求数 2×ceil(n/100)。
   * @returns 实际落库的行数（只读回到的那些；id 不存在则不计）
   */
  updateWordTiers(pairs: { bookWordId: string; tier: Tier }[]): Promise<number>;
  /**
   * 批量调阶段（用户 2026-10-15 四阶段制：词书页多选手动调整）。
   * 晋级/调阶时 stageStreak 清零（连续熟练按阶段重新计）。
   */
  updateWordStages(pairs: { bookWordId: string; stage: BookWord['stage'] }[]): Promise<number>;
  /** 词书总词量（**只数不读**：不要为了算一个比值把整本 8296 行拉下来） */
  countBookWords(bookId: string): Promise<number>;
  /**
   * 某阶段的词量（只数不读；阶段详情页头部「本阶段词库 N 词」/ 分页页数用）。
   * stage=0 即「已彻底毕业」计数。
   */
  countBookWordsByStage(bookId: string, stage: BookWord['stage']): Promise<number>;
  /**
   * 阶段词表的**一页**行（服务端过滤 + 服务端分页，用户 2026-10-22）。
   *
   * 为什么必须服务端分页：阶段详情页原来走 `listBookWords(bookId)` 拉**整本** 8296 行
   * （9 个串行分页请求）再在客户端按 stage 过滤——页面上只显示 100 行，却把 1.7MB
   * 全拉下来；慢网络下用户体感就是「词表打不开」。
   * 现在：filters 加 stage ⇒ 只回该阶段的行；orders = tier.desc + id.asc
   * （展示序 T4→T1，同层内按主键稳定序，翻页不会重复/漏行）。
   */
  listBookWordsPage(
    bookId: string,
    opts: { stage: BookWord['stage']; offset: number; limit: number },
  ): Promise<BookWord[]>;
  /**
   * 按 wordId 批量取词书行（分片 `in` 查询）。
   *
   * 为什么必须有：摸底**提交**时只需要本次答过的 ≤300 个词对应的 bookWord 行
   * （用来把义项判定映射回 bookWordId），但原实现走 `listBookWords(bookId)`
   * 把整本 8296 行拉下来（9 个分页请求）——
   * 这正是 2026-10-14 线上「答完 300 题点提交后卡在分层环节」的成因。
   * 改为只取需要的那些行：请求数 ceil(300/100)=3，行数 300。
   */
  listBookWordsByWordIds(bookId: string, wordIds: string[]): Promise<BookWord[]>;
  /**
   * 各层词量（4 个 `count` 并发，只回数字不回行）。
   * 原实现为了统计 tier 分布把整本 8296 行拉下来算 —— 同一个坑的第二次踩点。
   */
  countBookWordsByTier(bookId: string): Promise<Record<Tier, number>>;

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

  const impl: WordRepo = {
    books,
    words,
    bookWords,
    bookmarks,

    createBook: (book) => books.insert(book),
    getBook: (id) => books.getById(id),
    listBooks: (userId) => books.listAll([{ column: 'userId', op: 'eq', value: userId }], { orderBy: 'createdAt' }),

    upsertWords: (rows) => words.upsertMany(rows),
    updateWordSenses: (word) =>
      words.upsertMany([word as Word & Record<string, unknown>]),
    resetRoundStreaks: async (ids, opts) => {
      const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
      if (unique.length === 0) return 0;
      const batches: string[][] = [];
      for (let i = 0; i < unique.length; i += ID_BATCH) batches.push(unique.slice(i, i + ID_BATCH));
      const pages = await mapLimit(batches, ID_BATCH_CONCURRENCY, (batch) =>
        bookWords.list([{ column: 'id', op: 'in', values: batch }], { limit: batch.length }),
      );
      const since = opts?.skipAnsweredSince;
      const zeroed = pages
        .flat()
        // 只碰真有计数/过关标记的行（无变化不落库）
        .filter((r) => (r.quizDayStreak ?? 0) !== 0 || Boolean(r.quizDayPassed))
        // 入队后又答过题的词不归零：那次作答的写回才是权威（lastQuizAt > since）
        .filter((r) => !since || !r.lastQuizAt || r.lastQuizAt <= since)
        .map((r) => ({ ...r, quizDayStreak: 0, quizDayPassed: false } as BookWord & Record<string, unknown>));
      if (zeroed.length === 0) return 0;
      await bookWords.upsertMany(zeroed);
      return zeroed.length;
    },
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
      if (opts?.stage != null) filters.push({ column: 'stage', op: 'eq', value: opts.stage });
      // ⚠ 分页排序键**必须唯一**：listAll 靠 offset 翻页，而非唯一列会让 Postgres 不保证跨页稳定
      // （行重复出现 / 部分行永不出现）。原先用 `orderInList` —— 它在 listSize=50 的切分下
      // 8296 行里只有 166 个不同值，重复率极高，属于典型的「翻页排序键不唯一」错误。
      // 改为主键 id（唯一）。需要词频序的调用方请自行排序 —— `pickBookWordSample` 就是这么做的。
      return bookWords.listAll(filters, { orderBy: 'id', ascending: true, ...(opts?.onPage ? { onPage: opts.onPage } : {}) });
    },
    /**
     * 阶段词表的一页（服务端 stage 过滤 + 服务端分页，用户 2026-10-22）：
     * 排序 = tier.desc（展示序 T4→T1）+ id.asc（主键稳定键，翻页不重不漏）。
     * 单次 `list()`（不走 listAll 翻页循环）：offset/limit 由调用方按页算好。
     */
    listBookWordsPage: async (bookId, { stage, offset, limit }) =>
      bookWords.list(
        [
          { column: 'bookId', op: 'eq', value: bookId },
          { column: 'stage', op: 'eq', value: stage },
        ],
        { orders: [{ column: 'tier', ascending: false }, { column: 'id', ascending: true }], offset, limit },
      ),
    /** 某阶段词量（只数不读）；stage=0 = 已彻底毕业计数 */
    countBookWordsByStage: (bookId, stage) =>
      bookWords.count([
        { column: 'bookId', op: 'eq', value: bookId },
        { column: 'stage', op: 'eq', value: stage },
      ]),
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
    updateBookWordQuiz: (bookWordId, patch) =>
      bookWords.update(bookWordId, {
        ...patch,
        tierUpdatedAt: new Date().toISOString(),
      } as Partial<BookWord>),
    updateBookWordStatus: (bookWordId, status) => bookWords.update(bookWordId, { status } as Partial<BookWord>),
    resetQuizProgress: (bookWordId) =>
      bookWords.update(
        bookWordId,
        {
          tier: 4,
          tierUpdatedAt: new Date().toISOString(),
          streak: 0,
          failStreak: 0,
          specialTraining: false,
          lastQuizAt: null,
          quizDayStreak: 0,
          quizDayPassed: false,
          stage: 1,
          stageStreak: 0,
        } as unknown as Partial<BookWord>,
      ),
    resetAllQuizProgress: async (bookId) => {
      const all = await impl.listBookWords(bookId);
      const dirty = all.filter(
        (bw) =>
          bw.streak > 0 ||
          bw.failStreak > 0 ||
          bw.specialTraining ||
          Boolean(bw.lastQuizAt) ||
          (bw.quizDayStreak ?? 0) > 0 ||
          Boolean(bw.quizDayPassed) ||
          (bw.stage ?? 1) !== 1 ||
          (bw.stageStreak ?? 0) > 0,
      );
      if (dirty.length === 0) return 0;
      const now = new Date().toISOString();
      const patched = dirty.map(
        (bw) =>
          ({
            ...bw,
            tier: 4,
            tierUpdatedAt: now,
            streak: 0,
            failStreak: 0,
            specialTraining: false,
            lastQuizAt: null,
            quizDayStreak: 0,
            quizDayPassed: false,
            stage: 1,
            stageStreak: 0,
          }) as unknown as BookWord & Record<string, unknown>,
      );
      await impl.upsertBookWords(patched);
      return patched.length;
    },
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

    updateWordStages: async (pairs) => {
      const wanted = new Map<string, BookWord['stage']>();
      for (const p of pairs) {
        if (p && typeof p.bookWordId === 'string' && p.bookWordId) wanted.set(p.bookWordId, p.stage);
      }
      const ids = [...wanted.keys()];
      if (ids.length === 0) return 0;
      const batches: string[][] = [];
      for (let i = 0; i < ids.length; i += ID_BATCH) batches.push(ids.slice(i, i + ID_BATCH));
      const pages = await mapLimit(batches, ID_BATCH_CONCURRENCY, (batch) =>
        bookWords.list([{ column: 'id', op: 'in', values: batch }], { limit: batch.length }),
      );
      const patched = pages
        .flat()
        .filter((r) => wanted.has(r.id))
        .map(
          (r) =>
            ({
              ...r,
              stage: wanted.get(r.id) as BookWord['stage'],
              stageStreak: 0, // 调阶后连续熟练按新阶段重新计
            }) as BookWord & Record<string, unknown>,
        );
      if (patched.length === 0) return 0;
      await bookWords.upsertMany(patched);
      return patched.length;
    },

    listBookWordsByWordIds: async (bookId, wordIds) => {
      const unique = [...new Set(wordIds.filter((w): w is string => typeof w === 'string' && w.length > 0))];
      if (unique.length === 0) return [];
      const batches: string[][] = [];
      for (let i = 0; i < unique.length; i += ID_BATCH) batches.push(unique.slice(i, i + ID_BATCH));
      const pages = await mapLimit(batches, ID_BATCH_CONCURRENCY, (batch) =>
        bookWords.list(
          [
            { column: 'bookId', op: 'eq', value: bookId },
            { column: 'wordId', op: 'in', values: batch },
          ],
          { limit: batch.length },
        ),
      );
      return pages.flat();
    },

    countBookWordsByTier: async (bookId) => {
      const tiers: Tier[] = [1, 2, 3, 4];
      const counts = await Promise.all(
        tiers.map((t) =>
          bookWords.count([
            { column: 'bookId', op: 'eq', value: bookId },
            { column: 'tier', op: 'eq', value: t },
          ]),
        ),
      );
      return { 1: counts[0], 2: counts[1], 3: counts[2], 4: counts[3] } as Record<Tier, number>;
    },

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
  } satisfies WordRepo;
  return impl;
}
