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
import { sniffAudioMime } from '../tts/mime';
import { speakWithWebSpeech } from '../tts/webSpeech';
import { getRepos, useAppStore } from '../store/useAppStore';
import { useSettingsStore } from '../store/useSettingsStore';

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
      // 未登录（userId 为空）→ 绝不伪造身份、不发云端请求：直接返回 null，
      // 编排器对 config === null 已有既有处理（回落 espeak 兜底轨），不新增分支。
      const userId = useAppStore.getState().userId;
      if (!userId) return null;
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

/**
 * 按魔数嗅探 MIME：mespeak 出的是 **WAV**（RIFF），主轨出的是 MP3。
 * 原来一律按 audio/mpeg 包 Blob —— WAV 数据挂 mp3 类型，浏览器解码器会直接失败，
 * 于是"点了发音没声音"且没有任何报错。
 */
function sniffMime(audio: ArrayBuffer): string {
  return sniffAudioMime(audio);
}

async function playBuffer(audio: ArrayBuffer): Promise<void> {
  if (typeof Audio === 'undefined') return; // 非浏览器环境静默
  if (!audio || audio.byteLength === 0) throw new Error('empty audio buffer');
  const blob = new Blob([audio], { type: sniffMime(audio) });
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const el = new Audio(url);
      el.onended = () => resolve();
      el.onerror = () => reject(new Error('audio playback failed'));
      // iOS/Safari 需要 playsinline 语义；<audio> 无此属性但预载可降失败率
      el.preload = 'auto';
      void el.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ===== Hook =====

export interface UseTTSApi {
  /** 返回实际命中的引擎（neural_tts 主轨 / ipa_espeak 兜底 / web_speech 内置）；失败返回 null */
  speak(req: TTSRequest, wordId?: string): Promise<TTSEngine | null>;
  /**
   * 自动发音：只在设置开关打开时朗读，关闭时是 no-op。
   * 用于"进入/揭晓当前词"这类无需用户点按钮的场景。
   */
  speakAuto(req: TTSRequest, wordId?: string): Promise<TTSEngine | null>;
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
  // 注意：这里用 getState() 而不是 useSettingsStore(selector) —— 后者依赖 React 渲染器，
  // 会让 useTTS() 无法在无渲染器环境（单测直接调用 hook）下使用。
  const autoSpeak = useSettingsStore.getState().autoSpeak;

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
      // 最后一道兜底：浏览器内置语音。编排链彻底走不通时至少保证"点了有声音"。
      const text = req.text || (req.ipa ? req.ipa.replace(/\//g, '') : '');
      const ok = await speakWithWebSpeech(text, { rate: req.mode === 'word' ? 0.85 : 0.95 });
      if (ok) {
        setLastEngine('web_speech');
        return 'web_speech';
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const speakAuto = useCallback(
    async (req: TTSRequest, wordId?: string): Promise<TTSEngine | null> => {
      if (!autoSpeak) return null;
      return speak(req, wordId);
    },
    [autoSpeak, speak],
  );

  const dismissFallbackNotice = useCallback(() => setFallbackNotice(false), []);
  return { speak, speakAuto, loading, lastEngine, fallbackNotice, dismissFallbackNotice };
}
