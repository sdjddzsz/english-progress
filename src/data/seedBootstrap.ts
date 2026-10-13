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
// 语义：游标只在「某个分片已确认落库」之后前进，因此它永远不会声称未确认的进度；
//       配合 upsert(onConflict:'id')，即便游标落后（例如响应丢失但已写入），也只是重复写同一批，绝不丢数据。

/** 续传游标：两张表各自已确认落库的行数 + 种子文件当时的行数（用于自校验） */
export interface SeedCursor {
  words: number;
  bookWords: number;
  totalWords: number;
  totalBookWords: number;
}

/** localStorage key（按词书隔离，便于将来多词书复用同一套逻辑） */
export function seedCursorKey(bookId: string): string {
  return `seed-progress:${bookId}`;
}

/**
 * 读游标。存储不可用（node/worker/SSR 无 localStorage、隐私模式）或内容损坏 → 返回 null，
 * 一律降级为「无游标」，**绝不**因存储异常打断导入。
 */
function readCursor(): SeedCursor | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(seedCursorKey(CET6_BOOK_ID));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<SeedCursor>;
    if (
      typeof p.words !== 'number' ||
      typeof p.bookWords !== 'number' ||
      typeof p.totalWords !== 'number' ||
      typeof p.totalBookWords !== 'number'
    ) {
      return null;
    }
    return { words: p.words, bookWords: p.bookWords, totalWords: p.totalWords, totalBookWords: p.totalBookWords };
  } catch {
    return null;
  }
}

/** 写游标。存储异常（配额满 / 被禁用）时静默降级，绝不影响导入 */
function saveCursor(c: SeedCursor): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(seedCursorKey(CET6_BOOK_ID), JSON.stringify(c));
  } catch {
    /* 存储不可用：降级为「无游标」 */
  }
}

/** 清游标。**只**在整次导入成功（books 行已落地）后调用，否则下次全新导入会被错误跳过 */
function clearCursor(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(seedCursorKey(CET6_BOOK_ID));
  } catch {
    /* 存储不可用：无游标可清，忽略 */
  }
}

/** 供词书页展示「上次导入中断于 N/M」；无游标 / 存储不可用时返回 null */
export function getSeedCursor(): SeedCursor | null {
  return readCursor();
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
 * 初始化六级全量词库。userId 为当前登录用户（写进 books 行，便于词书列表归属展示）。
 *
 * 断点续传：读本机游标（并自校验：种子文件行数变了则丢弃）→ 两张表各自从断点所在的分片边界继续；
 * 某张表已全部完成则整步跳过（零请求）；每个分片确认落库后推进游标；整体成功后清游标。
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

  // 断点续传：读游标 + 自校验（行数对不上 = 种子文件变过 → 丢弃，避免按旧游标错位续传）
  const stored = readCursor();
  const cursor: SeedCursor =
    stored && stored.totalWords === words.length && stored.totalBookWords === bookWords.length
      ? stored
      : { words: 0, bookWords: 0, totalWords: words.length, totalBookWords: bookWords.length };
  const wordsStart = Math.min(cursor.words, words.length);
  const bookWordsStart = Math.min(cursor.bookWords, bookWords.length);

  // 写游标时**只**改当前表，另一张表的已确认值保持原样（否则会把对方的进度覆盖成 0）
  const advance = (patch: Partial<SeedCursor>): void => {
    Object.assign(cursor, patch);
    saveCursor(cursor);
  };

  /**
   * 单表续传：start 取自**未取整**的游标——必须先在这里判「整表已完成」再跳过，
   * 不能依赖 upsertChunked 内部取整（游标恰为总行数时 floor(total/CHUNK)*CHUNK < total，
   * 会把最后一片重传一遍）。
   */
  const runTable = async (
    step: 'words' | 'book_words',
    rows: (Word | BookWord)[],
    start: number,
    upsert: (batch: (Word | BookWord)[]) => Promise<void>,
    onChunkDone: (done: number) => void,
  ): Promise<void> => {
    if (start >= rows.length) {
      // 该表已全部落库 → 整步跳过（零请求），仅上报该步完成
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
    wordsStart,
    (b) => repo.upsertWords(b as (Word & Record<string, unknown>)[]),
    (done) => advance({ words: done }),
  );

  await runTable(
    'book_words',
    bookWords,
    bookWordsStart,
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
  clearCursor();
  onProgress?.({ step: 'done', done: 1, total: 1 });

  return { bookId: CET6_BOOK_ID, words: words.length, bookWords: bookWords.length, skipped: false };
}
