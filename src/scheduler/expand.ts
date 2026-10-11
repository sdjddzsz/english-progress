/**
 * expand.ts —— MRCS Step 2/3：轮次窗口 / 跨 List 轮转 / 轮内乱序（种子=轮次号）/
 * 模态分配 / gap 约束 / DayExplain。纯函数，确定性：同参数同输入输出逐字节一致。
 *
 * 正确性要点：
 * - 每词在其层每轮被覆盖一次（稳固词在开启降频时仅中间轮跳过，首末轮必现）；
 * - 轮内 List 访问顺序用 种子=轮次号（混入 tier 避免各层置换完全相同，可复现性不变）打乱一次；
 * - 同词相邻两次 hit 至少间隔 gapMinDays，冲突时顺延到最近合法日（clamp 到本轮窗口末日）；
 * - 模态分配在当日各层词块内取精确配额 round(n × ratio)，保证逐日比例误差 ≤ 1 词。
 */
import type {
  DayExplain,
  Modality,
  PlanParams,
  PlanRoundWindow,
  QueueEntry,
  Tier,
  TierWordCounts,
  WordSteadiness,
} from './types';
import { TIERS } from './types';
import { skipAllowed } from './mastery';

// ===== 纯日期工具（ISO YYYY-MM-DD，UTC）=====

export function toUTCDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function addDays(iso: string, n: number): string {
  const d = toUTCDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** a − b（天） */
export function diffDays(a: string, b: string): number {
  return Math.round((toUTCDate(a).getTime() - toUTCDate(b).getTime()) / 86400000);
}

/** 自 1970-01-01 起的天数（作确定性种子用） */
export function epochDay(iso: string): number {
  return Math.floor(toUTCDate(iso).getTime() / 86400000);
}

export function isoFromEpochDay(day: number): string {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

// ===== 确定性随机 =====

/** FNV-1a 32bit 字符串哈希 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG（确定性） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 轮次乱序种子：PRD 要求"种子=轮次号（可复现）"；混入 tier 防止各层置换相同，可复现性不受影响 */
export function roundSeed(tier: Tier, roundNo: number): number {
  return roundNo * 10 + tier;
}

/** 返回 0..n-1 的确定性乱序排列（Fisher–Yates，mulberry32） */
export function shuffledOrder(n: number, seed: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  const rng = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// ===== Step 2：层轮次窗口 =====

/** 日预算物理上限：maxDailyHits = floor(日预算分钟 × 60 / avg_hit) */
export function maxDailyHits(params: PlanParams): number {
  return Math.max(1, Math.floor((params.dailyBudgetMin * 60) / params.avgHitSec));
}

/**
 * 各层各轮起止日。层内 R 轮在 T 窗口内等分（或按 tierRoundDays 不等分），
 * 任一轮窗口不得短于 ceil(W_t / maxDailyHits) 天（物理下限，PRD §4.4.3 Step 2）；
 * 不足时扩到下限并置 floorViolated（是否可行由 validatePlan 的 pass/fail 反映）。
 */
export function planRounds(params: PlanParams, tierCounts: TierWordCounts): PlanRoundWindow[] {
  const T = Math.max(1, diffDays(params.deadlineDate, params.startDate));
  const maxDaily = maxDailyHits(params);
  const windows: PlanRoundWindow[] = [];

  for (const tier of TIERS) {
    const W = tierCounts[tier] ?? 0;
    const R = params.tierRounds[tier] ?? 0;
    if (W <= 0 || R <= 0) continue;

    const floorDays = Math.ceil(W / maxDaily);
    const custom = params.tierRoundDays?.[tier];
    let lengths: number[];
    if (custom && custom.length === R) {
      lengths = custom.map((n) => Math.max(1, Math.floor(n)));
    } else {
      const base = Math.floor(T / R);
      const rem = T % R;
      lengths = Array.from({ length: R }, (_, i) => base + (i < rem ? 1 : 0));
    }
    // 物理下限
    lengths = lengths.map((l) => Math.max(l, floorDays));

    let cursor = params.startDate;
    lengths.forEach((len, i) => {
      const s = cursor;
      const e = addDays(s, len - 1);
      windows.push({
        tier,
        roundNo: i + 1,
        startDate: s,
        endDate: e,
        days: len,
        wordCount: W,
        physicalFloorDays: floorDays,
        floorViolated: len < floorDays,
      });
      cursor = addDays(e, 1);
    });
  }
  return windows;
}

/** 计划最后一个窗口的结束日（= 当前排布下的完成日） */
export function planFinishDate(params: PlanParams, tierCounts: TierWordCounts): string {
  const windows = planRounds(params, tierCounts);
  if (windows.length === 0) return params.startDate;
  return windows.reduce((acc, w) => (w.endDate > acc ? w.endDate : acc), windows[0].endDate);
}

// ===== 模态分配 =====

/** 单词级模态判定（哈希近似；批量路径在 expandDayForWords 内取精确配额） */
export function assignModality(tier: Tier, wordId: string, ratio: number, daySeed: number): Modality {
  const h = hashString(`${wordId}|${tier}|${daySeed}`) / 4294967296;
  return h < ratio ? 'audio' : 'visual';
}

// ===== Step 3：每日词表展开 =====

/** 词→槽位映射构建 */
function slotMap(words: string[]): Map<string, number> {
  const m = new Map<string, number>();
  words.forEach((w, i) => m.set(w, i));
  return m;
}

/**
 * 核心：按真实词表展开某日队列。
 * @param wordsByTier 各层词 ID 列表（层内规范顺序，List 由 listSize 切分）
 */
export function expandDayForWords(
  params: PlanParams,
  wordsByTier: Record<Tier, string[]>,
  date: string,
  steadyWords: WordSteadiness[],
): QueueEntry[] {
  if (date < params.startDate || date > params.deadlineDate) return [];

  const tierCounts: TierWordCounts = {};
  for (const t of TIERS) tierCounts[t] = wordsByTier[t]?.length ?? 0;
  const windows = planRounds(params, tierCounts);
  const steadyIds = new Set(steadyWords.filter((s) => s.steady).map((s) => s.wordId));
  const daySeed = epochDay(date);
  const entries: QueueEntry[] = [];

  for (const tier of TIERS) {
    const words = wordsByTier[tier] ?? [];
    if (words.length === 0) continue;
    const tierWindows = windows.filter((w) => w.tier === tier).sort((a, b) => a.roundNo - b.roundNo);
    const R = params.tierRounds[tier];
    const slots = slotMap(words);

    // 逐轮构建 词 → 绝对日 映射（gap 顺延链式传递：每轮相对上一轮校验）
    const schedules: Map<string, { absDay: number; roundNo: number }>[] = [];
    for (const win of tierWindows) {
      const skipMiddle = params.masteryDecayEnabled && skipAllowed(win.roundNo, R);
      const eff = words
        .map((w, i) => ({ wordId: w, slot: i }))
        .filter((e) => !(skipMiddle && steadyIds.has(e.wordId)));
      const W = eff.length;
      const map = new Map<string, { absDay: number; roundNo: number }>();
      if (W === 0) {
        schedules.push(map);
        continue;
      }
      const order = shuffledOrder(W, roundSeed(tier, win.roundNo));
      const startE = epochDay(win.startDate);
      const endE = epochDay(win.endDate);
      for (let k = 0; k < W; k++) {
        const e = eff[order[k]];
        // 基础日程：乱序位置 k 均匀铺到窗口 L 天上
        let absDay = startE + Math.floor((k * win.days) / W);
        // gap 约束：与该词上一次出现（更早轮）至少间隔 gapMinDays，冲突顺延
        if (params.gapMinDays > 0) {
          for (let r = schedules.length - 1; r >= 0; r--) {
            const prev = schedules[r].get(e.wordId);
            if (prev) {
              if (absDay - prev.absDay < params.gapMinDays) {
                absDay = Math.min(endE, prev.absDay + params.gapMinDays);
              }
              break;
            }
          }
        }
        map.set(e.wordId, { absDay, roundNo: win.roundNo });
      }
      schedules.push(map);
    }

    // 当日所在窗口
    const win = tierWindows.find((w) => date >= w.startDate && date <= w.endDate);
    if (!win) continue;
    const winIdx = tierWindows.indexOf(win);
    const sched = schedules[winIdx];
    const dayE = epochDay(date);
    const ratio = params.modalRatio[tier] ?? 0;

    const todayWords: { wordId: string; slot: number; posIdx: number; lastSeen?: DayExplain['lastSeen'] }[] = [];
    for (const [wordId, info] of sched) {
      if (info.absDay !== dayE) continue;
      // lastSeen：向前找最近一次出现（modality 为调度期哈希近似，实际以当日展开为准）
      let lastSeen: DayExplain['lastSeen'];
      for (let r = winIdx - 1; r >= 0; r--) {
        const prev = schedules[r].get(wordId);
        if (prev) {
          lastSeen = {
            date: isoFromEpochDay(prev.absDay),
            roundNo: prev.roundNo,
            modality: assignModality(tier, wordId, ratio, prev.absDay),
          };
          break;
        }
      }
      todayWords.push({ wordId, slot: slots.get(wordId) ?? 0, posIdx: 0, lastSeen });
    }
    if (todayWords.length === 0) continue;

    // 模态精确配额：当日各层词块内按 ratio 取 round(n×ratio) 个听觉 hit，
    // 由 hash(wordId|tier|daySeed) 升序决定归属（确定性）
    const n = todayWords.length;
    const audioCount = Math.max(0, Math.min(n, Math.round(n * ratio)));
    const ranked = todayWords
      .map((w) => ({ w, h: hashString(`${w.wordId}|${tier}|${daySeed}`) }))
      .sort((a, b) => a.h - b.h);
    const audioIds = new Set(ranked.slice(0, audioCount).map((x) => x.w.wordId));

    for (const tw of todayWords) {
      entries.push({
        wordId: tw.wordId,
        tier,
        roundNo: win.roundNo,
        listNo: Math.floor(tw.slot / Math.max(1, params.listSize)),
        modality: audioIds.has(tw.wordId) ? 'audio' : 'visual',
        explain: { roundIdxInWindow: diffDays(date, win.startDate), lastSeen: tw.lastSeen },
      });
    }
  }

  // 稳定输出：层 → List → 词
  entries.sort((a, b) => a.tier - b.tier || a.listNo - b.listNo || (a.wordId < b.wordId ? -1 : 1));
  return entries;
}

/**
 * 按各层词量展开某日队列（架构文档 §4 签名）。
 * 词 ID 用层内序号合成占位（t{tier}-{i}）；真实词表请用 expandDayForWords，
 * 由 repository 层按 (book_id, tier, order_in_list) 排序后传入。
 */
export function expandDay(
  params: PlanParams,
  tierCounts: TierWordCounts,
  date: string,
  steadyWords: WordSteadiness[],
): QueueEntry[] {
  const wordsByTier: Record<Tier, string[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const t of TIERS) {
    const W = tierCounts[t] ?? 0;
    wordsByTier[t] = Array.from({ length: W }, (_, i) => `t${t}-${i}`);
  }
  return expandDayForWords(params, wordsByTier, date, steadyWords);
}
