/**
 * useTTS.ts —— 前台 TTS Hook：
 * 编排器单例（缓存 → 神经主轨 → espeak 兜底 → PronunciationLog），页面只需 speak()。
 * 运行时密钥仅保留在会话内存（模块级变量），不落 localStorage / 代码（架构 §8 #2）。
 */
import { useCallback, useState } from 'react';
import type { TTSEngine } from '../types/domain';
import { cacheStorageCache, consumeFallbackNotice, createOrchestrator, inMemoryAudioCache, type TTSOrchestrator } from '../tts/orchestrator';
import type { TTSRequest } from '../tts/types';
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
  const cache = typeof caches !== 'undefined' ? cacheStorageCache() : inMemoryAudioCache();
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
  speak(req: TTSRequest, wordId?: string): Promise<void>;
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

  const speak = useCallback(async (req: TTSRequest, wordId?: string) => {
    setLoading(true);
    try {
      const res = await getOrchestrator().getAudio(req, wordId);
      setLastEngine(res.engine);
      await playBuffer(res.audio);
      if (consumeFallbackNotice()) setFallbackNotice(true);
    } catch (e) {
      // 发音失败不阻断学习；错误已在 PronunciationLog 留痕
      console.error('[tts] speak failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const dismissFallbackNotice = useCallback(() => setFallbackNotice(false), []);
  return { speak, loading, lastEngine, fallbackNotice, dismissFallbackNotice };
}
