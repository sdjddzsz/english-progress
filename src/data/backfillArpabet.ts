/**
 * backfillArpabet.ts —— 存量云端 words 行回填发音真源（架构增量 v0.1，T8 / P0-6）。
 *
 * 场景：老用户云端 words 行是 ECDICT 的 ipa（质量不可靠）；本服务按 lemma 从 seed（含 CMUdict
 * ARPAbet）回填：命中词写 `arpabet` + 覆盖 `ipa` 为 `arpabetToIpa` 派生值；未命中词保留原 ipa、
 * 不写 arpabet（P0-9 降级语义）。
 *
 * 幂等（D8）：word 文档 id = `word_{lemma}`（既有约定）；写入值确定性派生（CMUdict 主词条 + 纯函数
 * 派生 ipa）→ 重跑产生同一文档，`upsertMany(onConflict:id)` 即幂等。失败可原样重跑。
 *
 * 纯逻辑（Map 构建 / patch 计算）与 IO（fetch / repo）分离，便于单测（mock repo + mock fetch）。
 */
import type { BookWord, Word } from '../types/domain';
import { arpabetToIpa } from '../tts/arpabetToIpa';
import { CET6_BOOK_ID } from './seedBootstrap';
import { createWordRepo, type WordRepo } from './repos/wordRepo';

/** seed 条目（仅回填所需字段；未命中词无 arpabet） */
export interface SeedEntry {
  lemma: string;
  arpabet?: string;
}

/** 回填 repo 依赖（取 wordRepo 的必需子集，便于测试注入 mock） */
export type BackfillRepo = Pick<WordRepo, 'listBookWords' | 'listWordsByIds' | 'upsertWords'>;

export interface BackfillProgress {
  done: number;
  total: number;
  updated: number;
  skipped: number;
}

export interface BackfillResult {
  total: number;
  updated: number;
  skipped: number;
  /** 未命中 lemma 清单（最多 50 条；完整计数见 skipped） */
  missed: string[];
  /** 读写失败信息（英文，延续 repository 现状）；非空表示本次未全部完成，可原样重跑 */
  errors: string[];
}

export interface BackfillDeps {
  /** 默认 fetch('/seed-cet6.json')；测试注入 */
  fetchSeed?: () => Promise<SeedEntry[]>;
  onProgress?: (p: BackfillProgress) => void;
  /**
   * 测试注入点：回填 repo（默认 createWordRepo()）。
   * 注：架构 §5.5 的 BackfillDeps 只列 fetchSeed/onProgress，此处**扩展**出 repo 注入以满足
   * §八「mock repo + mock fetch」的测试策略，运行时不传即用真实 repo，语义不变。
   */
  repo?: BackfillRepo;
}

/** 读词 id 分块大小（控制单请求体积） */
const ID_CHUNK = 200;
/** 写词分块大小（每批 upsert 行数） */
const WRITE_CHUNK = 300;
/** missed 清单上限（避免回传体过大；完整计数用 skipped） */
const MISSED_MAX = 50;

/**
 * seed → Map<lemma, arpabet>（跳过无 arpabet 的未命中条目；lemma 统一 trim+小写）。
 * 纯函数，可单测。
 */
export function buildArpabetMap(seed: SeedEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const w of seed) {
    const arpabet = w.arpabet?.trim();
    if (!arpabet) continue;
    map.set(w.lemma.trim().toLowerCase(), arpabet);
  }
  return map;
}

/**
 * 计算单词 patch（纯函数，可单测）：
 *  - lemma 命中且派生 IPA 成功 → `{ arpabet, ipa: 派生值 }`；
 *  - 未命中 / 音素非法 → `null`（保留原 ipa、不动 arpabet）。
 */
export function computeWordPatch(word: Word, map: Map<string, string>): { arpabet: string; ipa: string } | null {
  const arpabet = map.get(word.lemma.trim().toLowerCase());
  if (!arpabet) return null;
  try {
    return { arpabet, ipa: arpabetToIpa(arpabet) };
  } catch {
    // CMUdict 音素串非法：按未命中处理，保留原 ipa
    return null;
  }
}

/** 默认 seed 取数：同源 seed-cet6.json（含 arpabet 的 v2） */
async function defaultFetchSeed(): Promise<SeedEntry[]> {
  const res = await fetch('/seed-cet6.json');
  if (!res.ok) throw new Error(`seed dataset fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as SeedEntry[];
  if (!Array.isArray(data)) throw new Error('seed dataset is malformed');
  return data;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 存量回填入口（P0-6）。幂等键 = word.id = `word_{lemma}`；写入值确定性派生 → 重跑 = 同文档。
 * 未命中词：保留原 ipa、不写 arpabet。
 */
export async function backfillArpabetFromSeed(deps: BackfillDeps = {}): Promise<BackfillResult> {
  const fetchSeed = deps.fetchSeed ?? defaultFetchSeed;
  const onProgress = deps.onProgress;
  const repo = deps.repo ?? createWordRepo();

  const errors: string[] = [];
  const missedSet = new Set<string>();
  let updated = 0;
  let skipped = 0;
  let done = 0;

  // 1) seed → Map（失败即整体返回，可原样重跑）
  let seed: SeedEntry[];
  try {
    seed = await fetchSeed();
  } catch (e) {
    return { total: 0, updated: 0, skipped: 0, missed: [], errors: [errMsg(e)] };
  }
  const map = buildArpabetMap(seed);

  // 2) 取词书全部 wordId
  let bookWords: BookWord[];
  try {
    bookWords = await repo.listBookWords(CET6_BOOK_ID);
  } catch (e) {
    return { total: 0, updated: 0, skipped: 0, missed: [], errors: [errMsg(e)] };
  }
  const total = bookWords.length;
  onProgress?.({ done: 0, total, updated: 0, skipped: 0 });

  // 3) 分块读词 → 计算 patch → 分批 upsert
  let batch: (Word & Record<string, unknown>)[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];
    try {
      await repo.upsertWords(rows);
    } catch (e) {
      errors.push(errMsg(e));
    }
  };

  for (let i = 0; i < bookWords.length; i += ID_CHUNK) {
    const ids = bookWords.slice(i, i + ID_CHUNK).map((bw) => bw.wordId);
    let words: Word[];
    try {
      words = await repo.listWordsByIds(ids);
    } catch (e) {
      errors.push(errMsg(e));
      continue;
    }
    for (const w of words) {
      const patch = computeWordPatch(w, map);
      if (patch) {
        batch.push({ ...w, arpabet: patch.arpabet, ipa: patch.ipa });
        updated += 1;
      } else {
        skipped += 1;
        if (missedSet.size < MISSED_MAX) missedSet.add(w.lemma);
      }
      done += 1;
      if (batch.length >= WRITE_CHUNK) await flush();
      onProgress?.({ done, total, updated, skipped });
    }
  }
  await flush();

  return { total, updated, skipped, missed: [...missedSet], errors };
}
