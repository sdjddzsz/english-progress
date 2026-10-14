/**
 * dashscope.test.ts —— T5 单测：DashScope 通道（HTTP-SSE / WS 降级 / 传输翻转）+ cacheKey arpabet + 编排器透传。
 * 覆盖（架构增量 §8）：
 *  - SSE 分块拼接 + usage.characters 解析；
 *  - 非流式 JSON 兜底（inline data / 仅 url 抛错）；
 *  - WS 协议 mock（run-task → task-started → continue-task×1 → finish-task → binary 拼接 → task-finished）；
 *  - task-failed 抛错；
 *  - 传输翻转三态（http→ws / HTTP 401 不翻转 / ws 偏好直连）；
 *  - cacheKey 纳入 arpabet（同词不同 arpabet key 不同；长度前缀无碰撞）；
 *  - 编排器 mock neural（dashscope 配置）→ log 带 phonemeSource/chars。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentTransport,
  dashScopeWsUrl,
  resetTransport,
  synthesizeDashScope,
} from '../../src/tts/dashscopeProvider';
import { cacheKey, createOrchestrator, inMemoryAudioCache, type OrchestratorDeps, type PronunciationLogEntry } from '../../src/tts/orchestrator';
import { DASHSCOPE_DEFAULT_ENDPOINT, DASHSCOPE_DEFAULT_MODEL, DASHSCOPE_DEFAULT_VOICE, DASHSCOPE_WS_ENDPOINT } from '../../src/config/constants';
import type { TTSContext, TTSRequest } from '../../src/tts/types';
import type { TTSProviderConfig } from '../../src/types/domain';

// ===== 基础设施 =====

function dashscopeCfg(over: Partial<TTSProviderConfig> = {}): TTSProviderConfig {
  return {
    id: 'c-ds',
    userId: 'u1',
    provider: 'dashscope',
    endpoint: DASHSCOPE_DEFAULT_ENDPOINT,
    ssmlPhonemeEnabled: true,
    status: 'active',
    fallbackEngine: 'ipa_espeak',
    ...over,
  };
}

function ctx(over: Partial<TTSContext> = {}): TTSContext {
  return { config: dashscopeCfg(), apiKey: 'sk-test', ...over };
}

const wordReq: TTSRequest = { text: 'academy', ipa: '/əˈkæd.ə.mi/', arpabet: 'AH0 K AE1 D AH0 M IY0', mode: 'word' };

/** 伪造 Response（仅实现被测代码用到的表面） */
function mockResponse(init: {
  status?: number;
  contentType: string;
  body?: ReadableStream<Uint8Array> | null;
  json?: unknown;
}): Response {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? init.contentType : null) },
    body: init.body ?? null,
    json: async () => init.json,
  } as unknown as Response;
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function b64(s: string): string {
  return btoa(s);
}

/** 脚本化 Mock WebSocket：open → run-task → task-started →（客户端 continue/finish）→ binary → task-finished */
class MockDashScopeWebSocket {
  static instances: MockDashScopeWebSocket[] = [];
  static script: ((ws: MockDashScopeWebSocket) => void) | null = null;

  url: string;
  sent: string[] = [];
  binary: Uint8Array[] = [];
  closed = false;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  private listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  constructor(url: string) {
    this.url = url;
    MockDashScopeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open', {}));
  }

  addEventListener(type: string, cb: (event: { data?: unknown }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  removeEventListener(type: string, cb: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') {
      this.binary.push(new Uint8Array(data));
      return;
    }
    this.sent.push(data);
    const msg = JSON.parse(data) as { header?: { action?: string; task_id?: string } };
    if (msg.header?.action === 'run-task') {
      queueMicrotask(() => {
        this.emit('message', { data: JSON.stringify({ header: { event: 'task-started', task_id: msg.header?.task_id } }) });
        MockDashScopeWebSocket.script?.(this);
      });
    }
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }

  emitBinary(text: string): void {
    const bytes = new TextEncoder().encode(text);
    this.emit('message', { data: bytes.buffer });
  }

  emitJson(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }
}

function lastSentAction(ws: MockDashScopeWebSocket, action: string): Record<string, never> | null {
  for (const raw of [...ws.sent].reverse()) {
    const msg = JSON.parse(raw) as { header?: { action?: string } };
    if (msg.header?.action === action) return msg as unknown as Record<string, never>;
  }
  return null;
}

beforeEach(() => {
  resetTransport();
  MockDashScopeWebSocket.instances = [];
  MockDashScopeWebSocket.script = null;
  vi.unstubAllGlobals();
});

// ===== WS URL 派生 =====

describe('dashScopeWsUrl', () => {
  it('通用域名端点 → 通用 WS 常量', () => {
    expect(dashScopeWsUrl(DASHSCOPE_DEFAULT_ENDPOINT)).toBe(DASHSCOPE_WS_ENDPOINT);
  });

  it('Workspace 专属域名（.maas.aliyuncs.com）→ 同主机 api-ws 路径', () => {
    expect(dashScopeWsUrl('https://ws-123.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer')).toBe(
      'wss://ws-123.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference/',
    );
  });

  it('不可解析端点 → 回落通用常量', () => {
    expect(dashScopeWsUrl('not-a-url')).toBe(DASHSCOPE_WS_ENDPOINT);
  });
});

// ===== HTTP-SSE 通道 =====

describe('synthesizeDashScope：HTTP-SSE', () => {
  it('SSE 分块 base64 依序拼接 + usage.characters + phonemeSource=cmu', async () => {
    const chunks = [
      sseEvent({ request_id: 'r1', output: { type: 'sentence-begin', finish_reason: null, audio: { data: '', url: '', id: '1', expires_at: 0 } } }),
      sseEvent({ request_id: 'r1', output: { type: 'sentence-synthesis', finish_reason: null, audio: { data: b64('AB'), url: '', id: '2', expires_at: 0 } } }),
      sseEvent({ request_id: 'r1', output: { type: 'sentence-synthesis', finish_reason: null, audio: { data: b64('CD'), url: '', id: '3', expires_at: 0 } } }),
      sseEvent({ request_id: 'r1', output: { finish_reason: 'stop', type: 'sentence-end', audio: { data: '', url: '', id: '4', expires_at: 0 } }, usage: { characters: 12 } }),
    ];
    const fetchMock = vi.fn(async () =>
      mockResponse({ contentType: 'text/event-stream', body: streamOf(chunks) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await synthesizeDashScope(wordReq, ctx());
    expect(new TextDecoder().decode(new Uint8Array(r.audio))).toBe('ABCD');
    expect(r.engine).toBe('neural_tts');
    expect(r.fromCache).toBe(false);
    expect(r.usageChars).toBe(12);
    expect(r.phonemeSource).toBe('cmu');
    expect(r.ssml).toBe('<speak><phoneme alphabet="cmu" ph="AH0 K AE1 D AH0 M IY0">academy</phoneme></speak>');

    // 请求形态：端点 / 头 / body（参数全在 input 下）
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DASHSCOPE_DEFAULT_ENDPOINT);
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(headers['X-DashScope-SSE']).toBe('enable');
    const body = JSON.parse(String(init.body)) as { model: string; input: Record<string, unknown> };
    expect(body.model).toBe(DASHSCOPE_DEFAULT_MODEL);
    expect(body.input.enable_ssml).toBe(true);
    expect(body.input.voice).toBe(DASHSCOPE_DEFAULT_VOICE);
    expect(body.input.format).toBe('mp3');
    expect(body.input.language_hints).toEqual(['en']);
    expect(body.input.text).toContain('alphabet="cmu"');
    expect(currentTransport()).toBe('http'); // SSE 成功不翻转
  });

  it('分块跨 TCP 边界（半包）仍能正确重组', async () => {
    const full =
      sseEvent({ request_id: 'r', output: { type: 'sentence-synthesis', audio: { data: b64('HE'), url: '', id: '1', expires_at: 0 } } }) +
      sseEvent({ request_id: 'r', output: { finish_reason: 'stop', audio: { data: '', url: '', id: '2', expires_at: 0 } }, usage: { characters: 5 } });
    const mid = Math.floor(full.length / 2);
    const fetchMock = vi.fn(async () => mockResponse({ contentType: 'text/event-stream', body: streamOf([full.slice(0, mid), full.slice(mid)]) }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await synthesizeDashScope(wordReq, ctx());
    expect(new TextDecoder().decode(new Uint8Array(r.audio))).toBe('HE');
    expect(r.usageChars).toBe(5);
  });

  it('无 arpabet（CMUdict 未命中）→ phonemeSource=text 且 SSML 为纯文本', async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({
        contentType: 'text/event-stream',
        body: streamOf([sseEvent({ request_id: 'r', output: { finish_reason: 'stop', audio: { data: b64('ZZ'), url: '', id: '1', expires_at: 0 } } })]),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await synthesizeDashScope({ text: 'academy', mode: 'word' }, ctx());
    expect(r.phonemeSource).toBe('text');
    expect(r.ssml).toBe('<speak>academy</speak>');
  });

  it('config.model / config.voice 覆盖默认值', async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({ contentType: 'text/event-stream', body: streamOf([sseEvent({ request_id: 'r', output: { finish_reason: 'stop', audio: { data: b64('A'), url: '', id: '1', expires_at: 0 } } })]) }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeDashScope(wordReq, ctx({ config: dashscopeCfg({ model: 'cosyvoice-v3-flash', voice: 'longwan_v2' }) }));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      model: string;
      input: { voice: string };
    };
    expect(body.model).toBe('cosyvoice-v3-flash');
    expect(body.input.voice).toBe('longwan_v2');
  });
});

// ===== HTTP 非流式兜底 =====

describe('synthesizeDashScope：非流式 JSON 兜底', () => {
  it('inline data → 直接解码，不二次 fetch URL', async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({
        contentType: 'application/json',
        json: { request_id: 'r', output: { finish_reason: 'stop', audio: { data: b64('XY'), url: 'http://oss.example/x.mp3', id: '1', expires_at: 0 } }, usage: { characters: 3 } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await synthesizeDashScope(wordReq, ctx());
    expect(new TextDecoder().decode(new Uint8Array(r.audio))).toBe('XY');
    expect(r.usageChars).toBe(3);
    expect(fetchMock).toHaveBeenCalledOnce(); // 没有对 OSS URL 的二次请求
  });

  it('仅返回 http:// OSS URL（无 inline data）→ 抛错（混合内容不做二次 fetch，D2）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      mockResponse({
        contentType: 'application/json',
        json: { request_id: 'r', output: { finish_reason: 'stop', audio: { data: '', url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/x.mp3', id: '1', expires_at: 0 } } },
      }),
    ));
    await expect(synthesizeDashScope(wordReq, ctx())).rejects.toThrow(/non-streaming audio URL|no audio data/);
  });

  it('HTTP 401 → 抛错且不翻转传输偏好（不白绕 WS）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ status: 401, contentType: 'application/json', json: { code: 'InvalidApiKey', message: 'bad key' } })));
    vi.stubGlobal('WebSocket', MockDashScopeWebSocket);
    await expect(synthesizeDashScope(wordReq, ctx())).rejects.toThrow('DashScope TTS HTTP 401');
    expect(MockDashScopeWebSocket.instances).toHaveLength(0);
    expect(currentTransport()).toBe('http');
  });
});

// ===== WebSocket 通道 =====

describe('synthesizeDashScope：WebSocket 协议', () => {
  // 默认传输偏好是 http（D4）：必须先让 HTTP 抛「网络层 TypeError」（CORS 预检失败语义），
  // 才会进入 WS 降级通道——否则真实 fetch 会打到 DashScope 得到 401（有响应 → 不翻转、不进 WS）。
  // 这样在隔离环境里直接验证 WS 协议本身，而不是验证「HTTP 优先」。
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
  });

  it('run-task → task-started → continue-task×1（SSML 全文）→ finish-task → binary 拼接 → task-finished', async () => {
    vi.stubGlobal('WebSocket', MockDashScopeWebSocket);
    MockDashScopeWebSocket.script = (ws) => {
      ws.emitBinary('MP');
      ws.emitBinary('3!');
      ws.emitJson({ header: { event: 'task-finished', task_id: 't' } });
    };
    const r = await synthesizeDashScope(wordReq, ctx());
    expect(new TextDecoder().decode(new Uint8Array(r.audio))).toBe('MP3!');
    expect(r.phonemeSource).toBe('cmu');
    const ws = MockDashScopeWebSocket.instances[0];
    // URL：WS 端点 + api_key query
    expect(ws.url.startsWith(`${DASHSCOPE_WS_ENDPOINT}?api_key=`)).toBe(true);
    expect(ws.url).toContain('sk-test');
    // run-task 参数
    const runTask = lastSentAction(ws, 'run-task') as unknown as { payload: { model: string; parameters: Record<string, unknown> } };
    expect(runTask.payload.model).toBe(DASHSCOPE_DEFAULT_MODEL);
    expect(runTask.payload.parameters.enable_ssml).toBe(true);
    expect(runTask.payload.parameters.voice).toBe(DASHSCOPE_DEFAULT_VOICE);
    expect(runTask.payload.parameters.format).toBe('mp3');
    // continue-task 恰好一次且携带 SSML 全文
    const continues = ws.sent.filter((raw) => (JSON.parse(raw) as { header?: { action?: string } }).header?.action === 'continue-task');
    expect(continues).toHaveLength(1);
    const cont = JSON.parse(continues[0]) as { payload: { input: { text: string } } };
    expect(cont.payload.input.text).toBe('<speak><phoneme alphabet="cmu" ph="AH0 K AE1 D AH0 M IY0">academy</phoneme></speak>');
    // finish-task 恰好一次
    expect(ws.sent.filter((raw) => (JSON.parse(raw) as { header?: { action?: string } }).header?.action === 'finish-task')).toHaveLength(1);
    expect(ws.closed).toBe(true);
  });

  it('task-failed → 读 header.error_message 抛错', async () => {
    vi.stubGlobal('WebSocket', MockDashScopeWebSocket);
    MockDashScopeWebSocket.script = (ws) => ws.emitJson({ header: { event: 'task-failed', error_message: 'quota exceeded' } });
    await expect(synthesizeDashScope(wordReq, ctx())).rejects.toThrow('DashScope WS task failed: quota exceeded');
  });

  it('WS 连接未到 task-finished 即 close → 抛错', async () => {
    vi.stubGlobal('WebSocket', MockDashScopeWebSocket);
    MockDashScopeWebSocket.script = (ws) => ws.emit('close', {});
    await expect(synthesizeDashScope(wordReq, ctx())).rejects.toThrow(/closed before task-finished/);
  });
});

// ===== 传输翻转三态（D4）=====

describe('synthesizeDashScope：传输偏好翻转', () => {
  it('HTTP 网络层 TypeError（CORS/预检）→ 当次尝试 WS 成功 → 偏好切 ws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    vi.stubGlobal('WebSocket', MockDashScopeWebSocket);
    MockDashScopeWebSocket.script = (ws) => {
      ws.emitBinary('OK');
      ws.emitJson({ header: { event: 'task-finished', task_id: 't' } });
    };
    const r = await synthesizeDashScope(wordReq, ctx());
    expect(new TextDecoder().decode(new Uint8Array(r.audio))).toBe('OK');
    expect(MockDashScopeWebSocket.instances).toHaveLength(1);
    expect(currentTransport()).toBe('ws');
  });

  it('偏好已为 ws → 直接走 WS，不发 HTTP', async () => {
    // 先造一次翻转
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    vi.stubGlobal('WebSocket', MockDashScopeWebSocket);
    MockDashScopeWebSocket.script = (ws) => ws.emitJson({ header: { event: 'task-finished', task_id: 't' } });
    await synthesizeDashScope(wordReq, ctx());
    expect(currentTransport()).toBe('ws');
    // 第二次：fetch 不再被调用
    const fetchMock = vi.fn(async () => mockResponse({ contentType: 'application/json', json: {} }));
    vi.stubGlobal('fetch', fetchMock);
    MockDashScopeWebSocket.instances = [];
    await synthesizeDashScope(wordReq, ctx());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockDashScopeWebSocket.instances).toHaveLength(1);
  });

  it('resetTransport 恢复默认 http（内存偏好不持久化）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    vi.stubGlobal('WebSocket', MockDashScopeWebSocket);
    MockDashScopeWebSocket.script = (ws) => ws.emitJson({ header: { event: 'task-finished', task_id: 't' } });
    await synthesizeDashScope(wordReq, ctx());
    expect(currentTransport()).toBe('ws');
    resetTransport();
    expect(currentTransport()).toBe('http');
  });
});

// ===== cacheKey：arpabet 纳入 =====

describe('cacheKey：arpabet 进 key（换发音真源必须换缓存）', () => {
  it('同 text 不同 arpabet → key 不同', () => {
    const a: TTSRequest = { text: 'progress', ipa: '/ˈprɒɡres/', arpabet: 'P R AA1 G R EH2 S', mode: 'word' };
    const b: TTSRequest = { text: 'progress', ipa: '/ˈprɒɡres/', arpabet: 'P R AO1 G R EH2 S', mode: 'word' };
    expect(cacheKey(a)).not.toBe(cacheKey(b));
  });

  it('v2 七段长度前缀格式（v2|text|mode|ipa|arpabet|voice|model）', () => {
    // 2026-10-14：v2 把 voice/model 并进 key（原来页面调 speak 从不传 voice，
    // req.voice 恒空 ⇒ 换发音人/换模型后同一个词命中旧音频），并加 v2 前缀
    // 让线上已沉淀的旧格式缓存（含误存的兜底机械音）自然失效。
    const key = cacheKey({ text: 'abandon', mode: 'word', ipa: '/əˈbændən/' });
    expect(key).toBe(`2:v2|7:abandon|4:word|10:/əˈbændən/|0:|0:|0:`);
    const withArpa = cacheKey({ text: 'abandon', mode: 'word', ipa: '/əˈbændən/', arpabet: 'AH0 B AE1 N D AH0 N' });
    // 长度前缀 = 该段实际字符数：'AH0 B AE1 N D AH0 N'.length === 19
    expect(withArpa).toBe(`2:v2|7:abandon|4:word|10:/əˈbændən/|19:AH0 B AE1 N D AH0 N|0:|0:`);
  });

  it('★ 换发音人 / 换模型必须换 key（2026-10-14「所有发音人同一个音」的回归锚点）', () => {
    const base = { text: 'abandon', mode: 'word' } as TTSRequest;
    const v1 = cacheKey(base, 'longanyang', 'cosyvoice-v3-flash');
    const v2 = cacheKey(base, 'longxiaochun', 'cosyvoice-v3-flash');
    const m2 = cacheKey(base, 'longanyang', 'cosyvoice-v2');
    expect(v1).not.toBe(v2); // 换音色 → 换 key
    expect(v1).not.toBe(m2); // 换模型 → 换 key
  });

  it('arpabet 含 "|" 时长度前缀消歧（不与 voice 段串音）', () => {
    const a: TTSRequest = { text: 'x', mode: 'word', arpabet: 'a|b', voice: 'v' };
    const b: TTSRequest = { text: 'x', mode: 'word', arpabet: 'a', voice: 'b|v' };
    expect(cacheKey(a)).not.toBe(cacheKey(b));
  });
});

// ===== 编排器：dashscope 配置下 log 透传 =====

describe('编排器：dashscope 配置 → PronunciationLog 带 phonemeSource/chars', () => {
  it('mock neural 返回 cmu + usageChars → log 原样透传', async () => {
    const logs: PronunciationLogEntry[] = [];
    const deps: OrchestratorDeps = {
      getConfig: async () => ({ config: dashscopeCfg(), apiKey: 'sk-test' }),
      log: async (e) => {
        logs.push(e);
      },
      cache: inMemoryAudioCache(),
      neural: {
        id: 'neural_tts',
        synthesize: async () => ({ audio: new ArrayBuffer(8), engine: 'neural_tts' as const, fromCache: false, phonemeSource: 'cmu' as const, usageChars: 7 }),
      },
      espeak: { id: 'ipa_espeak', synthesize: async () => ({ audio: new ArrayBuffer(4), engine: 'ipa_espeak' as const, fromCache: false }) },
    };
    const orch = createOrchestrator(deps);
    const r = await orch.getAudio(wordReq, 'w-ds');
    expect(r.engine).toBe('neural_tts');
    expect(logs).toEqual([{ engine: 'neural_tts', success: true, fallbackUsed: false, wordId: 'w-ds', chars: 7, phonemeSource: 'cmu' }]);
  });

  it('azure 旧形态结果（无 usageChars/phonemeSource）→ log 不新增键（零回退）', async () => {
    const logs: PronunciationLogEntry[] = [];
    const deps: OrchestratorDeps = {
      getConfig: async () => ({ config: dashscopeCfg({ provider: 'azure' }), apiKey: 'sk-test' }),
      log: async (e) => {
        logs.push(e);
      },
      cache: inMemoryAudioCache(),
      neural: { id: 'neural_tts', synthesize: async () => ({ audio: new ArrayBuffer(8), engine: 'neural_tts' as const, fromCache: false }) },
      espeak: { id: 'ipa_espeak', synthesize: async () => ({ audio: new ArrayBuffer(4), engine: 'ipa_espeak' as const, fromCache: false }) },
    };
    await createOrchestrator(deps).getAudio(wordReq, 'w-az');
    expect(logs).toEqual([{ engine: 'neural_tts', success: true, fallbackUsed: false, wordId: 'w-az' }]);
  });
});
