/**
 * sampling.ts —— 摸底抽样与初始分层（PRD §4.3，架构 T05）：
 * ≤300 词（PLACEMENT_MAX_WORDS）按词频先验分带配比抽样：高频带多抽、低频带少抽；
 * L1 快答 → 初始层映射（秒认 T1 / 认得 T2 / 想不起 T3 / 不认识 T4）。
 * 全部纯函数、确定性（hashString 抽样，无随机源）。
 */
import { PLACEMENT_MAX_WORDS } from '../../config/constants';
import { hashString } from '../../scheduler';
import type { L1State, Tier } from '../../types/domain';

export interface PlacementCandidate {
  wordId: string;
  lemma: string;
  frequency: number;
}

/** 频带（按词频降序四等分）各自的抽样占比（词频先验配比） */
export const BAND_RATIOS = [0.4, 0.3, 0.2, 0.1] as const;

/**
 * 分带配比抽样：按频次降序切 4 带，各带按配额内均匀步进取词（确定性）。
 * 词量 ≤ max 时全量返回（仍保持频序）。同频稳定：先按 frequency desc，再按 wordId 哈希 tie-break。
 */
export function pickPlacementSample<T extends PlacementCandidate>(words: T[], max = PLACEMENT_MAX_WORDS): T[] {
  if (words.length <= max) {
    return sortByFrequency(words);
  }
  const sorted = sortByFrequency(words);
  const out: T[] = [];
  const bandSize = Math.ceil(sorted.length / 4);
  let quotaLeft = max;
  BAND_RATIOS.forEach((ratio, band) => {
    const bandWords = sorted.slice(band * bandSize, (band + 1) * bandSize);
    const take = band === BAND_RATIOS.length - 1 ? quotaLeft : Math.min(bandWords.length, Math.floor(max * ratio));
    quotaLeft -= take;
    if (take <= 0) return;
    // 带内均匀步进（确定性）：覆盖带内全距而非只取头部
    const step = bandWords.length / take;
    for (let i = 0; i < take; i++) {
      out.push(bandWords[Math.floor(i * step)]);
    }
  });
  // 配额四舍五入缺口：从剩余词按哈希序补齐
  if (out.length < max) {
    const chosen = new Set(out.map((w) => w.wordId));
    const rest = sorted
      .filter((w) => !chosen.has(w.wordId))
      .sort((a, b) => hashString(a.wordId) - hashString(b.wordId));
    for (const w of rest) {
      if (out.length >= max) break;
      out.push(w);
    }
  }
  return out.slice(0, max);
}

function sortByFrequency<T extends PlacementCandidate>(words: T[]): T[] {
  return [...words].sort((a, b) => b.frequency - a.frequency || (a.wordId < b.wordId ? -1 : 1));
}

/** L1 快答 → 初始难度层 */
export function l1ToTier(l1: L1State): Tier {
  switch (l1) {
    case 'instant':
      return 1;
    case 'recognized':
      return 2;
    case 'familiar_but_forgotten':
      return 3;
    case 'unknown':
      return 4;
  }
}

/** 快答结果 → 初始层 assignments（每词一层，供 recompute/初始写入） */
export function estimateTierAssignments(responses: Record<string, L1State>): { wordId: string; tier: Tier }[] {
  return Object.entries(responses).map(([wordId, l1]) => ({ wordId, tier: l1ToTier(l1) }));
}
