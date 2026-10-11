/**
 * audioCacheManager.ts —— 音频缓存 LRU 上限（T05，架构 §1.6 / PRD 音频缓存预算）：
 * - 预算 AUDIO_CACHE_BUDGET_BYTES（50MB），超限按最久未访问淘汰；
 * - 当日队列词的缓存 key 受保护，不被淘汰（当日离线刷词优先）；
 * - 双实现：Cache Storage 直删（浏览器）与内存 LRU（测试 / 内层包装）。
 */
import { AUDIO_CACHE_BUDGET_BYTES } from '../config/constants';
import type { AudioCache } from '../tts/orchestrator';

export interface LruOptions {
  budgetBytes?: number;
  /** 受保护 key（当日队列词），永不淘汰；支持前缀匹配（key = `${text}|${mode}|${voice}`） */
  protectedKeys?: () => Promise<string[]>;
}

interface LruMeta {
  key: string;
  size: number;
  lastAt: number;
}

/** 挂接访问序与体积的 LRU 包装：put/get 都刷新访问序（单调计数，免同毫秒抖动），put 后超预算即剪枝 */
export class LruAudioCache implements AudioCache {
  private meta = new Map<string, LruMeta>();
  private tick = 0;
  private opts: Required<Pick<LruOptions, 'budgetBytes'>> & LruOptions;

  constructor(
    private readonly inner: AudioCache & { remove(key: string): Promise<void> },
    opts: LruOptions = {},
  ) {
    this.opts = { budgetBytes: opts.budgetBytes ?? AUDIO_CACHE_BUDGET_BYTES, ...opts };
  }

  private nextTick(): number {
    this.tick += 1;
    return this.tick;
  }

  /** 供测试/诊断读当前体积 */
  totalBytes(): number {
    let sum = 0;
    for (const m of this.meta.values()) sum += m.size;
    return sum;
  }

  async get(key: string): Promise<{ audio: ArrayBuffer; engine: Parameters<AudioCache['put']>[2] } | null> {
    const hit = await this.inner.get(key);
    if (!hit) return null;
    const m = this.meta.get(key);
    if (m) {
      m.lastAt = this.nextTick();
    } else {
      // 内层已有但元数据缺失（如重启后）：按实际字节数补记
      this.meta.set(key, { key, size: hit.audio.byteLength, lastAt: this.nextTick() });
    }
    return hit;
  }

  async put(key: string, audio: ArrayBuffer, engine: Parameters<AudioCache['put']>[2]): Promise<void> {
    await this.inner.put(key, audio, engine);
    this.meta.set(key, { key, size: audio.byteLength, lastAt: this.nextTick() });
    await this.prune();
  }

  /** 超预算 → 淘汰最久未访问且不受保护的 key，直到回到预算内 */
  async prune(): Promise<number> {
    const budget = this.opts.budgetBytes;
    const protectedList = (await this.opts.protectedKeys?.()) ?? [];
    const isProtected = (k: string): boolean =>
      protectedList.some((p) => k === p || k.startsWith(p));
    let evicted = 0;
    for (;;) {
      let total = this.totalBytes();
      if (total <= budget) break;
      let oldest: LruMeta | null = null;
      for (const m of this.meta.values()) {
        if (isProtected(m.key)) continue;
        if (!oldest || m.lastAt < oldest.lastAt) oldest = m;
      }
      if (!oldest) break; // 全是受保护 key：允许超预算（当日队列本身超限时不再驱逐）
      await this.inner.remove(oldest.key); // 内层实际删除（Cache Storage / 内存）
      this.meta.delete(oldest.key);
      total -= oldest.size;
      evicted += 1;
    }
    return evicted;
  }

  /** 内存元数据与内层（如 Cache Storage）可能失步：以 inner 删除为准的显式清除 */
  async remove(key: string): Promise<void> {
    this.meta.delete(key);
  }
}

/** Cache Storage 直删版剪枝（浏览器全局调用；key 顺序≈插入序，与 LRU 元数据互补） */
export async function pruneCacheStorage(
  cacheName: string,
  budgetBytes = AUDIO_CACHE_BUDGET_BYTES,
  protectedKeys: string[] = [],
): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const protectedSet = new Set(protectedKeys);
  const sizes = new Map<string, number>();
  let total = 0;
  for (const req of keys) {
    const res = await cache.match(req);
    const size = res ? (await res.arrayBuffer()).byteLength : 0;
    sizes.set(req.url, size);
    total += size;
  }
  if (total <= budgetBytes) return 0;
  let evicted = 0;
  for (const req of keys) {
    if (total <= budgetBytes) break;
    const url = req.url;
    if (protectedSet.has(url)) continue;
    await cache.delete(req);
    total -= sizes.get(url) ?? 0;
    evicted += 1;
  }
  return evicted;
}

/** 测试用：内存 AudioCache（记录 put 顺序，便于断言淘汰对象） */
export function recordingMemoryCache(): Omit<AudioCache, 'remove'> & {
  remove(key: string): Promise<void>;
  keys(): string[];
} {
  const store = new Map<string, { audio: ArrayBuffer; engine: 'neural_tts' | 'ipa_espeak' }>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, audio, engine) {
      store.delete(key); // 重插到末尾（保持插入序=最近序）
      store.set(key, { audio, engine });
    },
    async remove(key) {
      store.delete(key);
    },
    keys: () => [...store.keys()],
  };
}
