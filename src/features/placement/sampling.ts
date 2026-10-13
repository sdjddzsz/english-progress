/**
 * senses.ts 已在 features/ 下；本文件是摸底抽样层的义项化改造。
 *
 * 用户 2026-10-13 的两条硬要求在这里落地：
 *  1. 摸底不能只「凭感觉自称认识」—— 必须先自评、**立刻揭晓正确答案**，
 *     若自评「认识」还要**再问一次「其实记错了吗」**，据此修正初判（见 PlacementPage）；
 *  2. 同一单词的不同读音对应不同意思 ⇒ **判定单位是义项（senseId），不是 lemma**。
 *     抽样时把多读音词按义项展开，这样 record 的名词义与动词义各自独立摸底、独立定层。
 */
import { PLACEMENT_MAX_WORDS } from '../../config/constants';
import { hashString } from '../../scheduler';
import type { L1State, Tier, Word, WordSense } from '../../types/domain';
import { normalizeSenses } from '../senses';

/** 摸底候选：一个判定单位（义项级） */
export interface PlacementCandidate {
  /** 判定单位 = senseId（lemma#序号）；**不是 wordId** */
  senseId: string;
  lemma: string;
  frequency: number;
}

export interface PlacementSenseItem extends PlacementCandidate {
  pos: string;
  zh: string;
  ipa: string;
  arpabet: string;
  /** 该词共有几种读音（>1 必须在界面上标出来） */
  pronunciationCount: number;
  senses: WordSense[];
}

/** 频带（按词频降序四等分）各自的抽样占比（词频先验配比） */
export const BAND_RATIOS = [0.4, 0.3, 0.2, 0.1] as const;

/**
 * 把 Word[] 展开成义项级候选。
 * 只有多读音词会展开成多行；单读音词即使有多个词性也**保持 1 行**
 * （不同词性同读音 ⇒ 按用户定义「不算不同的单词」，合并成一行，
 *  但 zh 拼接全部词性以便揭晓时一眼看全）。
 */
export function toSenseCandidates(words: Word[]): PlacementSenseItem[] {
  const out: PlacementSenseItem[] = [];
  for (const w of words) {
    const senses = normalizeSenses(w);
    const distinctPron = new Set(senses.map((s) => (s.arpabet || 'NONE').trim()));
    if (distinctPron.size <= 1) {
      const first = senses[0];
      out.push({
        senseId: first.senseId,
        lemma: w.lemma,
        frequency: w.frequency,
        pos: first.pos,
        zh: senses.map((s) => s.zh || s.pos).filter(Boolean).join(' / '),
        ipa: first.ipa || w.ipa,
        arpabet: first.arpabet || w.arpabet || '',
        pronunciationCount: 1,
        senses,
      });
    } else {
      // 多读音 ⇒ 每个读音一行（同一读音下的多个词性合并到该行）
      const byPron = new Map<string, PlacementSenseItem>();
      for (const s of senses) {
        const key = (s.arpabet || 'NONE').trim();
        const existing = byPron.get(key);
        if (existing) {
          existing.zh = `${existing.zh} / ${s.zh || s.pos}`.trim();
          existing.senses.push(s);
          continue;
        }
        byPron.set(key, {
          senseId: s.senseId,
          lemma: w.lemma,
          frequency: w.frequency,
          pos: s.pos,
          zh: s.zh || s.pos,
          ipa: s.ipa,
          arpabet: s.arpabet,
          pronunciationCount: distinctPron.size,
          senses: [s],
        });
      }
      out.push(...byPron.values());
    }
  }
  return out;
}

/**
 * 分带配比抽样：按频次降序切 4 带，各带按配额内均匀步进取词（确定性）。
 * 词量 ≤ max 时全量返回（仍保持频序）。同频稳定：先按 frequency desc，再按 senseId 哈希 tie-break。
 */
export function pickPlacementSample<T extends PlacementCandidate>(items: T[], max = PLACEMENT_MAX_WORDS): T[] {
  if (items.length <= max) return sortByFrequency(items);
  const sorted = sortByFrequency(items);
  const out: T[] = [];
  const bandSize = Math.ceil(sorted.length / 4);
  let quotaLeft = max;
  BAND_RATIOS.forEach((ratio, band) => {
    const bandItems = sorted.slice(band * bandSize, (band + 1) * bandSize);
    const take = band === BAND_RATIOS.length - 1 ? quotaLeft : Math.min(bandItems.length, Math.floor(max * ratio));
    quotaLeft -= take;
    if (take <= 0) return;
    const step = bandItems.length / take;
    for (let i = 0; i < take; i++) out.push(bandItems[Math.floor(i * step)]);
  });
  if (out.length < max) {
    const chosen = new Set(out.map((w) => w.senseId));
    const rest = sorted
      .filter((w) => !chosen.has(w.senseId))
      .sort((a, b) => hashString(a.senseId) - hashString(b.senseId));
    for (const w of rest) {
      if (out.length >= max) break;
      out.push(w);
    }
  }
  return out.slice(0, max);
}

function sortByFrequency<T extends PlacementCandidate>(items: T[]): T[] {
  return [...items].sort((a, b) => b.frequency - a.frequency || (a.senseId < b.senseId ? -1 : 1));
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

/**
 * 自我核对后的**修正规则**（用户 2026-10-13 的核心诉求：消除自欺）。
 *
 * 「认识」之后揭晓了正确释义，用户再回答「其实记错了吗」：
 *  - 没记错 → 维持初判（该记的确实记住了，层不动）
 *  - 记错了 → **降一层**：宣称认识却对不上 ⇒ 判定为「见过想不起」（T3），
 *    而不是留在 T2（熟词）。这是本规则存在的唯一理由：没有这次核对，
 *    摸底就只是用户的自我感觉。
 * 「不认识」不需要追问（不可能更差），直接 T4。
 */
export function applySelfCheck(initial: L1State, actuallyWrong: boolean): L1State {
  if (!actuallyWrong) return initial;
  switch (initial) {
    case 'instant':
    case 'recognized':
      return 'familiar_but_forgotten';
    case 'familiar_but_forgotten':
    case 'unknown':
      return 'unknown';
  }
}

/** 快答结果 → 初始层 assignments（按 senseId，供 recompute 写入；wordId 由调用方映射） */
export function estimateTierAssignments(responses: Record<string, L1State>): { senseId: string; tier: Tier }[] {
  return Object.entries(responses).map(([senseId, l1]) => ({ senseId, tier: l1ToTier(l1) }));
}
