/**
 * neuralProvider.ts —— 主轨：Azure REST TTS（SSML phoneme/IPA）或 OpenAI 兼容端点。
 * key 从云端配置文档运行时取入内存（ctx.apiKey），不落 localStorage / 代码。
 * 请求超时 TTS_REQUEST_TIMEOUT_MS（3s）→ 由编排器切 espeak 兜底轨。
 */
import { TTS_REQUEST_TIMEOUT_MS } from '../config/constants';
import { buildSsml } from './ssml';
import type { TTSProvider, TTSRequest, TTSResult, TTSContext } from './types';

export const AZURE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/** 带超时的 fetch（AbortController + 外部 signal 合并） */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}

async function synthesizeAzure(req: TTSRequest, ctx: TTSContext): Promise<TTSResult> {
  // Azure endpoint 形如 https://<region>.tts.speech.microsoft.com/cognitiveservices/v1
  const endpoint = ctx.config.endpoint;
  if (!endpoint) throw new Error('Azure TTS endpoint is not configured');
  const ssml = buildSsml({ ...req, voice: ctx.config.voice ?? req.voice });
  const res = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': ctx.apiKey ?? '',
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': AZURE_OUTPUT_FORMAT,
      },
      body: ssml,
    },
    TTS_REQUEST_TIMEOUT_MS,
    ctx.signal,
  );
  if (!res.ok) throw new Error(`Azure TTS HTTP ${res.status}`);
  return { audio: await res.arrayBuffer(), engine: 'neural_tts', fromCache: false, ssml };
}

async function synthesizeOpenAICompatible(req: TTSRequest, ctx: TTSContext): Promise<TTSResult> {
  // OpenAI 兼容通道（含本机网关）：POST {endpoint}/audio/speech。
  // 无 SSML phoneme 能力：音标驱动在该通道降级为文本合成（PronunciationLog 可溯源）。
  const base = (ctx.config.endpoint ?? '').replace(/\/$/, '');
  if (!base) throw new Error('OpenAI-compatible TTS endpoint is not configured');
  const voice = (ctx.config.voice ?? 'alloy').replace(/^en-US-/, '').replace(/Neural$/, '');
  const res = await fetchWithTimeout(
    `${base}/audio/speech`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: 'tts-1', input: req.text, voice, response_format: 'mp3' }),
    },
    TTS_REQUEST_TIMEOUT_MS,
    ctx.signal,
  );
  if (!res.ok) throw new Error(`OpenAI-compatible TTS HTTP ${res.status}`);
  return { audio: await res.arrayBuffer(), engine: 'neural_tts', fromCache: false };
}

export const neuralProvider: TTSProvider = {
  id: 'neural_tts',
  async synthesize(req: TTSRequest, ctx: TTSContext): Promise<TTSResult> {
    if (!ctx.apiKey) {
      throw new Error('TTS API key is not loaded (cloud config pending_user_setup or empty)');
    }
    if (ctx.config.provider === 'azure') return synthesizeAzure(req, ctx);
    return synthesizeOpenAICompatible(req, ctx);
  },
};
