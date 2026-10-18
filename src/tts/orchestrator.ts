/**
 * orchestrator.ts —— TTS 编排（架构 §1.6 流程）：
 * 缓存命中 → 主轨（active 且有 key）→ 失败/未配置/超时 → espeak 兜底 → PronunciationLog 落库
 * → 前台轻提示（每次会话仅一次，不阻断学习）。
 */
import type { TTSEngine, TTSProviderConfig } from '../types/domain';
import { espeakProvider } from './espeakProvider';
import { neuralProvider } from './neuralProvider';
import { sniffAudioMime } from './mime';
import type { PhonemeSource, TTSProvider, TTSRequest, TTSResult } from './types';
import type { RemoteAudioStore } from '../data/cloudAudioStore';
import { cloudAudioPath, cloudAudioStore } from '../data/cloudAudioStore';
import { isCloudConfigured } from '../data/cloud';

export interface AudioCache {
  get(key: string): Promise<{ audio: ArrayBuffer; engine: TTSEngine } | null>;
  put(key: string, audio: ArrayBuffer, engine: TTSEngine): Promise<void>;
  /** LRU 淘汰用（T05 audioCacheManager）；实现可选提供 */
  remove?(key: string): Promise<void>;
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
    async remove(key) {
      const c = await caches.open(cacheName);
      await c.delete(key);
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
    async remove(key) {
      map.delete(key);
    },
  };
}

/**
 * 缓存键（P2-2 修复；架构增量 v0.1 纳入 arpabet）：
 * - 加入 ipa / arpabet：同一 text 换音标或换发音真源必须产生新 key，杜绝改音标后返回陈旧音频；
 * - 长度前缀编码：text/mode/voice/ipa/arpabet 任意字段含 '|' 时不再产生歧义碰撞
 *   （如 voice="a|word" 与 text="a" + mode="word" 的旧实现会同 key 串音）。
 * 旧格式 key 自然失效（不迁移），按 LRU 预算逐步淘汰。
 */
function lenPrefixed(part: string): string {
  return `${part.length}:${part}`;
}

/**
 * 缓存 key（v2，2026-10-14 修复）。
 *
 * v1 只有 `text|mode|ipa|arpabet|voice`，而**所有页面调 speak() 都不传 voice**
 * ⇒ `req.voice` 恒为 undefined ⇒ key 与发音人、模型完全无关。
 * 后果一：换发音人 / 换模型后，同一个词命中旧音频 —— 用户报「所有发音人都是同一个音」。
 *
 * v2 把 voice + model 并进来（由调用方从云端配置取），并加 `v2` 版本前缀：
 * 前缀一改，线上已沉淀的旧格式缓存**自然失效、不迁移** —— 这一点是必需的，
 * 因为 v1 时代**兜底的机械音也被写进了缓存**（见 getAudio 里的修复注释），
 * 用户手机上「刷新也没用」正是命中了那份 espeak 音频；不清掉它就永远听不到主轨。
 */
export function cacheKey(req: TTSRequest, voice?: string, model?: string): string {
  // voice 双来源：优先调用方显式传入（编排器传云端配置里的真音色/模型），
  // 其次 req.voice（页面若传了也认）—— 两者都不传才视为空。
  return ['v2', req.text, req.mode, req.ipa ?? '', req.arpabet ?? '', voice ?? req.voice ?? '', model ?? '']
    .map(lenPrefixed)
    .join('|');
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
  /** P1-5：合成字符数（DashScope usage.characters 口径；从 TTSResult 透传） */
  chars?: number;
  /** P0-9：音素来源（从 TTSResult 透传；'text' = 纯文本降级） */
  phonemeSource?: PhonemeSource;
  /** 2026-10-14：云音频库缺词、本次为现场合成（合成成功后会回传云端） */
  cloudMiss?: boolean;
}

/**
 * 取音阶段（用户 2026-10-14：提示要按实际状态显示）：
 * - 'reading'      = 读已有音频（本地缓存命中 / 正在从云音频库下载）
 * - 'synthesizing' = 云音频库没这个词，正在现场合成
 */
export type AudioPhase = 'reading' | 'synthesizing';

export interface OrchestratorDeps {
  /** 读云端 TTSProviderConfig + 已解析 key（运行时从配置文档取入内存） */
  getConfig(): Promise<{ config: TTSProviderConfig; apiKey?: string } | null>;
  /** 当前用户 id（云音频库路径 shared/{uid}/... 需要；2026-10-18 修复路径归属） */
  getUserId?(): string | null;
  log(entry: PronunciationLogEntry): Promise<void>;
  cache: AudioCache;
  /** Provider 可注入（测试 mock） */
  neural?: TTSProvider;
  espeak?: TTSProvider;
  /**
   * 云音频库（可选）。未注入 = 关闭云端取音，行为退回旧逻辑（只走本地缓存 + 合成）。
   * 缺省实现会碰云 SDK，单测/SSR 请注入内存实现。
   */
  remote?: RemoteAudioStore | null;
  /** 阶段回调（UI 显示「读取中」/「合成中」） */
  onPhase?(phase: AudioPhase): void;
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const neural = deps.neural ?? neuralProvider;
  const espeak = deps.espeak ?? espeakProvider;
  // 未显式传 remote 时：仅当云已配置才启用云音频库（未配置 ⇒ 不查云、不计缺词）；
  // 显式传 null = 关闭云音频库（单测/非云环境）
  const remote: RemoteAudioStore | null =
    deps.remote === undefined ? (isCloudConfigured() ? cloudAudioStore() : null) : deps.remote;

  return {
    async getAudio(
      req: TTSRequest,
      wordId?: string,
      opts?: { skipCloudRead?: boolean },
    ): Promise<TTSResult> {
      // 先读配置：缓存 key 必须含 voice/model（v2），否则换音色不换 key、命中旧音频。
      // 多一次云端读仍在 <800ms 体验路径内，且只有未命中时才付这个代价。
      const cfg = await deps.getConfig();
      const voice = cfg?.config.voice;
      const model = cfg?.config.model;
      const key = cfg ? cacheKey(req, voice, model) : cacheKey(req);

      // 1) 本地缓存命中（<800ms 体验路径）
      deps.onPhase?.('reading');
      const hit = await deps.cache.get(key);
      if (hit) return { ...hit, fromCache: true };

      // 2) 云音频库（用户 2026-10-14）：该音色此前合成过这个词 → 直接取文件，不再合成。
      //    路径含音色目录 + 由含 voice/model 的 key 派生的 hash ⇒ 不可能取到别的音色的音频。
      //    无配置（音色未定）或无用户时不查云端：不确定归属就不该复用任何音频。
      //    skipCloudRead（regenerate 专用）：防止云删失败时把旧音频又读回来——
      //    重新合成必须真的重新合成，合成后 upsert 覆盖云端旧文件。
      let cloudPath: string | null = null;
      const userId = deps.getUserId?.() ?? null;
      if (remote && cfg && userId) {
        // 路径必须照算（regenerate 重录后要往这里覆盖写）；skipCloudRead 只跳过「读」——
        // 随后照常走主轨合成，合成成功照样 upsert 覆盖云端旧文件
        cloudPath = await cloudAudioPath(req, userId, voice, model);
        if (!opts?.skipCloudRead) {
          const cloudAudio = await remote.get(cloudPath);
          if (cloudAudio && cloudAudio.byteLength > 0) {
            // 回写本地缓存，下次连下载都省掉；engine 恒为主轨（云端只存主轨音频）
            await deps.cache.put(key, cloudAudio, 'neural_tts');
            return { audio: cloudAudio, engine: 'neural_tts', fromCache: true };
          }
        }
      }

      // 3) 主轨：status=active 且 key 已加载
      if (cfg && cfg.config.status === 'active' && cfg.apiKey) {
        try {
          deps.onPhase?.('synthesizing');
          const r = await neural.synthesize(req, { config: cfg.config, apiKey: cfg.apiKey });
          await deps.cache.put(key, r.audio, r.engine);
          // 云音频库缺词 → 合成成功即回传云端（后台，失败不阻断），
          // 下次同一音色遇到这个词直接读文件，不再付合成。
          // ★ 只传主轨音频：espeak 兜底音频不上传，否则机械音污染音色库。
          if (cloudPath && r.engine === 'neural_tts') {
            void remote?.put(cloudPath, r.audio, sniffAudioMime(r.audio));
          }
          await deps.log({
            engine: 'neural_tts',
            success: true,
            fallbackUsed: false,
            wordId,
            // 本次是「云音频库缺词 → 现场合成」：留痕以便统计待补词量。
            // 没启用云音频库时**不写这个键**（保持旧日志形态，零回退）
            ...(cloudPath ? { cloudMiss: true } : {}),
            ...(r.usageChars != null ? { chars: r.usageChars } : {}),
            ...(r.phonemeSource ? { phonemeSource: r.phonemeSource } : {}),
          });
          return r;
        } catch (err) {
          // 3) 主轨失败/超时 → 兜底轨 + 记录回退（本地 espeak 也是现场合成）
          deps.onPhase?.('synthesizing');
          const fb = await espeak.synthesize(req);
          // ★ 兜底音频**绝不入缓存**（2026-10-14 修复）：
          // 主轨失败多半是瞬时的（网络抖动 / CORS / 密钥未注入），
          // 一旦把机械音写进 CacheStorage，即使主轨随后恢复，同一个词也永远命中它 ——
          // 用户表现就是「手机一直机械音、刷新也没用」（缓存在 CacheStorage，刷新清不掉）。
          // 代价是兜底路径每次重新合成（本地 WASM，几十毫秒），可接受。
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

      // 4) 未配置 / pending_user_setup / error → 兜底轨（同样不入缓存、不上传云端，理由同上）
      deps.onPhase?.('synthesizing');
      const fb2 = await espeak.synthesize(req);
      fallbackNoticePending = true;
      await deps.log({ engine: 'ipa_espeak', success: true, fallbackUsed: true, wordId });
      return fb2;
    },

    /**
     * 重新合成（用户 2026-10-17：个别词的缓存音频是错的，需要一个「重录」入口）。
     * 步骤：删本地缓存该 key → 删云音频库该文件 → 走正常 getAudio（必缓存未命中）
     * → 现场重新合成 → 合成成功自动回传云端（getAudio 的 cloudMiss 上传路径）。
     * 云端也更新 = 其它设备下次也拿到新音频。
     */
    async regenerate(req: TTSRequest, wordId?: string): Promise<TTSResult> {
      const cfg = await deps.getConfig();
      const voice = cfg?.config.voice;
      const model = cfg?.config.model;
      const key = cfg ? cacheKey(req, voice, model) : cacheKey(req);
      await deps.cache.remove?.(key);
      const userId = deps.getUserId?.() ?? null;
      if (remote && cfg && userId) {
        const p = await cloudAudioPath(req, userId, voice, model);
        await remote.remove(p);
      }
      // skipCloudRead：就算云删因网络抖动失败、旧文件还在，也绝不取回旧音频——
      // 重新合成后 upsert（覆盖写）把云端换掉
      return this.getAudio(req, wordId, { skipCloudRead: true });
    },
  };
}

export type TTSOrchestrator = ReturnType<typeof createOrchestrator>;
