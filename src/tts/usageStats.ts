/**
 * usageStats.ts —— P1-1 本地用量聚合（localStorage 'tts_usage_v1'）。
 * 口径：本月合成字符数 / 请求数 / 缓存命中数（成本卡数据源）。
 * 只统计字符与金额相关量，不落云端、不含任何"学了多少分/正确率"形态（反自测硬约束 #1）。
 */

const STORAGE_KEY = 'tts_usage_v1';

export interface UsageStats {
  /** 归属月份 'YYYY-MM'；跨月读取时自动归零 */
  month: string;
  /** 本月合成字符数（DashScope usage.characters 口径；无 usage 字段时按请求文本长度估算） */
  chars: number;
  /** 本月合成请求数（不含缓存命中；espeak 兜底不计入，不计费） */
  requests: number;
  /** 本月缓存命中次数 */
  cacheHits: number;
}

/** 本地存储（SSR / 隐私模式下降级为内存空实现，不抛错） */
function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 读取本月用量；跨月或数据损坏时归零重建 */
export function readUsageStats(now: Date = new Date()): UsageStats {
  const current: UsageStats = { month: monthOf(now), chars: 0, requests: 0, cacheHits: 0 };
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return current;
  try {
    const parsed = JSON.parse(raw) as Partial<UsageStats>;
    if (parsed.month !== current.month) return current;
    return {
      month: current.month,
      chars: Number.isFinite(parsed.chars) ? Number(parsed.chars) : 0,
      requests: Number.isFinite(parsed.requests) ? Number(parsed.requests) : 0,
      cacheHits: Number.isFinite(parsed.cacheHits) ? Number(parsed.cacheHits) : 0,
    };
  } catch {
    return current;
  }
}

function writeUsageStats(stats: UsageStats): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(stats));
}

/** 记录一次主轨合成（chars = usage.characters 或文本长度估算） */
export function recordSynthesis(chars: number): void {
  const s = readUsageStats();
  writeUsageStats({ ...s, chars: s.chars + Math.max(0, Math.floor(chars)), requests: s.requests + 1 });
}

/** 记录一次缓存命中（不产生新字符） */
export function recordCacheHit(): void {
  const s = readUsageStats();
  writeUsageStats({ ...s, cacheHits: s.cacheHits + 1 });
}

/** 清空本地用量统计（设置页手动重置用） */
export function resetUsageStats(): void {
  storage()?.removeItem(STORAGE_KEY);
}

/** 缓存命中率（0~1；无任何播放时 0） */
export function cacheHitRate(stats: UsageStats): number {
  const total = stats.requests + stats.cacheHits;
  return total === 0 ? 0 : stats.cacheHits / total;
}
