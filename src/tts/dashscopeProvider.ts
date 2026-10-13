/**
 * dashscopeProvider.ts —— 主轨 DashScope 通道（阿里云百炼 CosyVoice，架构增量 v0.1）。
 *
 * 传输策略（D3/D4）：
 *  - HTTP-SSE 优先：POST SpeechSynthesizer，X-DashScope-SSE: enable，分块 output.audio.data(base64)；
 *  - 仅当 HTTP 失败是网络层错误（fetch TypeError，无 HTTP 响应，典型为 CORS 预检不过）时，
 *    当次内尝试 WebSocket 直连一次；WS 成功 → 内存偏好切 'ws'（不持久化）；
 *  - HTTP 4xx/5xx（有响应）不翻转、直接抛错（编排器走 espeak 兜底）。
 *
 * 端点/参数口径（D1）：请求体参数全在 input 下（text/voice/format/sample_rate/enable_ssml/
 * language_hints/rate/volume/pitch）；模型走顶层 model 字段。非流式返回的 output.audio.url
 * 是 http:// OSS 地址（HTTPS 页面混合内容拦截），不做二次 fetch（D2）。
 *
 * WS 协议（官方 demo 实证）：run-task → task-started → continue-task（SSML 全文，仅一次）
 * → finish-task → binary mp3 帧拼接 → task-finished；task-failed 读 header.error_message 抛错。
 * 每次合成独立连接、收尾即关（单用户低频，P2 可加连接池）。
 * 安全注记：key 出现在 WS URL query（官方 demo 同款做法；基线 §8 #2 已声明的密钥例外不扩大暴露面）。
 */
import {
  DASHSCOPE_DEFAULT_ENDPOINT,
  DASHSCOPE_DEFAULT_MODEL,
  DASHSCOPE_DEFAULT_VOICE,
  DASHSCOPE_LANGUAGE_HINTS,
  DASHSCOPE_OUTPUT_FORMAT,
  DASHSCOPE_SAMPLE_RATE,
  DASHSCOPE_WS_ENDPOINT,
  TTS_REQUEST_TIMEOUT_MS,
} from '../config/constants';
import { buildSsml } from './ssml';
import { fetchWithTimeout } from './httpFetch';
import type { TTSContext, TTSRequest, TTSResult } from './types';

/** DashScope 非流式/SSE 响应信封（官方文档形态） */
export interface DashScopeTtsResponse {
  request_id: string;
  output: {
    finish_reason: string | null; // 'stop' = 合成结束
    type?: string; // SSE：'sentence-begin' | 'sentence-synthesis' | 'sentence-end'
    audio: { data: string; url: string; id: string; expires_at: number }; // SSE 分块在 data(base64)；非流式在 url
  };
  usage?: { characters: number }; // 计费字符数（P1-1 口径）
}

/**
 * WS URL 派生：endpoint 主机含 '.maas.aliyuncs.com'（Workspace 专属域名）→
 * 'wss://{host}/api-ws/v1/inference/'；否则用通用常量。api_key 由调用方拼 query。
 */
export function dashScopeWsUrl(endpoint: string): string {
  try {
    const host = new URL(endpoint).host;
    if (host.endsWith('.maas.aliyuncs.com')) {
      return `wss://${host}/api-ws/v1/inference/`;
    }
  } catch {
    // endpoint 不可解析 → 回落通用常量
  }
  return DASHSCOPE_WS_ENDPOINT;
}

// ===== 传输偏好（仅内存、不持久化；rebuild 不影响，默认 http）=====

let transportPreference: 'http' | 'ws' = 'http';

/** 测试注入点：传输偏好查询 */
export function currentTransport(): 'http' | 'ws' {
  return transportPreference;
}

/** 测试注入点：传输偏好重置（恢复默认 http） */
export function resetTransport(): void {
  transportPreference = 'http';
}

// ===== 入口 =====

/**
 * 合成入口（neuralProvider 的 dashscope 分支调用）。
 * 超时由内部按 TTS_REQUEST_TIMEOUT_MS 自控（HTTP 走 fetchWithTimeout；WS 用 deadline 竞速）。
 */
export async function synthesizeDashScope(req: TTSRequest, ctx: TTSContext): Promise<TTSResult> {
  if (!ctx.apiKey) {
    throw new Error('DashScope TTS API key is not loaded (cloud config pending_user_setup or empty)');
  }
  if (transportPreference === 'ws') {
    return synthesizeViaWebSocket(req, ctx);
  }
  try {
    return await synthesizeViaHttp(req, ctx);
  } catch (err) {
    // D4：仅网络层错误（无 HTTP 响应）当次尝试 WS 一次；4xx/5xx 直接抛
    if (!(err instanceof TypeError)) throw err;
    const result = await synthesizeViaWebSocket(req, ctx);
    transportPreference = 'ws';
    return result;
  }
}

// ===== HTTP-SSE 通道 =====

/** 请求体（参数全在 input 下；model 顶层） */
function buildRequestBody(ssml: string, ctx: TTSContext): Record<string, unknown> {
  return {
    model: ctx.config.model ?? DASHSCOPE_DEFAULT_MODEL,
    input: {
      text: ssml,
      voice: ctx.config.voice ?? DASHSCOPE_DEFAULT_VOICE,
      format: DASHSCOPE_OUTPUT_FORMAT,
      sample_rate: DASHSCOPE_SAMPLE_RATE,
      enable_ssml: true,
      language_hints: [...DASHSCOPE_LANGUAGE_HINTS],
      rate: 1.0,
      volume: 50,
      pitch: 1.0,
    },
  };
}

/** 音素来源：word 模式且 CMUdict 命中 → 'cmu'；其余（纯文本降级/例句/逐词/音节）→ 'text' */
function phonemeSourceOf(req: TTSRequest): TTSResult['phonemeSource'] {
  return req.mode === 'word' && req.arpabet ? 'cmu' : 'text';
}

async function synthesizeViaHttp(req: TTSRequest, ctx: TTSContext): Promise<TTSResult> {
  const endpoint = ctx.config.endpoint?.trim() || DASHSCOPE_DEFAULT_ENDPOINT;
  const ssml = buildSsml(req, 'dashscope');
  const res = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.apiKey ?? ''}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': 'enable',
      },
      body: JSON.stringify(buildRequestBody(ssml, ctx)),
    },
    TTS_REQUEST_TIMEOUT_MS,
    ctx.signal,
  );
  if (!res.ok) throw new Error(`DashScope TTS HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') ?? '';
  const { audio, usageChars } = contentType.includes('text/event-stream')
    ? await readSseAudio(res)
    : await readJsonAudio(res);
  return {
    audio,
    engine: 'neural_tts',
    fromCache: false,
    ssml,
    phonemeSource: phonemeSourceOf(req),
    ...(usageChars != null ? { usageChars } : {}),
  };
}

/** base64 → bytes（浏览器 atob / Node atob 均可） */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 拼接音频分块为单一 ArrayBuffer */
function concatBytes(chunks: Uint8Array[]): ArrayBuffer {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

/** 解析单条 SSE 事件（'data:' 行 → JSON 信封） */
function parseSseEvent(rawEvent: string): { data?: string; usage?: number } | null {
  const dataLines = rawEvent
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) return null;
  const payload = JSON.parse(dataLines.join('\n')) as Partial<DashScopeTtsResponse> & {
    code?: string;
    message?: string;
  };
  // SSE 内的错误信封（官方错误形态 {code, message}）→ 抛错走兜底
  if (payload.code && payload.message) {
    throw new Error(`DashScope TTS SSE error ${payload.code}: ${payload.message}`);
  }
  const data = payload.output?.audio?.data;
  const usage = payload.usage?.characters;
  return {
    ...(data ? { data } : {}),
    ...(typeof usage === 'number' ? { usage } : {}),
  };
}

/** SSE 流式读取：分块 output.audio.data(base64) 依序拼接 + usage.characters */
async function readSseAudio(res: Response): Promise<{ audio: ArrayBuffer; usageChars?: number }> {
  const body = res.body;
  if (!body) throw new Error('DashScope TTS SSE response has no body stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let usageChars: number | undefined;
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const parsed = parseSseEvent(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (parsed) {
          if (parsed.data) chunks.push(base64ToBytes(parsed.data));
          if (parsed.usage != null) usageChars = parsed.usage;
        }
        sep = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { audio: concatBytes(chunks), ...(usageChars != null ? { usageChars } : {}) };
}

/** 非流式 JSON 兜底解析（无 SSE content-type 时）：只认 inline data；url 不做二次 fetch（D2 混合内容） */
async function readJsonAudio(res: Response): Promise<{ audio: ArrayBuffer; usageChars?: number }> {
  const payload = (await res.json()) as DashScopeTtsResponse;
  const data = payload?.output?.audio?.data;
  if (data) {
    return {
      audio: base64ToBytes(data).buffer as ArrayBuffer,
      ...(payload.usage?.characters != null ? { usageChars: payload.usage.characters } : {}),
    };
  }
  if (payload?.output?.audio?.url) {
    throw new Error('DashScope TTS returned a non-streaming audio URL (http OSS blocked by mixed content); SSE stream was expected');
  }
  throw new Error('DashScope TTS response contains no audio data');
}

// ===== WebSocket 降级通道 =====

/** WS 事件（最小结构；浏览器/Node 全局 WebSocket 均满足） */
interface WsEventLike {
  data?: unknown;
}

interface WebSocketLike {
  send(data: string | ArrayBuffer): void;
  close(): void;
  binaryType?: 'blob' | 'arraybuffer';
  addEventListener(type: string, listener: (event: WsEventLike) => void): void;
}

/** 运行时取全局 WebSocket（测试可 stubGlobal 注入 mock） */
function createWebSocket(url: string): WebSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!ctor) throw new Error('DashScope WS: WebSocket is unavailable in this environment');
  const sock = new ctor(url);
  if ('binaryType' in sock) sock.binaryType = 'arraybuffer'; // binary 帧按 ArrayBuffer 收
  return sock;
}

/** task_id：crypto.randomUUID()，不可用时退化为 getRandomValues 手写 v4 */
function newTaskId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** binary 帧 → Uint8Array（binaryType=arraybuffer 下为 ArrayBuffer） */
function toUint8(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

async function synthesizeViaWebSocket(req: TTSRequest, ctx: TTSContext): Promise<TTSResult> {
  const apiKey = ctx.apiKey ?? '';
  const url = `${dashScopeWsUrl(ctx.config.endpoint ?? DASHSCOPE_DEFAULT_ENDPOINT)}?api_key=${encodeURIComponent(apiKey)}`;
  const ssml = buildSsml(req, 'dashscope');
  const taskId = newTaskId();
  const model = ctx.config.model ?? DASHSCOPE_DEFAULT_MODEL;
  const voice = ctx.config.voice ?? DASHSCOPE_DEFAULT_VOICE;
  const phonemeSource = phonemeSourceOf(req);

  return new Promise<TTSResult>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    const timer = setTimeout(() => finishWithError(new Error('DashScope WS timeout')), TTS_REQUEST_TIMEOUT_MS);

    const finishWithError = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.close();
      } catch {
        // 关闭失败不影响错误路径
      }
      reject(err);
    };
    const finishWithAudio = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.close();
      } catch {
        // 关闭失败不影响成功路径
      }
      resolve({
        audio: concatBytes(chunks),
        engine: 'neural_tts',
        fromCache: false,
        ssml,
        phonemeSource,
      });
    };

    let sock: WebSocketLike;
    try {
      sock = createWebSocket(url);
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    ctx.signal?.addEventListener('abort', () => finishWithError(new Error('DashScope WS aborted')));

    sock.addEventListener('open', () => {
      sock.send(
        JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'tts',
            function: 'SpeechSynthesizer',
            model,
            parameters: {
              text_type: 'PlainText',
              voice,
              format: DASHSCOPE_OUTPUT_FORMAT,
              sample_rate: DASHSCOPE_SAMPLE_RATE,
              volume: 50,
              rate: 1.0,
              pitch: 1.0,
              enable_ssml: true,
              language_hints: [...DASHSCOPE_LANGUAGE_HINTS],
            },
            input: {},
          },
        }),
      );
    });

    sock.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data !== 'string') {
        // binary 帧 = mp3 音频分块，按序拼接
        const bytes = toUint8(data);
        if (bytes) chunks.push(bytes);
        return;
      }
      let msg: { header?: { event?: string; error_message?: string } };
      try {
        msg = JSON.parse(data) as { header?: { event?: string; error_message?: string } };
      } catch {
        return; // 非 JSON 文本帧忽略
      }
      const eventName = msg.header?.event;
      if (eventName === 'task-started') {
        // SSML 模式只允许一次 continue-task：发完 SSML 全文立即 finish-task
        sock.send(
          JSON.stringify({
            header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
            payload: { input: { text: ssml } },
          }),
        );
        sock.send(
          JSON.stringify({
            header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
            payload: { input: {} },
          }),
        );
      } else if (eventName === 'task-finished') {
        finishWithAudio();
      } else if (eventName === 'task-failed') {
        finishWithError(new Error(`DashScope WS task failed: ${msg.header?.error_message ?? 'unknown error'}`));
      }
    });

    sock.addEventListener('error', () => finishWithError(new Error('DashScope WS connection error')));
    sock.addEventListener('close', () => finishWithError(new Error('DashScope WS closed before task-finished')));
  });
}
