/**
 * cloudAudioStore.test.ts —— 云音频库（用户 2026-10-14）：
 * ① 同一音色/同词 → 同一路径（第二次直接读文件，不再合成）；
 * ② 换音色 ⇒ 路径必变（绝不拿别的音色的文件顶替）；
 * ③ 编排器：云端命中不合成；缺词 → 合成后上传云端；兜底机械音不上传；
 * ④ 阶段回调：读文件=reading，现场合成=synthesizing。
 */
import { describe, expect, it } from 'vitest';
import {
  CLOUD_AUDIO_PREFIX,
  cloudAudioPath,
  inMemoryAudioStore,
  slugifyVoice,
} from '../../src/data/cloudAudioStore';
import { createOrchestrator, inMemoryAudioCache } from '../../src/tts/orchestrator';
import type { TTSProviderConfig } from '../../src/types/domain';
import type { TTSProvider, TTSRequest, TTSResult } from '../../src/tts/types';

const req: TTSRequest = { text: 'acquire', mode: 'word', ipa: '/əˈkwaɪər/' };

function cfgOf(voice: string, model = 'sambert-v1'): TTSProviderConfig {
  return {
    channel: 'dashscope',
    status: 'active',
    voice,
    model,
    sampleRate: 16000,
    baseUrl: '',
    updatedAt: '',
  } as unknown as TTSProviderConfig;
}

function stubProvider(engine: TTSResult['engine'], tag: string): TTSProvider {
  return {
    id: tag,
    async synthesize(): Promise<TTSResult> {
      const audio = new TextEncoder().encode(tag).buffer;
      return { audio, engine, fromCache: false };
    },
  };
}

describe('云音频库路径：音色隔离', () => {
  it('同音色同词 → 同一路径（可复用）', async () => {
    const a = await cloudAudioPath(req, 'u1', 'Lingfei', 'm1');
    const b = await cloudAudioPath(req, 'u1', 'Lingfei', 'm1');
    expect(a).toBe(b);
    expect(a.startsWith(`${CLOUD_AUDIO_PREFIX}/`)).toBe(true);
  });
  it('换音色 → 路径不同（音色目录 + key hash 双保险）', async () => {
    const a = await cloudAudioPath(req, 'u1', 'Lingfei', 'm1');
    const b = await cloudAudioPath(req, 'u1', 'Stella', 'm1');
    expect(a).not.toBe(b);
    expect(a.split('/')[3]).not.toBe(b.split('/')[3]);
  });
  it('同音色换模型 / 换音标 / 换模式 → 路径也不同', async () => {
    const base = await cloudAudioPath(req, 'u1', 'Lingfei', 'm1');
    expect(await cloudAudioPath(req, 'u1', 'Lingfei', 'm2')).not.toBe(base);
    expect(await cloudAudioPath({ ...req, ipa: '/x/' }, 'u1', 'Lingfei', 'm1')).not.toBe(base);
    expect(await cloudAudioPath({ ...req, mode: 'sentence' }, 'u1', 'Lingfei', 'm1')).not.toBe(base);
  });
  it('音色名为空/含非法字符 → 落到 default 目录且不崩', async () => {
    expect(slugifyVoice('')).toBe('default');
    expect(slugifyVoice('Ada Bell/v2')).toBe('ada_bell_v2');
    const p = await cloudAudioPath(req, 'u1', '', 'm1');
    expect(p.split('/')[3]).toBe('default');
  });
});

describe('编排器接云音频库', () => {
  const deps = (opts: {
    remote?: ReturnType<typeof inMemoryAudioStore> | null;
    voice?: string;
    neuralFails?: boolean;
    phases?: string[];
  }) => {
    const logs: Record<string, unknown>[] = [];
    // getUserId：云音频路径 shared/{uid}/... 的归属（缺了就不查/不上传云端）
    const neural: TTSProvider = opts.neuralFails
      ? {
          id: 'fail',
          async synthesize(): Promise<TTSResult> {
            throw new Error('boom');
          },
        }
      : stubProvider('neural_tts', 'NEURAL');
    return {
      logs,
      orch: createOrchestrator({
        cache: inMemoryAudioCache(),
        remote: opts.remote === undefined ? null : opts.remote,
        getUserId: () => 'u1',
        getConfig: async () => ({ config: cfgOf(opts.voice ?? 'Lingfei'), apiKey: 'k' }),
        log: async (e) => {
          logs.push({ ...e });
        },
        neural,
        espeak: stubProvider('ipa_espeak', 'ESPEAK'),
        onPhase: (p) => opts.phases?.push(p),
      }),
    };
  };

  it('云端有该音色的音频 → 直接返回，不调主轨合成', async () => {
    const remote = inMemoryAudioStore();
    const path = await cloudAudioPath(req, 'u1', 'Lingfei', 'sambert-v1');
    remote.store.set(path, new TextEncoder().encode('CLOUD').buffer);
    const phases: string[] = [];
    const { orch, logs } = deps({ remote, phases });
    const res = await orch.getAudio(req, 'w1');
    expect(new TextDecoder().decode(res.audio)).toBe('CLOUD');
    expect(res.engine).toBe('neural_tts');
    expect(res.fromCache).toBe(true);
    expect(logs.length).toBe(0); // 没合成 ⇒ 没有合成日志、不计费
    expect(phases).toEqual(['reading']); // 读文件，不是合成
  });

  it('云端缺词 → 现场合成并回传云端（下次直接读）', async () => {
    const remote = inMemoryAudioStore();
    const path = await cloudAudioPath(req, 'u1', 'Lingfei', 'sambert-v1');
    const phases: string[] = [];
    const { orch, logs } = deps({ remote, phases });
    const res = await orch.getAudio(req, 'w1');
    expect(new TextDecoder().decode(res.audio)).toBe('NEURAL');
    expect(remote.puts).toContain(path); // 已上传
    expect(remote.store.get(path)).toBeDefined();
    expect(logs[0].cloudMiss).toBe(true); // 记录本次为缺词合成
    expect(phases).toEqual(['reading', 'synthesizing']);
  });

  it('换台设备（本地缓存是空的）再取同一个词、同音色 → 走云端文件，不再合成', async () => {
    const remote = inMemoryAudioStore();
    const { orch } = deps({ remote });
    await orch.getAudio(req, 'w1');
    // 第二个编排器 + 全新的本地缓存：模拟另一台手机，本地一份都没有
    const second = deps({ remote });
    const again = await second.orch.getAudio(req, 'w1');
    expect(new TextDecoder().decode(again.audio)).toBe('NEURAL');
    expect(again.fromCache).toBe(true);
    expect(second.logs.length).toBe(0); // 没合成 ⇒ 没有合成日志、不计费
    expect(remote.puts.length).toBe(1); // 全程只上传过一次
  });

  it('★ 兜底机械音绝不上传云端（否则音色库被污染）', async () => {
    const remote = inMemoryAudioStore();
    const { orch, logs } = deps({ remote, neuralFails: true });
    const res = await orch.getAudio(req, 'w1');
    expect(res.engine).toBe('ipa_espeak');
    expect(remote.puts).toEqual([]);
    expect(remote.store.size).toBe(0);
    expect(logs[0].engine).toBe('ipa_espeak');
    expect(logs[0].cloudMiss).toBeUndefined();
  });

  it('★ 换音色后不会拿到另一个音色的音频', async () => {
    const remote = inMemoryAudioStore();
    const { orch } = deps({ remote, voice: 'Lingfei' });
    await orch.getAudio(req, 'w1'); // Lingfei 合成并落云端
    const other = deps({ remote, voice: 'Stella' });
    const res = await other.orch.getAudio(req, 'w1');
    expect(new TextDecoder().decode(res.audio)).toBe('NEURAL');
    const stellaPath = await cloudAudioPath(req, 'u1', 'Stella', 'sambert-v1');
    expect(remote.store.get(stellaPath)).toBeDefined(); // Stella 自己那份，而不是复用 Lingfei 的
    expect(other.logs[0].cloudMiss).toBe(true);
  });

  it('无配置（音色未定）→ 不查云端、不上传', async () => {
    const remote = inMemoryAudioStore();
    const orch = createOrchestrator({
      cache: inMemoryAudioCache(),
      remote,
      getConfig: async () => null,
      log: async () => {},
      neural: stubProvider('neural_tts', 'X'),
      espeak: stubProvider('ipa_espeak', 'ESPEAK'),
    });
    const res = await orch.getAudio(req);
    expect(res.engine).toBe('ipa_espeak'); // 未配置 → 兜底轨
    expect(remote.puts).toEqual([]);
  });

  it('未注入云端（remote=null）→ 退回纯本地缓存 + 合成', async () => {
    const phases: string[] = [];
    const { orch } = deps({ remote: null, phases });
    const res = await orch.getAudio(req, 'w1');
    expect(new TextDecoder().decode(res.audio)).toBe('NEURAL');
    expect(phases).toEqual(['reading', 'synthesizing']);
  });
});
