/**
 * qa/ttsAdversarial.test.ts —— QA 独立对抗性验证：TTS 编排（架构 §1.6，硬约束 #7）。
 * - 主轨 3s 超时 → espeak 兜底（真实超时路径，fake timers + abort）；
 * - key 缺失 / 非 active → 兜底；
 * - 缓存键碰撞（voice 含 '|' 或 key 不含 IPA 导致的串音）；
 * - IPA → Azure 音素映射差异字符与不支持字符的降级行为；
 * - 前台轻提示仅一次。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeFallbackNotice,
  createOrchestrator,
  cacheKey,
  inMemoryAudioCache,
  resetFallbackNotice,
  type OrchestratorDeps,
  type PronunciationLogEntry,
} from '../../src/tts/orchestrator';
import { AZURE_OUTPUT_FORMAT } from '../../src/tts/neuralProvider';
import { buildSsml, escapeXml } from '../../src/tts/ssml';
import { mapIpaToAzure, stripIpaSlashes } from '../../src/tts/ipaMap';
import { TTS_REQUEST_TIMEOUT_MS } from '../../src/config/constants';
import type { TTSProvider, TTSRequest, TTSResult, TTSContext } from '../../src/tts/types';
import type { TTSProviderConfig } from '../../src/types/domain';

const AUDIO_A = new ArrayBuffer(8);
const AUDIO_B = new ArrayBuffer(16);

function mkNeural(result?: TTSResult, err?: Error): TTSProvider {
  return {
    id: 'neural_tts',
    synthesize: vi.fn(async (): Promise<TTSResult> => {
      if (err) throw err;
      return result ?? { audio: AUDIO_A, engine: 'neural_tts' as const, fromCache: false };
    }),
  };
}
function mkEspeak(): TTSProvider {
  return {
    id: 'ipa_espeak',
    synthesize: vi.fn(async (): Promise<TTSResult> => ({ audio: AUDIO_B, engine: 'ipa_espeak' as const, fromCache: false })),
  };
}
function activeCfg(): { config: TTSProviderConfig; apiKey?: string } {
  return {
    config: {
      id: 'c1',
      userId: 'u1',
      provider: 'azure',
      endpoint: 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1',
      status: 'active',
      createdAt: '2026-10-11T00:00:00Z',
    } as unknown as TTSProviderConfig,
    apiKey: 'sk-test',
  };
}
function mkDeps(over: Partial<OrchestratorDeps> = {}) {
  const logs: PronunciationLogEntry[] = [];
  const deps: OrchestratorDeps = {
    getConfig: vi.fn(async () => activeCfg()),
    log: vi.fn(async (e: PronunciationLogEntry) => {
      logs.push(e);
    }),
    cache: inMemoryAudioCache(),
    neural: mkNeural(),
    espeak: mkEspeak(),
    ...over,
  };
  return { deps, logs };
}
const wordReq: TTSRequest = { text: 'abandon', mode: 'word', ipa: '/əˈbændən/' };

describe('TTS 编排：主轨失败与超时', () => {
  beforeEach(() => resetFallbackNotice());

  it('主轨抛错（HTTP 401 等）→ espeak 兜底 + 记录 fallbackUsed + 轻提示置位一次', async () => {
    const { deps, logs } = mkDeps({ neural: mkNeural(undefined, new Error('Azure TTS HTTP 401')) });
    const orch = createOrchestrator(deps);
    const r = await orch.getAudio(wordReq, 'w1');
    expect(r.engine).toBe('ipa_espeak');
    expect(r.fromCache).toBe(false);
    expect(logs[0]).toMatchObject({ engine: 'ipa_espeak', fallbackUsed: true, success: true });
    expect(logs[0].error).toContain('401');
    expect(consumeFallbackNotice()).toBe(true);
    expect(consumeFallbackNotice()).toBe(false); // 仅一次
    // ★ 兜底音频**绝不入缓存**（2026-10-14 修复）：
    // 主轨失败多半是瞬时的（网络/CORS/密钥未注入），缓存了机械音后，
    // 即使主轨恢复，同一个词也永远命中它 —— 用户「手机一直机械音、刷新也没用」。
    const again = await orch.getAudio(wordReq, 'w1');
    expect(again.fromCache).toBe(false); // 不命中缓存
    expect(again.engine).toBe('ipa_espeak'); // 重新走兜底合成
  });

  it('主轨真实超时（>3s 不返回）→ abort → espeak 兜底', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: unknown, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal!.addEventListener('abort', () => rej(new Error('The operation was aborted')));
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      // 不注入 neural mock：走真实 neuralProvider 的 fetchWithTimeout 超时路径
      const { deps, logs } = mkDeps({ neural: undefined });
      const orch = createOrchestrator(deps);
      const p = orch.getAudio(wordReq);
      await vi.advanceTimersByTimeAsync(TTS_REQUEST_TIMEOUT_MS + 10);
      const r = await p;
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(r.engine).toBe('ipa_espeak');
      expect(logs[0]?.fallbackUsed).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('主轨在超时内正常返回：不触发兜底，缓存存 neural 音频', async () => {
    const { deps, logs } = mkDeps();
    const orch = createOrchestrator(deps);
    const r = await orch.getAudio(wordReq);
    expect(r.engine).toBe('neural_tts');
    expect(r.fromCache).toBe(false);
    expect(logs[0]).toMatchObject({ engine: 'neural_tts', success: true, fallbackUsed: false });
    expect((deps.neural as TTSProvider).synthesize).toHaveBeenCalledOnce();
    expect((deps.espeak as TTSProvider).synthesize).not.toHaveBeenCalled();
  });
});

describe('TTS 编排：配置缺失与降级', () => {
  beforeEach(() => resetFallbackNotice());

  it('key 缺失（getConfig 返回 active 但无 apiKey）→ 兜底，不调主轨', async () => {
    const { deps, logs } = mkDeps({ getConfig: vi.fn(async () => ({ ...activeCfg(), apiKey: undefined })) });
    const r = await createOrchestrator(deps).getAudio(wordReq);
    expect(r.engine).toBe('ipa_espeak');
    expect((deps.neural as TTSProvider).synthesize).not.toHaveBeenCalled();
    expect(logs[0]?.fallbackUsed).toBe(true);
  });

  it('status=pending_user_setup（硬约束 #7 默认态）→ 兜底', async () => {
    const cfg = { ...activeCfg(), config: { ...activeCfg().config, status: 'pending_user_setup' } as TTSProviderConfig };
    const { deps } = mkDeps({ getConfig: vi.fn(async () => cfg) });
    const r = await createOrchestrator(deps).getAudio(wordReq);
    expect(r.engine).toBe('ipa_espeak');
  });

  it('getConfig 返回 null（云端配置不可达）→ 兜底不抛异常', async () => {
    const { deps } = mkDeps({ getConfig: vi.fn(async () => null) });
    const r = await createOrchestrator(deps).getAudio(wordReq);
    expect(r.engine).toBe('ipa_espeak');
  });
});

describe('回归锚点：缓存键含 IPA 且长度前缀无歧义（P2-2 修复，ed2e8dd）', () => {
  it('① 同词改音标后：cacheKey 必不相等、fromCache=false、返回新合成音频', async () => {
    // 修前快照：两请求同 key → 返回陈旧音频（P2-2 实证）。修复语义与"碰撞成立"不可兼得，反转为回归断言。
    let call = 0;
    const neural = mkNeural({ audio: AUDIO_A, engine: 'neural_tts', fromCache: false });
    neural.synthesize = vi.fn(async (): Promise<TTSResult> => {
      call += 1;
      return call === 1 ? { audio: AUDIO_A, engine: 'neural_tts', fromCache: false } : { audio: AUDIO_B, engine: 'neural_tts', fromCache: false };
    });
    const { deps } = mkDeps({ neural });
    const orch = createOrchestrator(deps);
    await orch.getAudio({ text: 'abandon', mode: 'word', ipa: '/əˈbændən/' });
    const r2 = await orch.getAudio({ text: 'abandon', mode: 'word', ipa: '/əˈbændɒn/' }); // 音标已修正
    expect(cacheKey({ text: 'abandon', mode: 'word', ipa: '/əˈbændən/' })).not.toBe(
      cacheKey({ text: 'abandon', mode: 'word', ipa: '/əˈbændɒn/' }),
    );
    expect(r2.fromCache).toBe(false); // 不再命中旧音频
    expect(r2.audio).toBe(AUDIO_B); // 返回按新音标重新合成的音频
  });

  it('② voice 含 "|" 不再与 text 串音：旧碰撞对现在 key 不同、第二次请求重新合成', async () => {
    const a: TTSRequest = { text: 'x', mode: 'word', voice: 'word|v' };
    const b: TTSRequest = { text: 'x|word', mode: 'word', voice: 'v' };
    expect(a.text).not.toBe(b.text);
    expect(cacheKey(a)).not.toBe(cacheKey(b)); // 长度前缀消歧后旧碰撞对失效
    let call = 0;
    const neural = mkNeural();
    neural.synthesize = vi.fn(async (): Promise<TTSResult> => {
      call += 1;
      return call === 1 ? { audio: AUDIO_A, engine: 'neural_tts', fromCache: false } : { audio: AUDIO_B, engine: 'neural_tts', fromCache: false };
    });
    const { deps } = mkDeps({ neural });
    const orch = createOrchestrator(deps);
    const first = await orch.getAudio(a);
    const second = await orch.getAudio(b);
    expect(second.fromCache).toBe(false);
    expect(second.audio).not.toBe(first.audio); // 不串音
  });

  it('③ 新 key 为长度前缀格式，形如 2:v2|7:abandon|4:word|10:/əˈbændən/|0:|0:|0:', () => {
    // 架构增量 v0.1：第 4 段纳入 arpabet（换发音真源必须换缓存），voice 段后移为第 5 段。
    // 2026-10-14 v2：加 v2 版本前缀 + 第 6 段 model（页面不传 voice，必须由编排器补）。
    const key = cacheKey({ text: 'abandon', mode: 'word', ipa: '/əˈbændən/' });
    expect(key).toBe(`2:v2|7:abandon|4:word|${'/əˈbændən/'.length}:/əˈbændən/|0:|0:|0:`);
    expect('/əˈbændən/'.length).toBe(10);
    // 字段含 '|' 时长度前缀保证唯一解码（任意切分都会校验长度失败）
    // 七段：v2 | text | mode | ipa | arpabet | voice | model
    const tricky = cacheKey({ text: 'a|4:x', mode: 'word', voice: 'v' });
    expect(tricky).toBe('2:v2|5:a|4:x|4:word|0:|0:|1:v|0:');
  });
});

describe('对抗：IPA → Azure 映射与 SSML 注入', () => {
  it('差异字符映射：ɡ→g、ʧ→tʃ、ʤ→dʒ、ɜ→ɜː', () => {
    expect(mapIpaToAzure('ɡood')).toBe('good');
    expect(mapIpaToAzure('ʧiːz')).toBe('tʃiːz');
    expect(mapIpaToAzure('ʤOb')).toBe('dʒOb');
    expect(mapIpaToAzure('hɜː'.replace('ɜː', 'ɜ'))).toBe('hɜː');
  });

  it('不支持字符原样保留（由 Azure 报错→兜底轨兜住），映射不抛异常', () => {
    for (const ch of ['ʝ', 'x', 'χ', 'ʕ', ' Delaware']) {
      expect(() => mapIpaToAzure(`ə${ch}n`)).not.toThrow();
    }
    expect(mapIpaToAzure('əʝn')).toBe('əʝn'); // 未知字符 passthrough
  });

  it('stripIpaSlashes：去首尾斜杠与空白', () => {
    expect(stripIpaSlashes('/ əˈbændən /')).toBe('əˈbændən');
    expect(stripIpaSlashes('')).toBe('');
  });

  it('SSML：IPA 含 XML 特殊字符（<、"、&）时被转义，不会被当作标签解析', () => {
    const evil = '/a<b>&"c/';
    const ssml = buildSsml({ text: 'test', mode: 'word', ipa: evil });
    expect(ssml).not.toContain('<b>'); // 未被解析为标签
    expect(ssml).toContain('&lt;b&gt;&amp;&quot;c');
    // 产物结构完整：speak/voice 包裹，phoneme 属性值为转义后文本
    expect(ssml.startsWith('<speak ')).toBe(true);
    expect(ssml.endsWith('</speak>')).toBe(true);
    expect((ssml.match(/<phoneme/g) ?? []).length).toBe(1);
    expect((ssml.match(/<voice/g) ?? []).length).toBe(1);
    // 除 speak/voice/phoneme 开合标签外，任何 '<' 都必须已转义
    expect(ssml).not.toContain('<b>');
  });

  it('SSML：word 模式有 IPA 注入 phoneme、无 IPA 退纯文本；sentence 模式不注入 phoneme', () => {
    const withIpa = buildSsml({ text: 'cat', mode: 'word', ipa: '/kæt/' });
    expect(withIpa).toContain('<phoneme alphabet="ipa" ph="kæt">cat</phoneme>');
    const noIpa = buildSsml({ text: 'cat', mode: 'word' });
    expect(noIpa).not.toContain('<phoneme');
    expect(noIpa).toContain('>cat<');
    const sentence = buildSsml({ text: 'I like cats', mode: 'sentence' });
    expect(sentence).not.toContain('<phoneme');
    expect(sentence).not.toContain('<break');
  });

  it('escapeXml 基本语义', () => {
    expect(escapeXml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;');
  });

  it('fetchWithTimeout：Azure 请求头带 key 与输出格式', async () => {
    const fetchMock = vi.fn(async () => new Response(new ArrayBuffer(4), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const ctx: TTSContext = { config: activeCfg().config, apiKey: 'sk-live' };
      const { neuralProvider } = await import('../../src/tts/neuralProvider');
      await neuralProvider.synthesize(wordReq, ctx);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
      const headers = init.headers as Record<string, string>;
      expect(headers['Ocp-Apim-Subscription-Key']).toBe('sk-live');
      expect(headers['X-Microsoft-OutputFormat']).toBe(AZURE_OUTPUT_FORMAT);
      expect(headers['Content-Type']).toBe('application/ssml+xml');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
