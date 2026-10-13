/**
 * seedBootstrap.ts —— 首次使用初始化：ECDICT 六级全量种子入库（部署补丁，原 T05 导入入口）。
 *
 * 数据源 public/seed-cet6.json（~1.1MB，5407 词）：
 *  - 不进 PWA precache（vite.config globPatterns 不含 .json），按需 fetch，一次性在线操作；
 *  - 幂等：按 id upsert 冲突跳过；book 行已存在则整体跳过，可安全重复点击；
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

async function upsertChunked(
  rows: (Word | BookWord)[],
  upsert: (batch: (Word | BookWord)[]) => Promise<void>,
  onProgress: (done: number, total: number) => void,
): Promise<number> {
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await upsert(rows.slice(i, i + CHUNK));
    done = Math.min(i + CHUNK, rows.length);
    onProgress(done, rows.length);
  }
  return rows.length;
}

/**
 * 初始化六级全量词库。userId 为当前登录用户（写进 books 行，便于词书列表归属展示）。
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

  onProgress?.({ step: 'words', done: 0, total: words.length });
  await upsertChunked(words, (b) => repo.upsertWords(b as (Word & Record<string, unknown>)[]), (done, total) =>
    onProgress?.({ step: 'words', done, total }),
  );

  onProgress?.({ step: 'book_words', done: 0, total: bookWords.length });
  await upsertChunked(bookWords, (b) => repo.upsertBookWords(b as (BookWord & Record<string, unknown>)[]), (done, total) =>
    onProgress?.({ step: 'book_words', done, total }),
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
  onProgress?.({ step: 'done', done: 1, total: 1 });

  return { bookId: CET6_BOOK_ID, words: words.length, bookWords: bookWords.length, skipped: false };
}
