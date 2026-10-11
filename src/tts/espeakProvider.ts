/**
 * espeakProvider.ts —— 兜底轨：meSpeak.js（espeak-ng WASM），本地合成、无需联网。
 * 懒加载（dynamic import）→ WASM 不进主包，T05 阶段预缓存。
 * IPA 直读：espeak 引擎可按音素符号朗读；meSpeak 以文本近似处理，音标剥壳后直读，
 * 精确 IPA→phoneme-mnemonic 适配在 T05 集成时按真实输出校准。
 */
import type { TTSProvider, TTSRequest, TTSResult } from './types';

type MeSpeakModule = import('mespeak').MeSpeak;

let cachedModule: MeSpeakModule | null = null;

/** 懒加载 meSpeak WASM + config（失败抛错，由编排器记录并提示） */
export async function loadMespeak(): Promise<MeSpeakModule> {
  if (cachedModule) return cachedModule;
  const mod = ((await import('mespeak')) as unknown as { default: MeSpeakModule }).default;
  const config = (await import('mespeak/src/mespeak_config.json')).default;
  mod.loadConfig(config);
  cachedModule = mod;
  return mod;
}

/** meSpeak 返回值统一转 ArrayBuffer（可能是 ArrayBuffer/Uint8Array/base64 或 mime 字符串） */
export function toArrayBuffer(result: ArrayBuffer | Uint8Array | string | boolean): ArrayBuffer {
  if (result instanceof ArrayBuffer) return result;
  if (typeof result === 'boolean' || result == null) {
    throw new Error('meSpeak returned no audio data');
  }
  if (typeof result === 'string') {
    const b64 = result.includes(',') ? result.split(',')[1] ?? '' : result;
    const bin = atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    return buf;
  }
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
}

export const espeakProvider: TTSProvider = {
  id: 'ipa_espeak',
  async synthesize(req: TTSRequest): Promise<TTSResult> {
    const mod = await loadMespeak();
    // 兜底轨文本：优先单词原文（espeak 内置英文规则），无原文时用音标剥壳近似
    const text =
      req.mode === 'syllable' && req.syllable
        ? req.syllable
        : req.text || (req.ipa ? req.ipa.replace(/\//g, '') : '');
    if (!text) throw new Error('espeak fallback: nothing to speak');
    const raw = mod.speak(text, {
      speed: 160,
      wordgap: req.mode === 'word' ? 2 : 0,
      rawdata: true,
    });
    return { audio: toArrayBuffer(raw), engine: 'ipa_espeak', fromCache: false };
  },
};
