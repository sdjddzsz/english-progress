/**
 * useTTS.ts —— 前台 TTS Hook：
 * 编排器单例（缓存 → 神经主轨 → espeak 兜底 → PronunciationLog），页面只需 speak()。
 * 运行时密钥仅保留在会话内存（模块级变量），不落 localStorage / 代码（架构 §8 #2）。
 */
import { useCallback, useRef, useState } from 'react';
import type { TTSEngine } from '../types/domain';
import { cacheStorageCache, consumeFallbackNotice, createOrchestrator, inMemoryAudioCache, type AudioCache, type AudioPhase, type TTSOrchestrator } from '../tts/orchestrator';
import { LruAudioCache } from '../offline/audioCacheManager';
import type { TTSRequest, VoiceOverride } from '../tts/types';
import { recordCacheHit, recordSynthesis } from '../tts/usageStats';
import { sniffAudioMime } from '../tts/mime';
import { speakWithWebSpeech } from '../tts/webSpeech';
import { getRepos, useAppStore } from '../store/useAppStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { DASHSCOPE_DEFAULT_MODEL, DASHSCOPE_DEFAULT_VOICE } from '../config/constants';

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

// 当前阶段订阅者（用户 2026-10-14：提示要按实际状态显示「读取中」/「合成中」）。
// 编排器是单例、只建一次，故用模块级引用接收阶段回调，再由 hook 订阅。
let phaseListener: ((p: AudioPhase) => void) | null = null;

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
    getUserId: () => useAppStore.getState().userId,
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
    onPhase: (phase) => {
      phaseListener?.(phase);
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
          ...(entry.cloudMiss ? { cloudMiss: true } : {}),
          ...(entry.regenerate ? { regenerate: true } : {}),
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
  /** 取音阶段：reading=读已有音频（本地/云端文件）；synthesizing=现场合成；idle=未进行 */
  phase: AudioPhase | 'idle';
  /** 阶段文案（用户 2026-10-14：按实际状态显示「读取中…」/「合成中…」） */
  phaseLabel: string;
  lastEngine: TTSEngine | null;
  /** espeak 兜轨首次触发的一次性轻提示（消费一次后复位） */
  fallbackNotice: boolean;
  dismissFallbackNotice(): void;
  /**
   * 重新合成（用户 2026-10-17：个别词缓存音频是错的）：
   * 删本地缓存 + 删云音频库文件 → 现场重新合成 → 合成成功自动回传云端（其它设备也拿到新的）。
   */
  resynthesize(req: TTSRequest, wordId?: string): Promise<TTSEngine | null>;
  /**
   * 本轮临时模型/音色覆盖（用户 2026-10-18：长按「重新合成」按钮临选）。
   * null=用设置页配置；非 null=本轮所有发音（自动/手动/重录）都用它。
   * 只活在 hook 实例里（页卸载/新一轮即失效），不落任何存储。
   */
  voiceOverride: VoiceOverride | null;
  setVoiceOverride(v: VoiceOverride | null): void;
  /** 读当前生效的模型/音色（覆盖 > 设置页配置 > 常量默认）——供临换面板回显 */
  getEffectiveVoiceModel(): Promise<{ model: string; voice: string }>;
}

export function useTTS(): UseTTSApi {
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<AudioPhase | 'idle'>('idle');
  const [lastEngine, setLastEngine] = useState<TTSEngine | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState(false);
  // 本轮临时模型/音色覆盖：state 管渲染（徽标/面板回显），ref 管逻辑——
  // setVoiceOverride 后紧接着调 resynthesize 也能立刻拿到新值（state 更新是异步的，
  // 闭包里读 state 会拿到旧值，长按选完音色当场重录就不能漏）。
  const [voiceOverride, setVoiceOverrideState] = useState<VoiceOverride | null>(null);
  const voiceOverrideRef = useRef<VoiceOverride | null>(null);
  // 注意：这里用 getState() 而不是 useSettingsStore(selector) —— 后者依赖 React 渲染器，
  // 会让 useTTS() 无法在无渲染器环境（单测直接调用 hook）下使用。
  const autoSpeak = useSettingsStore.getState().autoSpeak;

  const setVoiceOverride = useCallback((v: VoiceOverride | null) => {
    voiceOverrideRef.current = v;
    setVoiceOverrideState(v);
  }, []);

  const getEffectiveVoiceModel = useCallback(async (): Promise<{ model: string; voice: string }> => {
    if (voiceOverrideRef.current) return { ...voiceOverrideRef.current };
    try {
      const userId = useAppStore.getState().userId;
      const config = userId ? await getRepos().config.getTTSConfig(userId) : null;
      if (config?.model) return { model: config.model, voice: config.voice || DASHSCOPE_DEFAULT_VOICE };
    } catch {
      // 读不到配置（断网等）：回落到常量默认，面板仍可操作
    }
    return { model: DASHSCOPE_DEFAULT_MODEL, voice: DASHSCOPE_DEFAULT_VOICE };
  }, []);

  const speak = useCallback(async (req: TTSRequest, wordId?: string): Promise<TTSEngine | null> => {
    setLoading(true);
    // 默认「读取中」：先本地缓存、再云音频库；真要现场合成时编排器会回调改成 synthesizing
    setPhase('reading');
    phaseListener = setPhase;
    try {
      const res = await getOrchestrator().getAudio(
        req,
        wordId,
        voiceOverrideRef.current ? { voiceOverride: voiceOverrideRef.current } : undefined,
      );
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
      setPhase('idle');
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

  const resynthesize = useCallback(
    async (req: TTSRequest, wordId?: string): Promise<TTSEngine | null> => {
      setLoading(true);
      setPhase('synthesizing');
      phaseListener = setPhase;
      try {
        const res = await getOrchestrator().regenerate(
          req,
          wordId,
          voiceOverrideRef.current ? { voiceOverride: voiceOverrideRef.current } : undefined,
        );
        if (res.engine === 'neural_tts' && !res.fromCache) {
          recordSynthesis(res.usageChars ?? req.text.length);
        }
        setLastEngine(res.engine);
        await playBuffer(res.audio);
        if (consumeFallbackNotice()) setFallbackNotice(true);
        return res.engine;
      } catch (e) {
        console.error('[tts] resynthesize failed:', e);
        const text = req.text || (req.ipa ? req.ipa.replace(/\//g, '') : '');
        const ok = await speakWithWebSpeech(text, { rate: req.mode === 'word' ? 0.85 : 0.95 });
        if (ok) {
          setLastEngine('web_speech');
          return 'web_speech';
        }
        return null;
      } finally {
        setLoading(false);
        setPhase('idle');
      }
    },
    [],
  );

  const phaseLabel = phase === 'synthesizing' ? '合成中…' : '读取中…';
  return {
    speak,
    speakAuto,
    loading,
    phase,
    phaseLabel,
    lastEngine,
    fallbackNotice,
    dismissFallbackNotice,
    resynthesize,
    voiceOverride,
    setVoiceOverride,
    getEffectiveVoiceModel,
  };
}
