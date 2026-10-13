/**
 * authGate.test.ts —— 锁死「未登录不得用假身份往下走」这条回归锚点。
 *
 * 背景（2026-10-12 线上 bug）：bootstrap 原来写 `userId = session.userId ?? 'local-user'`，
 * 未登录时 SDK 以 anon role 发请求，词书初始化第一步就撞 RLS：
 *   [words] new row violates row-level security policy (42501)
 * 页面却照常渲染，用户直到点「初始化六级词库」才看到错误。
 * 现在：未登录 → needsLogin=true、userId=null、直接停登录页。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  order: [] as string[],
  session: { signedIn: false, userId: undefined as string | undefined },
}));

vi.mock('../../src/data/cloud', () => ({
  isCloudConfigured: () => true,
  getSessionInfo: async () => {
    h.order.push('getSession');
    return h.session;
  },
  consumeWorkBuddyCallback: async () => {
    h.order.push('consumeCallback');
  },
}));

const { useAppStore } = await import('../../src/store/useAppStore');

beforeEach(() => {
  h.order.length = 0;
  h.session.signedIn = false;
  h.session.userId = undefined;
  useAppStore.setState({
    userId: null,
    cloudReady: false,
    loading: false,
    needsLogin: false,
    error: null,
    books: [],
  });
});

describe('bootstrap 登录守卫', () => {
  it('未登录：needsLogin=true、userId 保持 null（绝不回落假身份）', async () => {
    await useAppStore.getState().bootstrap();
    const s = useAppStore.getState();
    expect(s.needsLogin).toBe(true);
    expect(s.userId).toBeNull();
    expect(s.cloudReady).toBe(true);
  });

  it('OAuth 落地兑换必须跑在登录态判断之前（否则转一圈回登录页）', async () => {
    await useAppStore.getState().bootstrap();
    expect(h.order).toEqual(['consumeCallback', 'getSession']);
  });
});
