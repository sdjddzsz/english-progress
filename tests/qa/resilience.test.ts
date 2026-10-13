/**
 * qa/resilience.test.ts —— 健壮性加固单测：
 *  ① timeoutFetch：云请求挂起 → 超时 reject（避免 boot 永久挂起）；
 *     并验证 getCloud 把带超时的 fetch 注入 SDK（options.fetch）。
 *  ② ErrorBoundary：进入错误态后渲染「页面出错了」而非整页白屏。
 *  ③ BookPage：store.error 非空时页面顶部渲染出该文案（云失败可见）。
 *
 * SSR 测试口径说明（无 jsdom / @testing-library，用 react-dom/server）：
 *  - React 18 的 legacy `renderToString` **不支持**类错误边界捕获（抛错会直接向上冒泡，
 *    只有 stream API 支持边界）；故②直接驱动边界状态机（getDerivedStateFromError → render），
 *    等价于运行时捕获后的渲染结果。
 *  - zustand 的 SSR server snapshot 取 store 初值，看不到 setState 之后的更新；
 *    故③用 vi.mock 注入 store 状态（浏览器真实运行时会随订阅更新，此处只需验证渲染分支）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ErrorBoundary from '../../src/components/guards/ErrorBoundary';

// ③ 词书页：注入 store 状态（hoisted，供 vi.mock 工厂引用）
const storeState = vi.hoisted(() => ({
  books: [] as unknown[],
  activeBookId: null as string | null,
  loading: false,
  error: null as string | null,
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: () => storeState,
  getRepos: () => ({}),
}));

const { default: BookPage } = await import('../../src/pages/BookPage');

// ===== ① 云请求超时 =====

describe('timeoutFetch：云请求封顶，避免 boot 永久挂起', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('请求挂起（永不 resolve）→ 超时 reject', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError')));
          }),
      ),
    );
    const { timeoutFetch } = await import('../../src/data/cloud');
    await expect(timeoutFetch('https://cloud.test/slow', {}, 20)).rejects.toThrow(/abort/i);
  });

  it('正常请求透传原 Response', async () => {
    const res = new Response('ok', { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async () => res));
    const { timeoutFetch } = await import('../../src/data/cloud');
    await expect(timeoutFetch('https://cloud.test/ok', {}, 1000)).resolves.toBe(res);
  });

  it('getCloud 注入带超时的 fetch（SDK options.fetch）', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_CLOUD_ENDPOINT', 'https://english-progress.app.workbuddy.host');
    vi.stubEnv('VITE_CLOUD_PUBLISHABLE_KEY', 'wbpk_test_key');
    const received: Array<{ fetch?: unknown }> = [];
    vi.doMock('@tencent-ai/workbuddy-cloud-sdk', () => ({
      createWorkBuddyCloud: (opts: { fetch?: unknown }) => {
        received.push(opts);
        return { database: {}, auth: {} };
      },
    }));
    try {
      const cloud = await import('../../src/data/cloud');
      cloud.getCloud();
      expect(received).toHaveLength(1);
      expect(typeof received[0].fetch).toBe('function');
    } finally {
      vi.doUnmock('@tencent-ai/workbuddy-cloud-sdk');
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

// ===== ② 渲染错误边界 =====

type BoundaryCtor = new (props: { children: null }) => ErrorBoundary;

describe('ErrorBoundary：渲染抛错不再整页白屏', () => {
  it('进入错误态 → 渲染「页面出错了」并带错误文本', () => {
    const boom = new Error('boom-xyz-123');
    const inst = new (ErrorBoundary as unknown as BoundaryCtor)({ children: null });
    inst.state = ErrorBoundary.getDerivedStateFromError(boom);
    const html = renderToString(inst.render() as ReactElement);
    expect(html).toContain('页面出错了');
    expect(html).toContain('boom-xyz-123');
  });

  it('getDerivedStateFromError 置 hasError + error', () => {
    const err = new Error('x');
    expect(ErrorBoundary.getDerivedStateFromError(err)).toEqual({ hasError: true, error: err });
  });

  it('无错时原样透传 children', () => {
    const html = renderToString(createElement(ErrorBoundary, null, createElement('span', null, 'ok-child')));
    expect(html).toContain('ok-child');
    expect(html).not.toContain('页面出错了');
  });
});

// ===== ③ 词书页错误可见 =====

describe('BookPage：store.error 非空时页面顶部可见', () => {
  afterEach(() => {
    storeState.error = null;
    storeState.books = [];
  });

  it('渲染出该 error 文案（云失败不再白屏/转圈）', () => {
    storeState.error = '云端请求失败：403 (Forbidden)';
    storeState.books = [];
    const html = renderToString(createElement(MemoryRouter, null, createElement(BookPage)));
    expect(html).toContain('云端请求失败：403 (Forbidden)');
  });

  it('无 error 时不渲染该告警', () => {
    storeState.error = null;
    const html = renderToString(createElement(MemoryRouter, null, createElement(BookPage)));
    expect(html).not.toContain('云端请求失败：403 (Forbidden)');
  });
});
