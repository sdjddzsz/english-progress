/**
 * audioCache.test.ts —— 音频缓存 LRU 上限（T05：50MB 预算 + 当日队列优先）：
 * - 超预算按最久未访问淘汰；
 * - 受保护 key（当日队列词）永不淘汰；
 * - get 刷新访问序（最近使用的不会被先淘汰）；
 * - Cache Storage 直删版在无 caches 环境安全返回 0。
 */
import { describe, expect, it } from 'vitest';
import { LruAudioCache, pruneCacheStorage, recordingMemoryCache } from '../../src/offline/audioCacheManager';
import { AUDIO_CACHE_BUDGET_BYTES } from '../../src/config/constants';

function buf(bytes: number): ArrayBuffer {
  return new ArrayBuffer(bytes);
}

describe('音频缓存 LRU', () => {
  it('默认预算常量为 50MB（硬约束口径）', () => {
    expect(AUDIO_CACHE_BUDGET_BYTES).toBe(50 * 1024 * 1024);
  });

  it('超预算：最久未访问者先被淘汰，回到预算内', async () => {
    const inner = recordingMemoryCache();
    // 预算 1000B：put 3 条 400B → 1200B 超限，淘汰最旧的 k1
    const lru = new LruAudioCache(inner, { budgetBytes: 1000 });
    await lru.put('k1', buf(400), 'ipa_espeak');
    await lru.put('k2', buf(400), 'ipa_espeak');
    await lru.put('k3', buf(400), 'ipa_espeak');
    expect(inner.keys()).toContain('k2');
    expect(inner.keys()).toContain('k3');
    expect(lru.totalBytes()).toBeLessThanOrEqual(1000);
    expect(inner.keys().length).toBe(2); // k1 已从内层淘汰
  });

  it('受保护 key（当日队列）永不淘汰：全是受保护 key 时允许超预算', async () => {
    const inner = recordingMemoryCache();
    const lru = new LruAudioCache(inner, {
      budgetBytes: 600,
      protectedKeys: async () => ['today1', 'today2'],
    });
    await lru.put('today1', buf(400), 'ipa_espeak');
    await lru.put('today2', buf(400), 'ipa_espeak');
    // 800B > 600B，但全部受保护 → 不淘汰
    expect(inner.keys().length).toBe(2);
    // 再放一个不受保护的 → 只淘汰它自己或更旧的非保护项（无非保护旧项时淘汰新非保护项）
    await lru.put('other', buf(400), 'ipa_espeak');
    expect(inner.keys()).not.toContain('other');
    expect(inner.keys()).toContain('today1');
    expect(inner.keys()).toContain('today2');
  });

  it('get 刷新访问序：最近读取的 key 不先淘汰', async () => {
    const inner = recordingMemoryCache();
    const lru = new LruAudioCache(inner, { budgetBytes: 800 });
    await lru.put('a', buf(400), 'ipa_espeak');
    await lru.put('b', buf(400), 'ipa_espeak');
    await lru.get('a'); // a 变为最近使用
    await lru.put('c', buf(400), 'ipa_espeak'); // 超预算 → 淘汰 b（最旧未访问）
    expect(inner.keys()).toContain('a');
    expect(inner.keys()).not.toContain('b');
    expect(inner.keys()).toContain('c');
  });

  it('pruneCacheStorage：无 caches 环境（Node 测试）安全返回 0', async () => {
    const evicted = await pruneCacheStorage('tts-audio', AUDIO_CACHE_BUDGET_BYTES, []);
    expect(evicted).toBe(0);
  });
});
