/**
 * voiceOverride.test.ts —— 模型/音色临时覆盖（用户 2026-10-18）：
 * 长按「重新合成」按钮临选模型/音色 → 临时固定本轮。
 * 硬约束（用户原话「云端音频和模型音色要对准不要串了」）：
 *   cacheKey / cloudAudioPath / synthesize 必须从**同一份生效配置**派生——
 *   覆盖在 orchestrator 内合并（applyVoiceOverride），换项即换 lane，旧 lane 原样保留。
 * 覆盖范围：helpers 分组规则 + getAudio 三处同源 + regenerate 删除也不错 lane + 不泄漏。
 */
import { describe, expect, it } from 'vitest';
import { cacheKey, createOrchestrator, inMemoryAudioCache, type OrchestratorDeps } from '../../src/tts/orchestrator';
import { cloudAudioPath, inMemoryAudioStore } from '../../src/data/cloudAudioStore';
import { defaultVoiceForModel, voiceLabelOf, voicesForModel, ALL_MODELS } from '../../src/tts/voiceOptions';
import type { TTSContext, TTSProvider, TTSResult, VoiceOverride } from '../../src/tts/types';
import type { TTSProviderConfig } from '../../src/types/domain';

const cfg = (over: Partial<TTSProviderConfig> = {}): TTSProviderConfig => ({
  id: 'tts1',
  userId: 'u1',
  provider: 'dashscope',
  endpoint: 'https://dashscope.example/api',
  ssmlPhonemeEnabled: true,
  status: 'active',
  fallbackEngine: 'ipa_espeak',
  voice: 'longhuhu_v3',
  model: 'cosyvoice-v3-flash',
  ...over,
});

const req = { text: 'bury', ipa: '/ˈbɛ.ri/', arpabet: 'B EH1 R IY0', mode: 'word' as const };

/** 记录每次 synthesize 收到的生效 config（voice/model） */
function recordingNeural() {
  const seen: { voice?: string; model?: string }[] = [];
  const provider: TTSProvider = {
    id: 'neural_tts',
    synthesize: async (_req, ctx?: TTSContext): Promise<TTSResult> => {
      seen.push({ voice: ctx?.config.voice, model: ctx?.config.model });
      return { audio: new ArrayBuffer(8), engine: 'neural_tts', fromCache: false };
    },
  };
  return { provider, seen };
}

function setup(over: Partial<OrchestratorDeps> = {}) {
  const neural = recordingNeural();
  const deps: OrchestratorDeps = {
    getConfig: async () => ({ config: cfg(), apiKey: 'k' }),
    log: async () => {},
    cache: inMemoryAudioCache(),
    neural: neural.provider,
    espeak: {
      id: 'ipa_espeak',
      synthesize: async () => ({ audio: new ArrayBuffer(4), engine: 'ipa_espeak' as const, fromCache: false }),
    },
    ...over,
  };
  return { orch: createOrchestrator(deps), seen: neural.seen };
}

// ===== helpers =====

describe('voiceOptions：音色按模型分组（官方约束：不能跨模型混用）', () => {
  it('v3-flash 含 longhuhu_v3；v2 不含（换模型必须换音色表内的）', () => {
    expect(voicesForModel('cosyvoice-v3-flash').map((v) => v.voice)).toContain('longhuhu_v3');
    expect(voicesForModel('cosyvoice-v2').map((v) => v.voice)).not.toContain('longhuhu_v3');
    expect(voicesForModel('no-such-model')).toEqual([]);
  });

  it('defaultVoiceForModel 取表内第一个；未知模型空串', () => {
    expect(defaultVoiceForModel('cosyvoice-v3-flash')).toBe('longanyang');
    expect(defaultVoiceForModel('nope')).toBe('');
  });

  it('voiceLabelOf 查表、未知回落原始 ID', () => {
    expect(voiceLabelOf('cosyvoice-v3-flash', 'longhuhu_v3')).toContain('龙呼呼');
    expect(voiceLabelOf('cosyvoice-v3-flash', 'unknown_voice')).toBe('unknown_voice');
  });

  it('qwen-audio-3.1-tts-flash 已入表（用户 2026-10-18 拍板：英语母语音色直接可选）', () => {
    expect(ALL_MODELS).toContain('qwen-audio-3.1-tts-flash');
    const q = voicesForModel('qwen-audio-3.1-tts-flash').map((v) => v.voice);
    expect(q).toContain('Brian_v3.1');
    expect(q).toContain('Emily_v3.1');
    expect(q).not.toContain('loongmary'); // 3.0 英语音色 SSML 不支持，禁止入表
    expect(defaultVoiceForModel('qwen-audio-3.1-tts-flash')).toBe('Brian_v3.1');
  });

  it('cacheKey 含 voice+model：换任何一个都是新 key（v2 口径）', () => {
    const a = cacheKey(req, 'longhuhu_v3', 'cosyvoice-v3-flash');
    const b = cacheKey(req, 'longanyang', 'cosyvoice-v3-flash');
    const c = cacheKey(req, 'longhuhu_v3', 'cosyvoice-v2');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

// ===== getAudio：三处同源 =====

describe('getAudio：voiceOverride 合并成生效配置（合成/缓存/云端同源）', () => {
  it('覆盖后：synthesize 收到覆盖 config；云端只写覆盖 lane，默认 lane 不碰', async () => {
    const remote = inMemoryAudioStore();
    const { orch, seen } = setup({ remote, getUserId: () => 'u1' });
    const ov: VoiceOverride = { model: 'cosyvoice-v3-plus', voice: 'longanyang' };

    const r = await orch.getAudio(req, 'w1', { voiceOverride: ov });
    expect(r.engine).toBe('neural_tts');
    expect(seen).toEqual([{ voice: 'longanyang', model: 'cosyvoice-v3-plus' }]);

    // 云端上传到覆盖 lane（音色目录 + 含 voice/model 的 key hash）
    const pOverride = await cloudAudioPath(req, 'u1', 'longanyang', 'cosyvoice-v3-plus');
    expect(remote.store.has(pOverride)).toBe(true);
    // 默认 lane 一个字都没写——不串
    const pDefault = await cloudAudioPath(req, 'u1', 'longhuhu_v3', 'cosyvoice-v3-flash');
    expect(remote.store.has(pDefault)).toBe(false);
  });

  it('两个 lane 独立：同词带覆盖命中覆盖缓存；不带覆盖则按默认配置重新合成', async () => {
    const { orch, seen } = setup({ remote: null, getUserId: () => 'u1' });
    const ov: VoiceOverride = { model: 'cosyvoice-v3-plus', voice: 'longanyang' };
    await orch.getAudio(req, 'w1', { voiceOverride: ov });
    const again = await orch.getAudio(req, 'w1', { voiceOverride: ov });
    expect(again.fromCache).toBe(true); // 覆盖 lane 缓存命中
    expect(seen.length).toBe(1);

    const dflt = await orch.getAudio(req, 'w1'); // 不带覆盖 = 默认 lane
    expect(dflt.fromCache).toBe(false);
    expect(seen.length).toBe(2);
    expect(seen[1]).toEqual({ voice: 'longhuhu_v3', model: 'cosyvoice-v3-flash' });
  });

  it('无覆盖：行为与设置页配置一致（回归——默认路径不变）', async () => {
    const { orch, seen } = setup();
    await orch.getAudio(req, 'w1');
    expect(seen).toEqual([{ voice: 'longhuhu_v3', model: 'cosyvoice-v3-flash' }]);
  });

  it('覆盖不泄漏：带覆盖合成后，后续不带覆盖的调用仍按设置页配置', async () => {
    const { orch, seen } = setup();
    await orch.getAudio(req, 'w1', { voiceOverride: { model: 'cosyvoice-v3-plus', voice: 'longanyang' } });
    await orch.getAudio({ ...req, text: 'bugle', arpabet: 'B Y UW1 G AH0 L' }, 'w2');
    expect(seen[1]).toEqual({ voice: 'longhuhu_v3', model: 'cosyvoice-v3-flash' });
  });
});

// ===== regenerate：删除也不错 lane =====

describe('regenerate：删除与合成都按生效配置算', () => {
  it('带覆盖重录：只写覆盖 lane；默认 lane 的缓存/云端原样保留', async () => {
    const remote = inMemoryAudioStore();
    const { orch, seen } = setup({ remote, getUserId: () => 'u1' });

    // 先按默认配置合成一次：默认 lane 落地（缓存 + 云端）
    await orch.getAudio(req, 'w1');
    const pDefault = await cloudAudioPath(req, 'u1', 'longhuhu_v3', 'cosyvoice-v3-flash');
    expect(remote.store.has(pDefault)).toBe(true);

    const ov: VoiceOverride = { model: 'cosyvoice-v3-plus', voice: 'longanyang' };
    await orch.regenerate(req, 'w1', { voiceOverride: ov });

    const pOverride = await cloudAudioPath(req, 'u1', 'longanyang', 'cosyvoice-v3-plus');
    expect(remote.store.has(pOverride)).toBe(true); // 覆盖 lane 新音频已回传
    expect(remote.store.has(pDefault)).toBe(true); // 默认 lane 没被删/没被改
    expect(remote.puts.filter((p) => p === pDefault).length).toBe(1); // 默认 lane 只被第一次写过
    expect(remote.puts.filter((p) => p === pOverride).length).toBe(1); // 重录只写覆盖 lane
    expect(seen).toEqual([
      { voice: 'longhuhu_v3', model: 'cosyvoice-v3-flash' },
      { voice: 'longanyang', model: 'cosyvoice-v3-plus' },
    ]);
  });

  it('不带覆盖重录：删/写都按默认配置（回归）', async () => {
    const remote = inMemoryAudioStore();
    const removed: string[] = [];
    const { orch, seen } = setup({ remote, getUserId: () => 'u1' });
    await orch.getAudio(req, 'w1');
    const pDefault = await cloudAudioPath(req, 'u1', 'longhuhu_v3', 'cosyvoice-v3-flash');
    // 包一层 remove 记录被删路径（默认 lane 的云端文件先被删、再被新音频覆盖写回）
    const origRemove = remote.remove.bind(remote);
    remote.remove = async (p: string) => {
      removed.push(p);
      return origRemove(p);
    };

    await orch.regenerate(req, 'w1');
    expect(removed).toEqual([pDefault]); // 删的就是默认 lane
    expect(seen.length).toBe(2);
    expect(seen[1]).toEqual({ voice: 'longhuhu_v3', model: 'cosyvoice-v3-flash' });
    expect(remote.store.has(pDefault)).toBe(true); // 删后又被新音频覆盖写回
  });
});
