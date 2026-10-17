/**
 * cloudAudioStore.ts —— 云音频库（用户 2026-10-14）：
 * 「同一音色第一次合成某个词的读音 → 存进云空间；该音色以后再遇这个词 → 直接取文件，不再合成」。
 *
 * ★ 音色匹配是硬约束（用户原话：不可以设置了某音色却拿别的音色的读音文件代替）：
 *   对象路径 = `tts/{voiceSlug}/{keyHash}.mp3`，两道保险 ——
 *   ① 目录按音色分隔；② keyHash 由含 voice+model 的 cacheKey 派生（v2 key），
 *      换音色/换模型/换音标 → hash 必变 → 绝不会命中别的音色的文件。
 *
 * ★ 只存主轨音频：兜底机械音（espeak）不上传，否则机械音会污染音色库，
 *   将来主轨恢复也永远听到旧机械音（与本地缓存「兜底不入缓存」同一口径）。
 */
import { getCloud } from './cloud';
import { cacheKey } from '../tts/orchestrator';
import type { TTSRequest } from '../tts/types';

/** 云端目录前缀（不按用户隔离：同一音色同一词的读音对所有用户一致，共享可省合成次数） */
export const CLOUD_AUDIO_PREFIX = 'tts';

/**
 * 云音频读取上限（毫秒）。
 * 云端取音是**加速路径**（命中就不用合成），但绝不能反过来拖慢发音：
 * 网络慢/存储不可用时，宁可放弃本次复用、直接现场合成，也不能让用户干等。
 */
export const CLOUD_AUDIO_READ_TIMEOUT_MS = 3000;

/** 远程音频库接口（编排器只依赖这个抽象，便于注入内存实现做单测） */
export interface RemoteAudioStore {
  /** 命中返回音频字节；未命中返回 null（网络错误也返回 null —— 云端不可用不该阻断学习） */
  get(path: string): Promise<ArrayBuffer | null>;
  /** 上传（upsert）；失败静默 —— 下次仍可现场合成 */
  put(path: string, audio: ArrayBuffer, mime: string): Promise<boolean>;
  /** 删除（用户 2026-10-17「重新合成」：把云端坏音频清掉，下次合成后回传新的）；失败静默 */
  remove(path: string): Promise<boolean>;
}

/** 路径里只保留安全字符：音色名可能含空格/斜杠等 */
export function slugifyVoice(voice: string): string {
  const s = voice.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'default';
}

/** 同步 fallback hash（crypto.subtle 不可用 / 非安全上下文时） */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

/** 对 cacheKey 做摘要（浏览器用 SHA-256 前 16 字节 hex，不可用时退化为 FNV） */
export async function hashKey(key: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
      return [...new Uint8Array(buf)]
        .slice(0, 16)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      // 落到同步 hash
    }
  }
  return `fnv${fnv1a32(key)}`;
}

/**
 * 云端对象路径（纯函数，可单测）。
 * voice 缺省时归到 `default` 目录 —— 与「没设音色」的语义一致，不会串到具体音色。
 */
export async function cloudAudioPath(
  req: TTSRequest,
  voice?: string,
  model?: string,
): Promise<string> {
  const key = cacheKey(req, voice, model);
  return `${CLOUD_AUDIO_PREFIX}/${slugifyVoice(voice ?? '')}/${await hashKey(key)}.mp3`;
}

/** 给任意 promise 套超时：超时返回 null（调用方按「未命中」处理） */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 云 SDK storage 实现（唯一允许碰 SDK 的地方：cloud.ts 导出 getCloud） */
export function cloudAudioStore(): RemoteAudioStore {
  const bucket = () => getCloud().storage.from('runtime');
  return {
    async get(path) {
      try {
        const timed = await withTimeout(bucket().download(path), CLOUD_AUDIO_READ_TIMEOUT_MS);
        if (!timed) return null;
        const { data, error } = timed;
        if (error || !data) return null;
        return await data.arrayBuffer();
      } catch {
        return null;
      }
    },
    async put(path, audio, mime) {
      try {
        const { error } = await bucket().upload(path, audio, {
          contentType: mime,
          upsert: true,
          cacheControl: 'public, max-age=31536000',
        });
        return !error;
      } catch {
        return false;
      }
    },
    async remove(path) {
      try {
        const { error } = await bucket().remove([path]);
        return !error;
      } catch {
        return false;
      }
    },
  };
}

/** 内存实现（单测 / 非云环境） */
export function inMemoryAudioStore(initial: Record<string, ArrayBuffer> = {}): RemoteAudioStore & {
  store: Map<string, ArrayBuffer>;
  puts: string[];
} {
  const store = new Map<string, ArrayBuffer>(Object.entries(initial));
  const puts: string[] = [];
  return {
    store,
    puts,
    async get(path) {
      return store.get(path) ?? null;
    },
    async put(path, audio) {
      store.set(path, audio);
      puts.push(path);
      return true;
    },
    async remove(path) {
      return store.delete(path);
    },
  };
}
