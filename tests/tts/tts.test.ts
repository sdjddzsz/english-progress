/**
 * tts.test.ts —— TTS 层验收（批 2 要求）：
 * - SSML 生成快照测试（四模式）；
 * - IPA→Azure 映射；
 * - 编排器回退链（主轨失败→兜底）、缓存命中不重复合成、PronunciationLog 落库、轻提示一次。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mapIpaToAzure, splitSyllables, stripIpaSlashes, ipaToWordTokens } from '../../src/tts/ipaMap';
import { buildSsml, escapeXml } from '../../src/tts/ssml';
import { cacheKey, consumeFallbackNotice, createOrchestrator, inMemoryAudioCache, resetFallbackNotice } from '../../src/tts/orchestrator';
import { cloudAudioPath, inMemoryAudioStore } from '../../src/data/cloudAudioStore';
import type { OrchestratorDeps, PronunciationLogEntry } from '../../src/tts/orchestrator';
import type { TTSProviderConfig } from '../../src/types/domain';

function cfg(over: Partial<TTSProviderConfig> = {}): TTSProviderConfig {
  return {
    id: 'tts1',
    userId: 'u1',
    provider: 'azure',
    endpoint: 'https://region.tts.speech.microsoft.com/cognitiveservices/v1',
    ssmlPhonemeEnabled: true,
    status: 'active',
    fallbackEngine: 'ipa_espeak',
    ...over,
  };
}

// ===== ipaMap =====

describe('ipaMap：IPA → Azure 音素集', () => {
  it('stripIpaSlashes 去斜杠', () => {
    expect(stripIpaSlashes('/əˈkɒm.ə.deɪt/')).toBe('əˈkɒm.ə.deɪt');
  });

  it('差异字符映射：ɡ→g、ʧ→tʃ、ɜ→ɜː', () => {
    expect(mapIpaToAzure('ɡʊd')).toBe('gʊd');
    expect(mapIpaToAzure('ʧaɪns')).toBe('tʃaɪns');
    expect(mapIpaToAzure('ˈsɜɪd')).toBe('ˈsɜːɪd'); // ɜ 单字符补长音符
    expect(mapIpaToAzure('ɫɪtl')).toBe('lɪtl');
  });

  it('splitSyllables：重音符归属其后音节', () => {
    expect(splitSyllables('/əˈkɒm.ə.deɪt/')).toEqual(['əˈkɒm', 'ə', 'deɪt']);
    expect(splitSyllables('')).toEqual([]);
  });

  it('ipaToWordTokens 按词切分', () => {
    expect(ipaToWordTokens('/həˈləʊ  wɜːld/')).toEqual(['həˈləʊ', 'wɜːld']);
  });
});

// ===== ssml =====

describe('ssml 构造（快照）', () => {
  it('word 模式：IPA phoneme 注入', () => {
    const ssml = buildSsml({ text: 'accommodate', ipa: '/əˈkɒm.ə.deɪt/', mode: 'word' });
    expect(ssml).toContain('alphabet="ipa"');
    expect(ssml).toContain('ph="əˈkɒm.ə.deɪt"');
    expect(ssml).toMatchSnapshot('word');
  });

  it('syllable 模式：单音节请求', () => {
    const ssml = buildSsml({ text: 'kɒm', syllable: 'ˈkɒm', mode: 'syllable' });
    expect(ssml).toContain('ph="ˈkɒm"');
    expect(ssml).toMatchSnapshot('syllable');
  });

  it('sentence 模式：自然韵律（无 phoneme 注入）', () => {
    const ssml = buildSsml({ text: 'The hotel can accommodate 500 guests.', mode: 'sentence' });
    expect(ssml).not.toContain('<phoneme');
    expect(ssml).toMatchSnapshot('sentence');
  });

  it('word_by_word 模式：词间 break 禁连读', () => {
    const ssml = buildSsml({ text: 'look after', mode: 'word_by_word' });
    expect(ssml).toContain('<break time="150ms"/>');
    expect(ssml).toMatchSnapshot('word_by_word');
  });

  it('escapeXml', () => {
    expect(escapeXml(`a<b>&"c"`)).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
  });
});

// ===== orchestrator =====

function stubProviders() {
  const calls = { neural: 0, espeak: 0 };
  const neural = {
    id: 'neural_tts',
    synthesize: async () => {
      calls.neural += 1;
      return { audio: new ArrayBuffer(8), engine: 'neural_tts' as const, fromCache: false };
    },
  };
  const espeak = {
    id: 'ipa_espeak',
    synthesize: async () => {
      calls.espeak += 1;
      return { audio: new ArrayBuffer(4), engine: 'ipa_espeak' as const, fromCache: false };
    },
  };
  return { calls, neural, espeak };
}

describe('编排器：缓存 → 主轨 → 兜底 → 日志 → 轻提示一次', () => {
  let logs: PronunciationLogEntry[];
  let cache: ReturnType<typeof inMemoryAudioCache>;
  let providers: ReturnType<typeof stubProviders>;

  function makeDeps(config: TTSProviderConfig | null, apiKey?: string): OrchestratorDeps {
    return {
      getConfig: async () => (config ? { config, apiKey } : null),
      log: async (e) => {
        logs.push(e);
      },
      cache,
      neural: providers.neural,
      espeak: providers.espeak,
      // 本文件只测发音链路本身；云音频库由 cloudAudioStore.test.ts 单独覆盖
      remote: null,
    };
  }

  beforeEach(() => {
    logs = [];
    cache = inMemoryAudioCache();
    providers = stubProviders();
    resetFallbackNotice();
  });

  const req = { text: 'accommodate', ipa: '/əˈkɒm.ə.deɪt/', mode: 'word' as const };

  it('主轨成功：engine=neural_tts、写缓存、日志 success', async () => {
    const orch = createOrchestrator(makeDeps(cfg(), 'key-123'));
    const r = await orch.getAudio(req, 'w1');
    expect(r.engine).toBe('neural_tts');
    expect(r.fromCache).toBe(false);
    expect(providers.calls.neural).toBe(1);
    expect(providers.calls.espeak).toBe(0);
    expect(logs).toEqual([{ engine: 'neural_tts', success: true, fallbackUsed: false, wordId: 'w1' }]);
    expect(await cache.get(cacheKey(req))).not.toBeNull();
  });

  it('主轨失败 → 兜底轨 + fallback_used 日志 + 轻提示置位一次', async () => {
    const deps = makeDeps(cfg(), 'key-123');
    // 让主轨抛错
    deps.neural!.synthesize = async () => {
      throw new Error('timeout');
    };
    const orch = createOrchestrator(deps);
    const r = await orch.getAudio(req);
    expect(r.engine).toBe('ipa_espeak');
    expect(logs[0]).toMatchObject({ engine: 'ipa_espeak', fallbackUsed: true });
    expect(consumeFallbackNotice()).toBe(true);
    expect(consumeFallbackNotice()).toBe(false); // 本会话仅一次
  });

  it('未配置（pending_user_setup/null）→ 直接兜底轨，不调主轨', async () => {
    const orch = createOrchestrator(makeDeps(cfg({ status: 'pending_user_setup' })));
    const r1 = await orch.getAudio(req);
    expect(r1.engine).toBe('ipa_espeak');
    const orch2 = createOrchestrator(makeDeps(null));
    const r2 = await orch2.getAudio({ ...req, text: 'bias' });
    expect(r2.engine).toBe('ipa_espeak');
    expect(providers.calls.neural).toBe(0);
  });

  it('缓存命中：不再调用任何 Provider，fromCache=true', async () => {
    const orch = createOrchestrator(makeDeps(cfg(), 'key-123'));
    await orch.getAudio(req);
    expect(providers.calls.neural).toBe(1);
    const second = await orch.getAudio(req);
    expect(second.fromCache).toBe(true);
    expect(providers.calls.neural).toBe(1); // 未重复合成
    expect(providers.calls.espeak).toBe(0);
  });

  it('regenerate：清本地缓存+删云端文件 → 重新合成并回传云端（用户 2026-10-17）', async () => {
    const remote = inMemoryAudioStore();
    let cloudRemoved = 0;
    const origRemove = remote.remove.bind(remote);
    remote.remove = async (path) => {
      cloudRemoved += 1;
      return origRemove(path);
    };
    const deps = { ...makeDeps(cfg(), 'key-123'), remote };
    const orch = createOrchestrator(deps);

    await orch.getAudio(req, 'w1'); // 首次：现场合成 + 回传云端
    expect(providers.calls.neural).toBe(1);
    const cloudPath = await cloudAudioPath(req, undefined, undefined);
    expect(remote.store.has(cloudPath)).toBe(true);

    // regenerate：即使本地缓存/云端都有，也必须重新合成
    const r = await orch.regenerate(req, 'w1');
    expect(r.engine).toBe('neural_tts');
    expect(r.fromCache).toBe(false);
    expect(providers.calls.neural).toBe(2);
    expect(cloudRemoved).toBe(1); // 云端旧文件删过一次
    expect(remote.store.has(cloudPath)).toBe(true); // 新音频已回传云端
  });
});
