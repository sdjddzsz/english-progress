/**
 * noFakeIdentity.useTts.test.ts —— 锁死前台编排器的 getConfig 在「未登录」时绝不触达云端。
 *
 * 背景（P2-a）：useTTS 的 getConfig 回调曾直接用 userId 读 tts_provider_configs，
 * 未登录时会以 anon role 发请求（RLS 42501 复发口）。
 * 现在：userId 为空 → getConfig 直接返回 null（编排器对 null 有既有回落 espeak 分支），
 *       不新增分支、不发云端请求。
 *
 * 测试手法：node 环境无 jsdom / testing-library，故用最小 react mock 触发 useTTS()，
 * 用 createOrchestrator 捕获 getConfig 依赖后直接断言其行为。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getTTSConfig: vi.fn(async () => null as unknown),
  userId: null as string | null,
  deps: null as null | { getConfig(): Promise<unknown> },
}));

// 最小 react 替身：让 useTTS() 可在无渲染器环境下被调用。
// ⚠ useTTS 用到哪个 hook，这里必须同步补哪个（2026-10-18：新增 voiceOverride 的 useRef
// 就一次性挂掉本文件 3 条回归锚点——mock 不忠实=假红）。
vi.mock('react', () => ({
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
  useCallback: (fn: unknown) => fn,
  useRef: (init: unknown) => ({ current: init }),
}));

// 捕获传给编排器的依赖；其余导出给出与真实签名兼容的轻量替身
vi.mock('../../src/tts/orchestrator', () => ({
  createOrchestrator: (deps: { getConfig(): Promise<unknown> }) => {
    h.deps = deps;
    return {
      getAudio: async () => ({ audio: new ArrayBuffer(0), engine: 'ipa_espeak', fromCache: false }),
    };
  },
  consumeFallbackNotice: () => false,
  inMemoryAudioCache: () => ({ get: async () => null, put: async () => {}, remove: async () => {} }),
  cacheStorageCache: () => ({ get: async () => null, put: async () => {}, remove: async () => {} }),
}));

vi.mock('../../src/store/useAppStore', () => ({
  getRepos: () => ({ config: { getTTSConfig: h.getTTSConfig } }),
  useAppStore: { getState: () => ({ userId: h.userId }) },
}));

const { useTTS } = await import('../../src/hooks/useTTS');

/** 触发编排器单例装配，从而捕获 getConfig 依赖。 */
async function captureDeps(): Promise<NonNullable<typeof h.deps>> {
  const api = useTTS();
  await api.speak({ text: 'apple', mode: 'word' });
  expect(h.deps).toBeTruthy();
  return h.deps as NonNullable<typeof h.deps>;
}

beforeEach(() => {
  h.getTTSConfig.mockClear();
  h.getTTSConfig.mockResolvedValue(null);
  h.userId = null;
});

describe('useTTS.getConfig 未登录守卫（P2-a 回归锚点）', () => {
  it('userId 为空：getConfig 返回 null 且绝不调用云端 getTTSConfig', async () => {
    h.userId = null;
    const deps = await captureDeps();
    const cfg = await deps.getConfig();
    expect(cfg).toBeNull();
    expect(h.getTTSConfig).not.toHaveBeenCalled();
  });

  it('userId 有值（正向对照）：正常读取云端配置', async () => {
    h.userId = 'u-1';
    h.getTTSConfig.mockResolvedValueOnce({ provider: 'dashscope' });
    const deps = await captureDeps();
    const cfg = (await deps.getConfig()) as { config: unknown };
    expect(h.getTTSConfig).toHaveBeenCalledWith('u-1');
    expect(cfg).toEqual({ config: { provider: 'dashscope' } });
  });

  it('userId 有值但云端无配置：返回 null（不伪造）', async () => {
    h.userId = 'u-2';
    h.getTTSConfig.mockResolvedValueOnce(null);
    const deps = await captureDeps();
    const cfg = await deps.getConfig();
    expect(cfg).toBeNull();
    expect(h.getTTSConfig).toHaveBeenCalledWith('u-2');
  });
});
