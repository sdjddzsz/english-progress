/**
 * orchestrator.ts —— TTS 编排（架构 §1.6 流程）：
 * 缓存命中 → 主轨（active 且有 key）→ 失败/未配置/超时 → espeak 兜底 → PronunciationLog 落库
 * → 前台轻提示（每次会话仅一次，不阻断学习）。
 */
import type { TTSEngine, TTSProviderConfig } from '../types/domain';
import { espeakProvider } from './espeakProvider';
import { neuralProvider } from './neuralProvider';
import type { TTSProvider, TTSRequest, TTSResult } from './types';

export interface AudioCache {
  get(key: string): Promise<{ audio: ArrayBuffer; engine: TTSEngine } | null>;
  put(key: string, audio: ArrayBuffer, engine: TTSEngine): Promise<void>;
}

/** Cache Storage 实现（浏览器）；engine 存于 Response header，音频反序列化即可播 */
export function cacheStorageCache(cacheName = 'tts-audio'): AudioCache {
  return {
    async get(key) {
      const c = await caches.open(cacheName);
      const res = await c.match(key);
      if (!res) return null;
      const engine = (res.headers.get('x-engine') ?? 'ipa_espeak') as TTSEngine;
      return { audio: await res.arrayBuffer(), engine };
    },
    async put(key, audio, engine) {
      const c = await caches.open(cacheName);
      await c.put(key, new Response(audio, { headers: { 'x-engine': engine, 'Content-Type': 'audio/mpeg' } }));
    },
  };
}

/** 内存实现（测试 / SSR） */
export function inMemoryAudioCache(): AudioCache {
  const map = new Map<string, { audio: ArrayBuffer; engine: TTSEngine }>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, audio, engine) {
      map.set(key, { audio, engine });
    },
  };
}

export function cacheKey(req: TTSRequest): string {
  return `${req.text}|${req.mode}|${req.voice ?? ''}`;
}

// ===== 前台轻提示（本会话仅一次）=====

let fallbackNoticePending = false;

/** 兜底轨首次触发时置位；UI 消费一次后清除 */
export function consumeFallbackNotice(): boolean {
  const pending = fallbackNoticePending;
  fallbackNoticePending = false;
  return pending;
}

export function resetFallbackNotice(): void {
  fallbackNoticePending = false;
}

export interface PronunciationLogEntry {
  engine: TTSEngine;
  success: boolean;
  fallbackUsed: boolean;
  error?: string;
  wordId?: string;
}

export interface OrchestratorDeps {
  /** 读云端 TTSProviderConfig + 已解析 key（运行时从配置文档取入内存） */
  getConfig(): Promise<{ config: TTSProviderConfig; apiKey?: string } | null>;
  log(entry: PronunciationLogEntry): Promise<void>;
  cache: AudioCache;
  /** Provider 可注入（测试 mock） */
  neural?: TTSProvider;
  espeak?: TTSProvider;
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const neural = deps.neural ?? neuralProvider;
  const espeak = deps.espeak ?? espeakProvider;

  return {
    async getAudio(req: TTSRequest, wordId?: string): Promise<TTSResult> {
      const key = cacheKey(req);
      // 1) 缓存命中（<800ms 体验路径）
      const hit = await deps.cache.get(key);
      if (hit) return { ...hit, fromCache: true };

      // 2) 主轨：status=active 且 key 已加载
      const cfg = await deps.getConfig();
      if (cfg && cfg.config.status === 'active' && cfg.apiKey) {
        try {
          const r = await neural.synthesize(req, { config: cfg.config, apiKey: cfg.apiKey });
          await deps.cache.put(key, r.audio, r.engine);
          await deps.log({ engine: 'neural_tts', success: true, fallbackUsed: false, wordId });
          return r;
        } catch (err) {
          // 3) 主轨失败/超时 → 兜底轨 + 记录回退
          const fb = await espeak.synthesize(req);
          await deps.cache.put(key, fb.audio, fb.engine);
          fallbackNoticePending = true;
          await deps.log({
            engine: 'ipa_espeak',
            success: true,
            fallbackUsed: true,
            error: err instanceof Error ? err.message : String(err),
            wordId,
          });
          return fb;
        }
      }

      // 4) 未配置 / pending_user_setup / error → 兜底轨
      const fb2 = await espeak.synthesize(req);
      await deps.cache.put(key, fb2.audio, fb2.engine);
      fallbackNoticePending = true;
      await deps.log({ engine: 'ipa_espeak', success: true, fallbackUsed: true, wordId });
      return fb2;
    },
  };
}

export type TTSOrchestrator = ReturnType<typeof createOrchestrator>;
