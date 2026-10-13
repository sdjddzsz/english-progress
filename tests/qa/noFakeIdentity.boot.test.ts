/**
 * noFakeIdentity.boot.test.ts —— 锁死 bootRuntime 在「未登录」时绝不触达云端 TTS 配置。
 *
 * 背景（2026-10-12 线上 bug，P2-a 复发口）：启动链曾在未登录时用伪造的本地假身份
 * 继续读 tts_provider_configs，SDK 以 anon role 发请求 → RLS 42501。
 * 现在：session.userId 为空 → 跳过一切云端读写（TTS 配置 / 每日校准），
 *       且返回结果里**不含 userId 字段**（绝不伪造身份），ttsKeyLoaded 保持 false。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getTTSConfig: vi.fn(async () => null as unknown),
  session: { signedIn: false, userId: undefined as string | undefined },
}));

vi.mock('../../src/store/useAppStore', () => ({
  getRepos: () => ({ config: { getTTSConfig: h.getTTSConfig } }),
  todayISO: () => '2026-10-13',
  useAppStore: {
    getState: () => ({ userId: h.session.userId ?? null, activePlan: null }),
  },
}));

vi.mock('../../src/data/cloud', () => ({
  isCloudConfigured: () => true,
  getSessionInfo: async () => h.session,
}));

vi.mock('../../src/features/placement/calibration', () => ({
  runDailyCalibration: vi.fn(async () => ({ proposalCreated: false })),
}));

// 真实 useTTS 会拉起编排器单例（重）；本文件只关心云端读路径，替换为轻量 spy。
vi.mock('../../src/hooks/useTTS', () => ({
  setRuntimeTTSApiKey: vi.fn(),
}));

const { bootRuntime } = await import('../../src/offline/bootConfig');

beforeEach(() => {
  h.getTTSConfig.mockClear();
  h.getTTSConfig.mockResolvedValue(null);
  h.session = { signedIn: false, userId: undefined };
});

describe('bootRuntime 未登录守卫（P2-a 回归锚点）', () => {
  it('userId 为空：绝不调用云端 getTTSConfig，也不返回 userId', async () => {
    h.session = { signedIn: false, userId: undefined };
    const r = await bootRuntime();
    expect(h.getTTSConfig).not.toHaveBeenCalled();
    expect(r.cloudReady).toBe(true);
    expect(r.ttsKeyLoaded).toBe(false);
    // 绝不伪造身份：结果对象里不应出现 userId 字段
    expect('userId' in r).toBe(false);
    expect(r.userId).toBeUndefined();
  });

  it('session.userId 为空字符串：同样不触达云端（空值等价于未登录）', async () => {
    h.session = { signedIn: true, userId: '' };
    const r = await bootRuntime();
    expect(h.getTTSConfig).not.toHaveBeenCalled();
    expect('userId' in r).toBe(false);
  });

  it('已登录（正向对照）：正常读取云端配置并注入密钥', async () => {
    h.session = { signedIn: true, userId: 'u-9' };
    h.getTTSConfig.mockResolvedValueOnce({ apiKeyRef: 'runtimeApiKey', runtimeApiKey: 'sk-x' });
    const r = await bootRuntime();
    expect(h.getTTSConfig).toHaveBeenCalledTimes(1);
    expect(h.getTTSConfig).toHaveBeenCalledWith('u-9');
    expect(r.userId).toBe('u-9');
    expect(r.ttsKeyLoaded).toBe(true);
  });
});
