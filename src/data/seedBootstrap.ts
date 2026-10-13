/**
 * seedBootstrap.ts —— 首次使用初始化：ECDICT 六级全量种子入库（部署补丁，原 T05 导入入口）。
 *
 * 数据源 public/seed-cet6.json（~1.1MB，5407 词）：
 *  - 不进 PWA precache（vite.config globPatterns 不含 .json），按需 fetch，一次性在线操作；
 *  - 幂等：按 id upsert 冲突跳过；book 行已存在则整体跳过，可安全重复点击；
 *  - 断点续传：本机 localStorage 游标只记录「已确认落库的整片」，失败重试从断点继续，
 *    不白跑已成功分片；换设备 / 清缓存则从头幂等全量导入（安全，只是多做一遍）；
 *  - 数据归属当前登录用户（owner_id 由服务端 DEFAULT auth.uid() 填充）。
 *
 * 不 import ./seed/importEcdict —— 该文件含 process.argv 浏览器端不可用；
 * 词 → 领域文档的转换逻辑在此内联（与 importEcdict.seedToDomainDocs 保持一致）。
 */
import type { BookWord, Word } from '../types/domain';
import { createWordRepo } from './repos/wordRepo';

/** 六级全量词书 id（seedBootstrap 初始化 + backfillArpabet 回填共用同一常量） */
export const CET6_BOOK_ID = 'book_cet6_full';
const LIST_SIZE = 50;
const CHUNK = 300; // 每批 upsert 行数，控制单请求体积

// ===== 断点续传游标（本机 localStorage）=====
//
// 取舍：游标只存本机 —— 换设备 / 清缓存后读不到游标，会从头做一次幂等全量导入（安全，只是多跑请求）。
// 隔离：key 必须按 **userId** 隔离（同浏览器换账号时不能继承他人进度），见 seedCursorKey。
// 语义：游标只在「某个分片已确认落库」之后前进，因此它永远不会声称未确认的进度；
//       配合 upsert(onConflict:'id')，即便游标落后（例如响应丢失但已写入），也只是重复写同一批，绝不丢数据。
// 信任：游标**不**被无条件信任 —— 接受前必须过两道校验：内容指纹（seedFingerprint）+ 云端行数对账
//       （planStart）。二者任一不通过即降级为全量幂等。

/** 续传游标：两张表各自已确认落库的行数 + 种子文件当时的行数 + 种子内容指纹 */
export interface SeedCursor {
  words: number;
  bookWords: number;
  /** 仅供 UI 展示「上次中断于 N/M」；**不得**作为「是否接受游标」的判据（判据是 fingerprint） */
  totalWords: number;
  totalBookWords: number;
  /**
   * 种子内容指纹（修缺陷②：同词数、不同内容时必须丢弃旧游标）。
   * 由 seedFingerprint 从**当次 fetch 到的种子**派生；与游标里的值不一致 → 丢弃游标走全量。
   */
  fingerprint: string;
}

/**
 * 种子内容指纹 —— 便宜、稳定、确定性（5407 条零负担）：
 *   `<len>|<首 lemma>|<末 lemma>|<FNV-1a 校验和>`
 * 刻意不做 `JSON.stringify` 整包 hash（1.1MB 每次白算，没必要且慢）。
 * 校验和按 lemma 逐条 FNV-1a（32 位，`Math.imul` 保精度），词间混入分隔符避免拼接歧义
 * （否则 ["ab","c"] 与 ["a","bc"] 会撞成同一个值）。
 *
 * ⚠ **遍历顺序必须与 seedToDocs 一致（都是 seed 数组序）**：本函数对顺序敏感（内部两词对调即变值），
 * 若与生成 words 的顺序不一致，同一份文件两次跑会算出不同指纹 → 判定「种子变过」→ 每次都全量重灌，
 * 指纹也就形同虚设。两边若要改，必须一起改。
 */
export function seedFingerprint(seed: SeedWord[]): string {
  const len = seed.length;
  const first = seed[0]?.lemma ?? '';
  const last = seed[len - 1]?.lemma ?? '';
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (const w of seed) {
    const s = w.lemma;
    for (let i = 0; i < s.length; i += 1) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0; // FNV prime；>>>0 保持无符号 32 位
    }
    hash ^= 0x1f; // 词间分隔
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${len}|${first}|${last}|${hash.toString(16)}`;
}

/**
 * localStorage key。
 *
 * ⚠ 必须按 **userId** 隔离：游标是「某人导入到哪儿」的进度，不是「这台机器导入到哪儿」的进度。
 * 若只按 bookId 存，同浏览器换账号（登出再登入 / 共用设备）时新账号会读到上一账号的游标，
 * 而自校验只比种子文件行数、不比用户 → 会通过 → 新账号的导入**静默跳过前 N 行且不报错**。
 * （不要改成「检测到 userId 变化就清游标」——多账号交错时会误清他人进度，key 隔离才是正解。）
 */
export function seedCursorKey(bookId: string, userId: string): string {
  return `seed-progress:${userId}:${bookId}`;
}

/**
 * 读游标。以下情形一律返回 null（= 无游标）：
 *  - userId 为假值：没有身份就无从归属进度，**不读**（也绝不拼出 `seed-progress:undefined:...` 这类键）；
 *  - 存储不可用（node/worker/SSR 无 localStorage、隐私模式）；
 *  - 内容损坏。
 * **绝不**因存储异常打断导入。
 */
function readCursor(userId: string | null | undefined): SeedCursor | null {
  try {
    if (!userId) return null;
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(seedCursorKey(CET6_BOOK_ID, userId));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<SeedCursor>;
    if (
      typeof p.words !== 'number' ||
      typeof p.bookWords !== 'number' ||
      typeof p.totalWords !== 'number' ||
      typeof p.totalBookWords !== 'number' ||
      typeof p.fingerprint !== 'string'
    ) {
      return null;
    }
    return {
      words: p.words,
      bookWords: p.bookWords,
      totalWords: p.totalWords,
      totalBookWords: p.totalBookWords,
      fingerprint: p.fingerprint,
    };
  } catch {
    return null;
  }
}

/** 写游标。userId 为假值时不写；存储异常（配额满 / 被禁用）时静默降级，绝不影响导入 */
function saveCursor(userId: string | null | undefined, c: SeedCursor): void {
  try {
    if (!userId) return;
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(seedCursorKey(CET6_BOOK_ID, userId), JSON.stringify(c));
  } catch {
    /* 存储不可用：降级为「无游标」 */
  }
}

/** 清游标。**只**在整次导入成功（books 行已落地）后调用，否则下次全新导入会被错误跳过 */
function clearCursor(userId: string | null | undefined): void {
  try {
    if (!userId) return;
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(seedCursorKey(CET6_BOOK_ID, userId));
  } catch {
    /* 存储不可用：无游标可清，忽略 */
  }
}

/**
 * 供词书页展示「上次导入中断于 N/M」。
 * ⚠ 必须传**与 seedLibraryToCloud 同一个 userId**，否则页面读到的 key 与实际写入的 key 不一致，
 *    续传提示会与真实续传点对不上（表现为提示 0/5407 但实际从 600 续、或反之）。
 */
export function getSeedCursor(userId: string | null | undefined): SeedCursor | null {
  return readCursor(userId);
}

interface SeedWord {
  lemma: string;
  ipa: string;
  /** CMUdict ARPAbet 发音真源（T7 seed v2；未命中词无此字段 → P0-9 降级） */
  arpabet?: string;
  translation: string;
  frq: number;
  tags: string[];
}

export interface SeedProgress {
  step: 'fetching' | 'words' | 'book_words' | 'book' | 'done';
  done: number;
  total: number;
}

export interface SeedResult {
  bookId: string;
  words: number;
  bookWords: number;
  skipped: boolean;
}

/** 种子词 → Word / BookWord 领域文档（初始分层：词频前 25% → T2，25–60% → T3，其余 → T4；正式分层由摸底校准覆盖） */
export function seedToDocs(
  seed: SeedWord[],
  bookId: string,
  listSize: number,
): { words: Word[]; bookWords: BookWord[] } {
  const words: Word[] = [];
  const bookWords: BookWord[] = [];
  seed.forEach((w, idx) => {
    const tier = idx < seed.length * 0.25 ? 2 : idx < seed.length * 0.6 ? 3 : 4;
    const wordId = `word_${w.lemma}`;
    words.push({
      id: wordId,
      lemma: w.lemma,
      // ipa 用 seed 文件内派生值（arpabetToIpa 派生的唯一展示真源）；arpabet 命中才透传（P0-9）
      ipa: w.ipa,
      ...(w.arpabet ? { arpabet: w.arpabet } : {}),
      senses: w.translation ? [w.translation] : [],
      examples: [],
      frequency: w.frq,
      tags: w.tags,
    });
    bookWords.push({
      id: `bw_${bookId}_${w.lemma}`,
      bookId,
      wordId,
      listNo: Math.floor(idx / listSize) + 1,
      orderInList: (idx % listSize) + 1,
      tier: tier as BookWord['tier'],
      tierUpdatedAt: new Date().toISOString(),
      status: 'normal',
    });
  });
  return { words, bookWords };
}

/**
 * 分片 upsert（支持断点续传）。
 *
 * @param opts.startAt     从该行号之后继续；**向下取整到 chunk 边界**，保证只从「已确认落库的整片」
 *                         之后接着写（绝不半片续传）。
 * @param opts.onChunkDone 某个分片 **await 成功之后**回调（绝对行号）；游标只在此处推进，
 *                         因此游标永远不会声称未确认的进度。
 * @returns rows.length（总行数，与是否续传无关）
 */
async function upsertChunked(
  rows: (Word | BookWord)[],
  upsert: (batch: (Word | BookWord)[]) => Promise<void>,
  onProgress: (done: number, total: number) => void,
  opts?: { startAt?: number; onChunkDone?: (done: number) => void },
): Promise<number> {
  const startAt = Math.max(0, Math.floor((opts?.startAt ?? 0) / CHUNK) * CHUNK);
  for (let i = startAt; i < rows.length; i += CHUNK) {
    await upsert(rows.slice(i, i + CHUNK));
    const done = Math.min(i + CHUNK, rows.length);
    onProgress(done, rows.length);
    opts?.onChunkDone?.(done);
  }
  return rows.length;
}

/**
 * 对账 count 请求失败 → 返回 null（= 对账失败）。调用方必须据此走全量，**绝不**沿用游标跳过。
 *
 * ⚠ 两种「拿不到可信计数」的情形都朝**安全方向**降级：
 *  1. count 抛错（超时 / 403 抖动 / 网络）→ 这里捕获为 null → `planStart` 归 0（全量幂等）；
 *  2. 请求成功但信封里没有 count（`Repository.count` 是 `env.count ?? 0`，见 repository.ts:136）
 *     → 得到 0 → `planStart` 同样归 0（全量）。若这个兜底值不是 0 而是别的（如 total），
 *     就会退化成「对账通过但值是错的」——那比没有对账更坏。**改动这里必须保住 0 这个方向。**
 */
async function countOrNull(count: () => Promise<number>): Promise<number | null> {
  try {
    return await count();
  } catch {
    return null;
  }
}

/**
 * 续传起点（修缺陷①的核心）：`floor(min(游标值, 云端实测行数, 总行数) / CHUNK) * CHUNK`。
 * 语义：**绝不允许跳过云端实际不存在的行** —— 云端少了就自动回退，多出的部分由幂等 upsert 补齐。
 * `cloudCount === null`（对账失败）→ 返回 0（全量幂等），绝不沿用游标。
 */
export function planStart(cursorValue: number, cloudCount: number | null, total: number): number {
  if (cloudCount === null) return 0;
  const effective = Math.max(0, Math.min(cursorValue, cloudCount, total));
  return Math.floor(effective / CHUNK) * CHUNK;
}

/**
 * 初始化六级全量词库。userId 为当前登录用户（写进 books 行，便于词书列表归属展示）。
 *
 * 续传安全性（两处硬保证）：
 *  ② 游标自校验**以种子内容指纹为准**（`seedFingerprint`）—— 同词数不同内容时旧游标必被丢弃；
 *  ① 续传前**与云端对账**（`Repository.count`，head 请求）—— 续传起点只到「云端确实已存在」的
 *     分片边界，避免某片「假成功」（响应成功却未落库）导致游标超前于现实、永久跳过缺口；
 *     对账失败一律降级为全量幂等。
 * 其余：某张表云端已齐则整步跳过（零请求）；每个分片确认落库后推进游标；整体成功后清游标。
 */
export async function seedLibraryToCloud(
  userId: string,
  onProgress?: (p: SeedProgress) => void,
): Promise<SeedResult> {
  const repo = createWordRepo();

  // 幂等：书行已存在视为已初始化
  const existing = await repo.getBook(CET6_BOOK_ID);
  if (existing) {
    return { bookId: CET6_BOOK_ID, words: existing.wordCount, bookWords: existing.wordCount, skipped: true };
  }

  onProgress?.({ step: 'fetching', done: 0, total: 0 });
  const res = await fetch('/seed-cet6.json');
  if (!res.ok) throw new Error(`seed dataset fetch failed: HTTP ${res.status}`);
  const seed = (await res.json()) as SeedWord[];
  if (!Array.isArray(seed) || seed.length === 0) throw new Error('seed dataset is empty or malformed');

  const { words, bookWords } = seedToDocs(seed, CET6_BOOK_ID, LIST_SIZE);
  const fingerprint = seedFingerprint(seed);

  // 自校验（修缺陷②）：**以指纹为准** —— 同词数但内容变过时旧游标必须丢弃。
  // totals 只保留给 UI 展示，不作为「是否接受游标」的判据。
  const stored = readCursor(userId);
  const cursor: SeedCursor =
    stored && stored.fingerprint === fingerprint
      ? stored
      : { words: 0, bookWords: 0, totalWords: words.length, totalBookWords: bookWords.length, fingerprint };

  // 云端对账（修缺陷①）：游标不可无条件信任。只允许续传到「云端确实已存在」的分片边界，
  // 否则某片「假成功」（响应成功却未落库）会让游标超前于现实、下次重试永久跳过缺口。
  //   words：**必须显式**按 owner_id 过滤 —— 其 RLS 是 USING(true)，不过滤会数到别人的词。
  //   book_words：按 bookId（RLS 已限 owner，owner_id 作双保险）。
  const wordsCloud = await countOrNull(() => repo.words.count([{ column: 'owner_id', op: 'eq', value: userId }]));
  const bookWordsCloud = await countOrNull(() =>
    repo.bookWords.count([
      { column: 'bookId', op: 'eq', value: CET6_BOOK_ID },
      { column: 'owner_id', op: 'eq', value: userId },
    ]),
  );

  // 陈旧游标清理：云端一行都没有、游标却声称有进度 → 该游标已不可信，顺手清掉（避免长期驻留）
  if (wordsCloud === 0 && cursor.words > 0) clearCursor(userId);
  if (bookWordsCloud === 0 && cursor.bookWords > 0) clearCursor(userId);

  // 写游标时**只**改当前表，另一张表的已确认值保持原样（否则会把对方的进度覆盖成 0）
  const advance = (patch: Partial<SeedCursor>): void => {
    Object.assign(cursor, patch);
    saveCursor(userId, cursor);
  };

  /**
   * 单表续传决策 + 执行：
   * - 云端已齐（count >= 总行数）→ 整步跳过（零请求），仅上报该步完成；
   * - 否则起点 = planStart(游标, 云端实测, 总行数)（对账失败时为 0，即全量）；
   * - 起点已越过总行数 → 同样整步跳过。
   */
  const runTable = async (
    step: 'words' | 'book_words',
    rows: (Word | BookWord)[],
    cursorValue: number,
    cloudCount: number | null,
    upsert: (batch: (Word | BookWord)[]) => Promise<void>,
    onChunkDone: (done: number) => void,
  ): Promise<void> => {
    if (cloudCount !== null && cloudCount >= rows.length) {
      onProgress?.({ step, done: rows.length, total: rows.length });
      return;
    }
    const start = planStart(cursorValue, cloudCount, rows.length);
    if (start >= rows.length) {
      onProgress?.({ step, done: rows.length, total: rows.length });
      return;
    }
    // 先报绝对值：UI 进度从断点起算，不会从 0 重跳
    onProgress?.({ step, done: start, total: rows.length });
    await upsertChunked(rows, upsert, (done, total) => onProgress?.({ step, done, total }), {
      startAt: start,
      onChunkDone,
    });
  };

  await runTable(
    'words',
    words,
    cursor.words,
    wordsCloud,
    (b) => repo.upsertWords(b as (Word & Record<string, unknown>)[]),
    (done) => advance({ words: done }),
  );

  await runTable(
    'book_words',
    bookWords,
    cursor.bookWords,
    bookWordsCloud,
    (b) => repo.upsertBookWords(b as (BookWord & Record<string, unknown>)[]),
    (done) => advance({ bookWords: done }),
  );

  onProgress?.({ step: 'book', done: 0, total: 1 });
  await repo.createBook({
    id: CET6_BOOK_ID,
    userId,
    name: '六级全量',
    source: 'builtin',
    wordCount: words.length,
    tierCount: 4,
    listSize: LIST_SIZE,
    status: 'active',
    createdAt: new Date().toISOString(),
  });
  // 成功路径才清游标：若在失败路径清掉，下次会从头重灌。
  clearCursor(userId);
  onProgress?.({ step: 'done', done: 1, total: 1 });

  return { bookId: CET6_BOOK_ID, words: words.length, bookWords: bookWords.length, skipped: false };
}
