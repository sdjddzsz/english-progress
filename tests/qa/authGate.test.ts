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
    bootstrapped: false,
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

/**
 * 回归锚点（2026-10-13 线上 bug）：从首页切任意 Tab 永久转圈「打不开」，直开 URL 却正常。
 * 根因：AuthGate 以 loading 整屏替换 children，而每个路由页 mount 都调 bootstrap()，
 * 二者相加导致「挂载 → loading=true → 整棵卸载 → 重挂 → 再 bootstrap」死循环。
 * 护栏：首次 bootstrap 完成后置 bootstrapped=true 并短路后续调用（除非显式 force）。
 */
describe('bootstrap 首次短路（防「切 Tab 卸载重挂死循环」回归锚点）', () => {
  it('首次执行后标记 bootstrapped；再次调用（无 force）不发任何云请求', async () => {
    await useAppStore.getState().bootstrap();
    expect(h.order).toEqual(['consumeCallback', 'getSession']);
    expect(useAppStore.getState().bootstrapped).toBe(true);

    // 模拟路由页 mount 时的重复调用
    h.order.length = 0;
    await useAppStore.getState().bootstrap();
    expect(h.order).toEqual([]); // 短路：既不换会话也不查登录态
    expect(useAppStore.getState().loading).toBe(false); // 也不会把 loading 置真去触发整屏卸载
    expect(useAppStore.getState().bootstrapped).toBe(true);
  });

  it('bootstrap({ force: true }) 显式重试：重新执行完整链路', async () => {
    await useAppStore.getState().bootstrap();
    h.order.length = 0;
    await useAppStore.getState().bootstrap({ force: true });
    expect(h.order).toEqual(['consumeCallback', 'getSession']);
  });
});
