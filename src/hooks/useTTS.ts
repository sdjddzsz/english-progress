/**
 * useTTS.ts —— 前台 TTS Hook：
 * 编排器单例（缓存 → 神经主轨 → espeak 兜底 → PronunciationLog），页面只需 speak()。
 * 运行时密钥仅保留在会话内存（模块级变量），不落 localStorage / 代码（架构 §8 #2）。
 */
import { useCallback, useState } from 'react';
import type { TTSEngine } from '../types/domain';
import { cacheStorageCache, consumeFallbackNotice, createOrchestrator, inMemoryAudioCache, type AudioCache, type TTSOrchestrator } from '../tts/orchestrator';
import { LruAudioCache } from '../offline/audioCacheManager';
import type { TTSRequest } from '../tts/types';
import { recordCacheHit, recordSynthesis } from '../tts/usageStats';
import { getRepos, useAppStore } from '../store/useAppStore';

// ===== 会话级运行时密钥（刷新即失；设置页可随时更新）=====

let runtimeApiKey = '';

export function setRuntimeTTSApiKey(key: string): void {
  runtimeApiKey = key.trim();
}

export function peekRuntimeTTSApiKey(): string {
  return runtimeApiKey;
}

// ===== 编排器单例 =====

let orchestratorSingleton: TTSOrchestrator | null = null;

function getOrchestrator(): TTSOrchestrator {
  if (orchestratorSingleton) return orchestratorSingleton;
  const inner = (typeof caches !== 'undefined' ? cacheStorageCache() : inMemoryAudioCache()) as AudioCache & {
    remove(key: string): Promise<void>;
  };
  // T05：LRU 预算 50MB；当日队列词（按词形前缀匹配 cache key）优先保留
  const cache = new LruAudioCache(inner, {
    protectedKeys: async () => {
      const state = useAppStore.getState();
      const prefixes = new Set<string>();
      for (const h of state.todayHits) {
        const lemma = state.wordMap[h.wordId]?.lemma;
        if (lemma) prefixes.add(`${lemma}|`);
      }
      return [...prefixes];
    },
  });
  orchestratorSingleton = createOrchestrator({
    cache,
    getConfig: async () => {
      const userId = useAppStore.getState().userId ?? 'local-user';
      const config = await getRepos().config.getTTSConfig(userId);
      if (!config) return null;
      // key 从会话内存取（用户在设置页粘贴）；云端配置文档里的 apiKeyRef 指向的字段由部署侧填充
      return { config, ...(runtimeApiKey ? { apiKey: runtimeApiKey } : {}) };
    },
    log: async (entry) => {
      try {
        await getRepos().feedback.logPronunciation({
          wordId: entry.wordId ?? '',
          engine: entry.engine,
          success: entry.success,
          fallbackUsed: entry.fallbackUsed,
          ...(entry.error ? { error: entry.error } : {}),
          ...(entry.chars != null ? { chars: entry.chars } : {}),
          ...(entry.phonemeSource ? { phonemeSource: entry.phonemeSource } : {}),
        });
      } catch {
        // 日志失败不阻断学习
      }
    },
  });
  return orchestratorSingleton;
}

// ===== 音频播放（Blob → <audio>）=====

async function playBuffer(audio: ArrayBuffer): Promise<void> {
  if (typeof Audio === 'undefined') return; // 非浏览器环境静默
  const blob = new Blob([audio], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const el = new Audio(url);
      el.onended = () => resolve();
      el.onerror = () => reject(new Error('audio playback failed'));
      void el.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ===== Hook =====

export interface UseTTSApi {
  /** 返回实际命中的引擎（neural_tts 主轨 / ipa_espeak 兜底）；失败返回 null */
  speak(req: TTSRequest, wordId?: string): Promise<TTSEngine | null>;
  loading: boolean;
  lastEngine: TTSEngine | null;
  /** espeak 兜轨首次触发的一次性轻提示（消费一次后复位） */
  fallbackNotice: boolean;
  dismissFallbackNotice(): void;
}

export function useTTS(): UseTTSApi {
  const [loading, setLoading] = useState(false);
  const [lastEngine, setLastEngine] = useState<TTSEngine | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState(false);

  const speak = useCallback(async (req: TTSRequest, wordId?: string): Promise<TTSEngine | null> => {
    setLoading(true);
    try {
      const res = await getOrchestrator().getAudio(req, wordId);
      // P1-1 本地用量聚合：缓存命中不计字符；仅主轨（计费）合成计入
      if (res.fromCache) {
        recordCacheHit();
      } else if (res.engine === 'neural_tts') {
        recordSynthesis(res.usageChars ?? req.text.length);
      }
      setLastEngine(res.engine);
      await playBuffer(res.audio);
      if (consumeFallbackNotice()) setFallbackNotice(true);
      return res.engine;
    } catch (e) {
      // 发音失败不阻断学习；错误已在 PronunciationLog 留痕
      console.error('[tts] speak failed:', e);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const dismissFallbackNotice = useCallback(() => setFallbackNotice(false), []);
  return { speak, loading, lastEngine, fallbackNotice, dismissFallbackNotice };
}
