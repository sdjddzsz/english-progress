/**
 * seedBootstrap.ts —— 首次使用初始化：ECDICT 六级种子入库（部署补丁，原 T05 导入入口）。
 *
 * 数据源 public/seed-cet6.json（~4MB，8296 词，由 buildSeed7000.ts 从 ECDICT 全量生成）：
 *  - 不进 PWA precache（vite.config globPatterns 不含 .json），按需 fetch，一次性在线操作；
 *  - 幂等：按 id upsert 冲突跳过；book 行已存在则整体跳过，可安全重复点击；
 *  - 断点续传：本机 localStorage 游标只记录「已确认落库的整片」，失败重试从断点继续，
 *    不白跑已成功分片；换设备 / 清缓存则从头幂等全量导入（安全，只是多做一遍）；
 *  - 数据归属当前登录用户（owner_id 由服务端 DEFAULT auth.uid() 填充）。
 *
 * 不 import ./seed/importEcdict —— 该文件含 process.argv 浏览器端不可用；
 * 词 → 领域文档的转换逻辑在此内联（与 importEcdict.seedToDomainDocs 保持一致）。
 */
import type { BookWord, TierSnapshot, Word, WordSense } from '../types/domain';
import { createWordRepo } from './repos/wordRepo';
import { createConfigRepo } from './repos/configRepo';

/** 六级词书 id（seedBootstrap 初始化 + backfillArpabet 回填共用同一常量） */
export const CET6_BOOK_ID = 'book_cet6_full';
const LIST_SIZE = 50;
const CHUNK = 300; // 每批 upsert 行数，控制单请求体积
/** 终局身份校验读 id 的每页条数（只取 id；8296 条 ⇒ 9 次/表） */
const ID_PAGE = 1000;

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
 * 种子内容指纹 —— 便宜、稳定、确定性（8296 条零负担）：
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
 *    续传提示会与真实续传点对不上（表现为提示 0/8296 但实际从 600 续、或反之）。
 */
export function getSeedCursor(userId: string | null | undefined): SeedCursor | null {
  return readCursor(userId);
}

interface SeedWord {
  lemma: string;
  ipa: string;
  /** CMUdict ARPAbet 发音真源（T7 seed v2；未命中词无此字段 → P0-9 降级） */
  arpabet?: string;
  /** 扁平释义（旧字段，= sensesDetail 拼接结果；保留以兼容历史 seed 文件） */
  translation: string;
  /** 义项列表（v3；同词不同读音 ⇒ 多个义项，各自绑定 arpabet/ipa） */
  senses?: string[];
  sensesDetail?: WordSense[];
  examples?: { en: string; zh: string }[];
  exchange?: Record<string, string>;
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
  /** 是否发生过「终局校验不足 → 一次性全量回退」（诊断用；正常路径恒 false） */
  reverted: boolean;
}

/**
 * 种子词 → Word / BookWord 领域文档。
 *
 * ⚠ 初始分层口径（用户 2026-10-13 明确要求，此前是拍脑袋的）：
 *   **一律 tier=4（T4 生词）**。原实现按词频先验给 25%→T2、25~60%→T3，
 *   那是「用词频猜你会哪些词」——既不是测评也不是任何人的判断，属于自欺。
 *   现在词书刚导入时就是「全生词」，层只由**练习成绩**驱动升降
 *   （features/placement/calibration.ts 的 runDailyCalibration，按反馈调层）。
 *   代价：刚导入时全部按 T4 排轮次（最重的一档），预算会偏紧 —— 这是诚实的代价，不回避。
 */
export function seedToDocs(
  seed: SeedWord[],
  bookId: string,
  listSize: number,
): { words: Word[]; bookWords: BookWord[] } {
  const words: Word[] = [];
  const bookWords: BookWord[] = [];
  seed.forEach((w, idx) => {
    const wordId = `word_${w.lemma}`;
    words.push({
      id: wordId,
      lemma: w.lemma,
      // ipa 用 seed 文件内派生值（arpabetToIpa 派生的唯一展示真源）；arpabet 命中才透传（P0-9）
      ipa: w.ipa,
      ...(w.arpabet ? { arpabet: w.arpabet } : {}),
      senses: w.senses ?? (w.translation ? [w.translation] : []),
      ...(w.sensesDetail ? { sensesDetail: w.sensesDetail } : {}),
      examples: w.examples ?? [],
      ...(w.exchange ? { exchange: w.exchange } : {}),
      frequency: w.frq,
      tags: w.tags,
    });
    bookWords.push({
      id: `bw_${bookId}_${w.lemma}`,
      bookId,
      wordId,
      listNo: Math.floor(idx / listSize) + 1,
      orderInList: (idx % listSize) + 1,
      tier: 4 as BookWord['tier'],
      tierUpdatedAt: new Date().toISOString(),
      status: 'normal',
      // 考查制判定字段（用户 2026-10-14）：全书从生词档起步
      streak: 0,
      failStreak: 0,
      specialTraining: false,
      quizDayStreak: 0,
      quizDayPassed: false,
      // 四阶段制（用户 2026-10-15）：新词一律从阶段一开始
      stage: 1,
      stageStreak: 0,
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
 * 重建词书（换种子版本时用）。
 *
 * ⚠ 为什么必须有这个入口（用户 2026-10-13 的场景）：
 *   `seedLibraryToCloud` 对已存在的 book 行**直接 skipped**（幂等设计）——
 *   种子从 5407 词换成 8296 词后，老用户点「初始化」什么都不会发生，
 *   永远看不到新词书。重跑初始化无效，必须显式重建。
 *
 * 安全性：
 *  - 只删**当前用户**在本 bookId 下的 book_words / words / books 行（按 owner_id + bookId 作用域）；
 *  - 删除前**必须先备份**词量与层级快照到 tier_snapshots（可追溯，不是"删了就没了"）；
 *  - 备份失败 ⇒ 不删（fail closed）。
 *  - 已产生的 hits / feedbacks **不删**（历史学习记录保留；旧 hit 指向的 wordId 在新词书里仍存在，
 *    因为新词书是旧词书的超集 —— lemmas 与 id 完全兼容，不会产生孤儿 hit）。
 */
export async function rebuildWordBook(
  userId: string,
  onProgress?: (p: SeedProgress) => void,
): Promise<SeedResult> {
  const repo = createWordRepo();
  const backupAt = new Date().toISOString();

  // ① 备份：把当前词量 + 分层分布写进 tier_snapshots（fail closed 的前提）
  //    tier_snapshots 属于 configRepo 的集合范围（与 seedBootstrap 原本只碰 wordRepo 的边界不同，
  //    这里是重建场景的必要例外：删数据前必须留痕）。
  // ⚠ 必须 listAll：服务端 max-rows 默认 1000。实测 5407 行的 book_words
  //   用 list() 只回 1000 条 —— 于是这里只备份/只删除了 1000 条，
  //   剩下 4407 条「从未被看见」（词书被删、关联被删一半，用户直接看不到词书）。
  const bws = await repo.bookWords.listAll([
    { column: 'bookId', op: 'eq', value: CET6_BOOK_ID },
    { column: 'owner_id', op: 'eq', value: userId },
  ]);
  const tierDist: Record<string, number> = {};
  for (const bw of bws) tierDist[String(bw.tier)] = (tierDist[String(bw.tier)] ?? 0) + 1;
  const backupPayload = { bookId: CET6_BOOK_ID, wordCount: bws.length, tierDist };
  await createConfigRepo().tierSnapshots.insert({
    userId,
    sampledWordIds: [],
    responses: { _backup: backupPayload } as unknown as TierSnapshot['responses'],
    computedTiers: {},
    calibratedAt: backupAt,
  });

  // ② 删除：只删本用户 + 本 bookId 的行
  //
  // ⚠ 中途失败的处置：此时 book 行可能已删或未删、book_words 已删一部分，
  //   词书处于「半残」状态。这里**不吞异常**（吞掉会让用户以为成功），
  //   而是抛出带明确指引的错误：让用户知道要重跑（重跑是安全的：
  //   幂等 upsert 会补齐任何缺口，且 seedLibraryToCloud 有终局身份集合校验兜底）。
  const wordsBefore = (await repo.words.count([
    { column: 'owner_id', op: 'eq', value: userId },
  ]));
  onProgress?.({ step: 'book_words', done: 0, total: bws.length });
  try {
    for (let i = 0; i < bws.length; i += CHUNK) {
      const slice = bws.slice(i, i + CHUNK);
      await repo.bookWords.removeMany(slice.map((b) => b.id));
      onProgress?.({ step: 'book_words', done: Math.min(i + CHUNK, bws.length), total: bws.length });
    }
    const book = await repo.getBook(CET6_BOOK_ID);
    if (book) await repo.books.remove(CET6_BOOK_ID);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `重建词书时删除旧数据失败：${detail}。词书可能处于不完整状态（原有 ${bws.length} 条关联，` +
        `words 表 ${wordsBefore} 条）。**直接再点一次「确认重建词书」即可恢复** —— 导入走幂等 upsert，` +
        `会补齐任何缺口，且导入前有身份集合校验兜底，不会静默少词。`,
    );
  }

  // ③ 重新走标准导入（幂等 upsert：words 表里同 id 会被覆盖为新种子内容）
  const result = await seedLibraryToCloud(userId, onProgress);
  return { ...result, skipped: false };
}

/**
 * 初始化六级词库。userId 为当前登录用户（写进 books 行，便于词书列表归属展示）。
 *
 * 续传安全性（三道硬保证，缺一不可）：
 *  ② 游标自校验**以种子内容指纹为准**（`seedFingerprint`）—— 同词数不同内容时旧游标必被丢弃；
 *  ① 续传前**与云端对账**（`Repository.count`，head 请求）—— 续传起点只到「云端确实已存在」的
 *     分片边界，避免某片「假成功」（响应成功却未落库）导致游标超前于现实、永久跳过缺口；
 *     对账失败一律降级为全量幂等。
 *  ③ **终局校验（身份集合）+ 一次性全量回退**（createBook 之前）—— 判据是
 *     「期望的种子 id 集合 ⊆ 云端实存 id 集合」（两表各一遍，只取 id、按 owner 作用域、分页读全），
 *     而不是任何「计数比较」：计数不含身份信息，会被「等量但位置/身份不同」的洞骗过
 *     （前缀洞、另有别的词源、孤儿行）。不达标则清游标 + 无条件全量重写一次再判；
 *     仍缺则**响亮失败、绝不 createBook**；读失败/分页截断 → fail closed（不重写、不建书）。
 *     有了它，`planStart` 的 min() 与「云端已齐则跳过」都**降级为纯优化**（错了会被这里逮住并回退修复）。
 *
 * 其余：某张表云端已齐则整步跳过（零请求）；每个分片确认落库后推进游标；整体成功后清游标。
 * 代价：正常路径固定 4 次 count（2 次续传前对账 + 2 次终局校验），仅在回退时额外一轮全量写。
 */
export async function seedLibraryToCloud(
  userId: string,
  onProgress?: (p: SeedProgress) => void,
): Promise<SeedResult> {
  const repo = createWordRepo();

  // 幂等：书行已存在视为已初始化
  const existing = await repo.getBook(CET6_BOOK_ID);
  if (existing) {
    return {
      bookId: CET6_BOOK_ID,
      words: existing.wordCount,
      bookWords: existing.wordCount,
      skipped: true,
      reverted: false,
    };
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
  //     ⚠ 这条过滤是让**对账正确**的一步，不是让「多账号可用」的一步：去掉它会数到别人的词行、
  //       使云端计数虚高 → 跳过自己从未写过的行，等于把缺陷①换个形式装回去。
  //   book_words：按 bookId（RLS 已限 owner，owner_id 作双保险）。
  const countWords = (): Promise<number> => repo.words.count([{ column: 'owner_id', op: 'eq', value: userId }]);
  const countBookWords = (): Promise<number> =>
    repo.bookWords.count([
      { column: 'bookId', op: 'eq', value: CET6_BOOK_ID },
      { column: 'owner_id', op: 'eq', value: userId },
    ]);

  const wordsCloud = await countOrNull(countWords);
  const bookWordsCloud = await countOrNull(countBookWords);

  // 陈旧游标清理：云端一行都没有、游标却声称有进度 → 该游标已不可信，顺手清掉（避免长期驻留）
  if (wordsCloud === 0 && cursor.words > 0) clearCursor(userId);
  if (bookWordsCloud === 0 && cursor.bookWords > 0) clearCursor(userId);

  // 写游标时**只**改当前表，另一张表的已确认值保持原样（否则会把对方的进度覆盖成 0）
  const advance = (patch: Partial<SeedCursor>): void => {
    Object.assign(cursor, patch);
    saveCursor(userId, cursor);
  };

  const upsertWords = (b: (Word | BookWord)[]): Promise<void> =>
    repo.upsertWords(b as (Word & Record<string, unknown>)[]);
  const upsertBookWords = (b: (Word | BookWord)[]): Promise<void> =>
    repo.upsertBookWords(b as (BookWord & Record<string, unknown>)[]);

  /**
   * 单表续传决策 + 执行：
   * - 云端行数**恰好**等于本次种子行数 **且** 游标确认过该表已写完当前这份种子 → 整步跳过（零请求）；
   * - 否则起点 = planStart(游标, 云端实测, 总行数)（对账失败时为 0，即全量）；
   * - 起点已越过总行数 → 同样整步跳过。
   * `cloudCount === null` 即「无条件全量重写」（回退路径用它）。
   *
   * ⚠⚠ `cloudCount >= rows.length` **不能单独作为跳过依据**（2026-10-13 线上事故）：
   *   续传假设「前 N 行已经是新种子的内容」，这只在**同一份种子**下成立。
   *   换种子后行数可能不变（或云端残留更少），但前 N 行的**内容已过时**
   *   （实测：上次重建中途失败留下 4407 行旧 book_words，新种子 8296 行 ——
   *    若直接跳过，就会留下一批**旧层号**的关联，而这些词的层级永远不会被纠正成新规则的层）。
   *   ⇒ 必须额外校验「云端已存在行数 = 本次要写的全部行数」这一更强的条件才允许跳过；
   *   否则一律从 0 全量重写（幂等 upsert，重写安全）。
   *   终局的身份集合校验（verify）只能证明「该有的 id 都在」，**证明不了内容是新的** ——
   *   所以这里的前置判断不能省。
   */
  const runTable = async (
    step: 'words' | 'book_words',
    rows: (Word | BookWord)[],
    cursorValue: number,
    cloudCount: number | null,
    upsert: (batch: (Word | BookWord)[]) => Promise<void>,
    onChunkDone: (done: number) => void,
  ): Promise<void> => {
    // 跳过条件：行数**恰好**够（不是 >=），**且**本机游标确认过该表已完整写入当前这份种子。
    // 前半（=== 而非 >=）：行数多于预期说明云端有别的词源或旧版本残留，此时也全量重写，
    //   把每行的内容对齐到本次种子。
    // 后半（cursorValue >= rows.length）：**行数相等也证明不了内容是新的** ——
    //   词数不变、内容变过（例：IPA / 义项修错）时，行 id 与行数都不变，只比行数就会
    //   **永久跳过刷新**，云端一直留着旧内容（历史上「两份种子文件不一致 ⇒ 云端拿到旧 IPA」
    //   就是这一类）。游标已过指纹校验，它声称写完 ⇒ 内容确实是这一版种子。
    if (cloudCount !== null && cloudCount === rows.length && cursorValue >= rows.length) {
      onProgress?.({ step, done: rows.length, total: rows.length });
      return;
    }
    // 续传只在「云端行数是本次种子的前缀」时安全；行数与本次种子对不上（多或少）都全量重写。
    const start = cloudCount === null || cloudCount > rows.length ? 0 : planStart(cursorValue, cloudCount, rows.length);
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

  await runTable('words', words, cursor.words, wordsCloud, upsertWords, (done) => advance({ words: done }));

  await runTable('book_words', bookWords, cursor.bookWords, bookWordsCloud, upsertBookWords, (done) =>
    advance({ bookWords: done }),
  );

  // ===== 终局校验（**身份集合**判据）+ 一次性全量回退 =====
  //
  // 判据为何从「计数」升级为「身份集合」：计数不含**身份**信息，任何计数比较都可能被
  // 「等量但位置/身份不同」的洞骗过：
  //   · `planStart` 的 min(游标, 计数) —— 缺失集是「前缀」时给出错误起点（游标 600 + 云端 4807 ⇒ 仍取 600）；
  //   · 终局计数比对 —— 该账号另有别的词源时，「丢了 300 个种子 id、另有 300 个别家 id」总数仍相等 ⇒ 放行；
  //     且「孤儿行」（种子换内容后旧 id 残留）会让 `===` 误判、只能靠放宽符号躲开，顾此失彼。
  // 身份集合判据一次消掉这一整类假设：
  //   **期望的种子 id 集合 ⊆ 云端实存 id 集合**（两表各一遍）。
  //   → 孤儿行（多出来的 id）天然放行（用户换种子后照常建书，不锁死）；
  //   → 缺任何该有的种子 id 必失败（不会被孤儿数掩盖）。
  // 写入结束仍不达标 → 清游标 + 无条件全量重写一次（按定义填满任何形态的缺口）→ 再判；
  // 仍缺 → **响亮失败且绝不 createBook**（静默少词是本项目明确不可容忍的失效）。
  //
  // ⚠ 读必须**按 owner 作用域**：`words` 的 RLS 是 USING(true)，不按 owner 过滤会读到**别人的 id**
  //   —— 任何其他账号导过同一份种子，其行恰好含我们缺的那些 id ⇒ 子集判据**被别人的行满足 → 假通过**。
  const expectedWordIds = new Set(words.map((w) => w.id));
  const expectedBookWordIds = new Set(bookWords.map((b) => b.id));

  /**
   * 分页读回某表「该 owner」的实存 id 集合（只取 id；固定 id 序分页）。
   * @returns 读失败，或条数与云端计数不一致（分页被静默截断 / 读取期间数据变动）→ `null`（= 不可验证）
   */
  const readIdSet = async (
    listPage: (offset: number, limit: number) => Promise<string[]>,
    cloudCount: number,
  ): Promise<Set<string> | null> => {
    const ids = new Set<string>();
    try {
      for (let offset = 0; offset < cloudCount; offset += ID_PAGE) {
        const page = await listPage(offset, ID_PAGE);
        for (const id of page) ids.add(id);
        if (page.length < ID_PAGE) break; // 短页 = 读完
      }
    } catch {
      return null; // 读失败 → 不可验证
    }
    // 「读全」断言：条数与云端计数不符 ⇒ 分页被悄悄截断（或期间数据变动）⇒ 不可验证
    return ids.size === cloudCount ? ids : null;
  };

  const missingOf = (expected: Set<string>, actual: Set<string>): string[] =>
    [...expected].filter((id) => !actual.has(id));

  /** 身份级校验；`null` = 不可验证（读失败 / 分页截断 / 计数拿不到，无法断言「已读全」） */
  const verify = async (): Promise<{ missingWords: string[]; missingBookWords: string[] } | null> => {
    const wCount = await countOrNull(countWords);
    const bCount = await countOrNull(countBookWords);
    if (wCount === null || bCount === null) return null; // 计数拿不到 ⇒ 无法断言读全 ⇒ 不可验证
    const actualWords = await readIdSet(
      (offset, limit) =>
        repo.words.listIds([{ column: 'owner_id', op: 'eq', value: userId }], { offset, limit }),
      wCount,
    );
    const actualBookWords = await readIdSet(
      (offset, limit) =>
        repo.bookWords.listIds(
          [
            { column: 'bookId', op: 'eq', value: CET6_BOOK_ID },
            { column: 'owner_id', op: 'eq', value: userId },
          ],
          { offset, limit },
        ),
      bCount,
    );
    if (actualWords === null || actualBookWords === null) return null;
    return {
      missingWords: missingOf(expectedWordIds, actualWords),
      missingBookWords: missingOf(expectedBookWordIds, actualBookWords),
    };
  };

  const sample = (ids: string[]): string => `${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ' …' : ''}`;
  const unverifiableError = (): Error =>
    new Error(
      '词书初始化无法校验：读取云端 id 集合失败或不完整（网络抖动 / 分页被截断）。' +
        '无法证明数据已写全时不允许声称成功，本次不创建词书；已导入部分会保留，请重试。',
    );
  const shortfallError = (m: { missingWords: string[]; missingBookWords: string[] }): Error =>
    new Error(
      `词书初始化校验未通过（已做过一次全量重写仍缺）：words 缺 ${m.missingWords.length} 条（如 ${sample(m.missingWords)}）；` +
        `book_words 缺 ${m.missingBookWords.length} 条（如 ${sample(m.missingBookWords)}）。` +
        '为避免出现「词书声称 N 词、实际更少」的静默错误，本次不创建词书；已导入部分会保留，请重试。',
    );

  let verdict = await verify();
  // ⚠ 「回退只做一次」的标志键在**本次运行的局部变量**，绝不能键在游标 ——
  //   否则「清游标 → 重写 → 又缺 → 再清 → 被下一步重读游标当成新一次」就能绕开限制。
  let reverted = false;
  if (verdict === null) throw unverifiableError(); // 读失败/截断：fail closed，且**不做**无意义的全量重写
  if (verdict.missingWords.length > 0 || verdict.missingBookWords.length > 0) {
    clearCursor(userId);
    reverted = true;
    await runTable('words', words, 0, null, upsertWords, (done) => advance({ words: done }));
    await runTable('book_words', bookWords, 0, null, upsertBookWords, (done) => advance({ bookWords: done }));
    verdict = await verify();
    if (verdict === null) throw unverifiableError();
    if (verdict.missingWords.length > 0 || verdict.missingBookWords.length > 0) throw shortfallError(verdict);
  }

  // ===== 孤儿关联清理（2026-10-13 线上残留的善后）=====
  //
  // upsert 只能**覆盖**已有行，**删不掉**不该存在的行。上次重建中途失败后 book_words
  // 残留了 4407 条旧关联（books 行已删 ⇒ 词书直接看不见）。若旧词书里混着新版种子不再收录的词，
  // 这些行会在本次导入后**复活成「词书里多出来的词」** —— 与「静默少词」同类的静默不一致，
  // 本项目不接受。作用域严格限定：本 bookId + 本 owner，且只删 id 不在本次种子集合内的行。
  // 清理失败**不**阻断导入（孤儿只是多几个词，下次导入会重试），因此吞掉异常。
  try {
    const existingBw = await repo.bookWords.listAll([
      { column: 'bookId', op: 'eq', value: CET6_BOOK_ID },
      { column: 'owner_id', op: 'eq', value: userId },
    ]);
    const orphanIds = existingBw.filter((b) => !expectedBookWordIds.has(b.id)).map((b) => b.id);
    if (orphanIds.length > 0) await repo.bookWords.removeMany(orphanIds);
  } catch {
    /* 清理失败：不阻断导入 */
  }

  onProgress?.({ step: 'book', done: 0, total: 1 });
  await repo.createBook({
    id: CET6_BOOK_ID,
    userId,
    name: '六级词书（8296 词）',
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

  return { bookId: CET6_BOOK_ID, words: words.length, bookWords: bookWords.length, skipped: false, reverted };
}
