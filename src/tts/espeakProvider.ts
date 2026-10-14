/**
 * espeakProvider.ts —— 兜底轨：meSpeak.js（espeak-ng WASM），本地合成、无需联网。
 * 懒加载（dynamic import）→ WASM 不进主包，T05 阶段预缓存。
 * IPA 直读：espeak 引擎可按音素符号朗读；meSpeak 以文本近似处理，音标剥壳后直读，
 * 精确 IPA→phoneme-mnemonic 适配在 T05 集成时按真实输出校准。
 */
import type { TTSProvider, TTSRequest, TTSResult } from './types';

type MeSpeakModule = import('mespeak').MeSpeak;

let cachedModule: MeSpeakModule | null = null;

/**
 * 语音包候选（按优先级）：mespeak_config.json **只含音素表、不含 voice**，
 * 所以 loadConfig 之后 `defaultVoice` 仍是 ''，而 meSpeak 的 speak() 开头就是
 * `if (!configDataLoaded || !defaultVoice) return null`（rawdata 模式直接返回 null，不入队）。
 * ⇒ 不显式 loadVoice，兜底轨**永远静默无声**（2026-10-13 线上"发不出读音"的根因）。
 */
/**
 * 语音包候选，按优先级排列。用**静态** import（Vite 无法在构建期展开含变量的
 * `mespeak/voices/en/${name}.json`，会整段解析失败）。
 */
const VOICE_LOADERS: (() => Promise<unknown>)[] = [
  async () => (await import('mespeak/voices/en/en-us.json')).default,
  async () => (await import('mespeak/voices/en/en.json')).default,
];

/** 懒加载 meSpeak WASM + config + voice（config/voice 缺一即抛错，由编排器记录并提示） */
export async function loadMespeak(): Promise<MeSpeakModule> {
  if (cachedModule) return cachedModule;
  const mod = ((await import('mespeak')) as unknown as { default: MeSpeakModule }).default;
  const config = (await import('mespeak/src/mespeak_config.json')).default;
  mod.loadConfig(config);
  // config 不带 voice ⇒ 必须自己装；装不上就由下面的就绪检查抛错，而不是静默返回 null
  for (const load of VOICE_LOADERS) {
    try {
      mod.loadVoice(await load());
      if (mod.getDefaultVoice()) break;
    } catch {
      // 换下一个候选
    }
  }
  cachedModule = mod;
  return mod;
}

/** meSpeak 就绪判据：config 与默认语音都装上了才能合成（否则 speak 返回 null） */
export function isMespeakReady(mod: MeSpeakModule): boolean {
  return Boolean(mod.isConfigLoaded?.() && mod.getDefaultVoice?.());
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
    if (!isMespeakReady(mod)) {
      // 不静默返回 null：把"没装好"变成可见的失败，交给上层回落到浏览器内置语音
      throw new Error('espeak fallback: voice/config not loaded');
    }
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
    if (raw == null) throw new Error('espeak fallback: no audio produced');
    return { audio: toArrayBuffer(raw), engine: 'ipa_espeak', fromCache: false };
  },
};
