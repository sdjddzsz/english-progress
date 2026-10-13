/**
 * cloud.ts —— WorkBuddy 云 SDK 唯一初始化点（架构文档边界铁律 #2）。
 * 全项目只有本文件允许 import '@tencent-ai/workbuddy-cloud-sdk'；
 * 页面 / store / 调度器禁止直调 SDK，一律经 src/data/repos/*。
 *
 * 配置来源：云服务开通后返回的 publicConfig（endpoint / publishableKey /
 * oauthRelayBaseUrl），部署时写入 .env（见 .env.example）。
 * ⚠ 环境未配置时 getCloud() 抛出清晰的英文错误（中文注释说明），
 *    不做任何静默降级、不硬编码 endpoint。
 */
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import { CLOUD_REQUEST_TIMEOUT_MS } from '../config/constants';
import type { CloudDatabaseLike } from './repository';

const endpoint = import.meta.env.VITE_CLOUD_ENDPOINT;
const publishableKey = import.meta.env.VITE_CLOUD_PUBLISHABLE_KEY;
const oauthRelayBaseUrl = import.meta.env.VITE_CLOUD_OAUTH_RELAY_BASE_URL;

export type WorkBuddyCloudClient = ReturnType<typeof createWorkBuddyCloud>;

/**
 * 给每个云请求套超时：避免任一请求挂起导致 boot 永久不落（loading 卡住 → 无限转圈）。
 *
 * 取舍：
 * - 超时用 AbortSignal.timeout（现代浏览器 / Node 18+ 均可用）；
 * - 若调用方自带 signal，尽量与超时合并（AbortSignal.any）；该 API 不可用时**退化为仅 timeout**——
 *   牺牲外部取消能力，换取「绝不会永久挂起」这一硬保证（本例外部取消用得极少）。
 *
 * @param ms 超时毫秒；缺省取 CLOUD_REQUEST_TIMEOUT_MS（导出以便单测注入极短超时）。
 */
export function timeoutFetch(input: RequestInfo | URL, init?: RequestInit, ms: number = CLOUD_REQUEST_TIMEOUT_MS): Promise<Response> {
  const timeout = AbortSignal.timeout(ms);
  const signal =
    init?.signal && 'any' in AbortSignal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
  return fetch(input, { ...init, signal });
}

let cached: WorkBuddyCloudClient | null = null;

/** 云环境是否已配置（boot 层据此决定渲染引导页还是业务页） */
export function isCloudConfigured(): boolean {
  return Boolean(endpoint && publishableKey);
}

/**
 * 获取云客户端（懒初始化，单例）。
 * @throws 未配置 .env 时抛错 —— 提示按 .env.example 填入 publicConfig。
 */
export function getCloud(): WorkBuddyCloudClient {
  if (!endpoint || !publishableKey) {
    // 中文说明：WorkBuddy 云服务尚未开通或 .env 未配置。
    // 开通后把 publicConfig 的 endpoint / publishableKey / oauthRelayBaseUrl 填入 .env。
    throw new Error(
      'WorkBuddy cloud is not configured. Copy .env.example to .env and fill in ' +
        'VITE_CLOUD_ENDPOINT / VITE_CLOUD_PUBLISHABLE_KEY / VITE_CLOUD_OAUTH_RELAY_BASE_URL ' +
        'from the cloud-service publicConfig, then rebuild.',
    );
  }
  if (!cached) {
    cached = createWorkBuddyCloud({
      endpoint,
      publishableKey,
      ...(oauthRelayBaseUrl ? { oauthRelayBaseUrl } : {}),
      fetch: timeoutFetch,
    });
  }
  return cached;
}

/** 获取数据库模块（supabase-js 风格：from().select()... → { data, error }） */
export function getDb(): CloudDatabaseLike {
  return getCloud().database as unknown as CloudDatabaseLike;
}

// ===== Auth 薄封装（登录态检查等；具体登录 UI 在 T04/T05）=====

export interface CloudSessionInfo {
  signedIn: boolean;
  userId?: string;
}

/** 登录态检查（Auth Gate：用户数据读写前必须调用） */
export async function getSessionInfo(): Promise<CloudSessionInfo> {
  const cloud = getCloud();
  const { data, error } = await cloud.auth.getSession();
  if (error || !data) return { signedIn: false };
  return { signedIn: true, userId: data.user?.id };
}

/**
 * 发起 WorkBuddy 统一登录（PKCE）。返回授权页 URL，由调用方整体跳转。
 * redirectTo 缺省为当前页 origin + pathname（站点根即可，前端路由自己恢复状态）。
 */
export async function startWorkBuddySignIn(): Promise<string> {
  const cloud = getCloud();
  const { data, error } = await cloud.auth.signInWithOAuth({ provider: 'workbuddy' });
  if (error || !data?.url) {
    throw new Error(error?.message ?? 'WorkBuddy sign-in did not return an authorization URL');
  }
  return data.url;
}

/**
 * OAuth 落地兑换：用回调 URL 上的 code/state + 本地 PKCE verifier 换会话。
 *
 * ⚠ 必须在「登录守卫之前」无条件调用一次——否则守卫先把用户弹回登录页、
 * 顺手把 URL 上的 code/state 丢掉，表现就是「点了登录转一圈又回到登录页」。
 * 非 WorkBuddy 回调（普通访问/收藏页）时返回 null 数据，不算失败。
 */
export async function consumeWorkBuddyCallback(): Promise<void> {
  const cloud = getCloud();
  try {
    const { error } = await cloud.auth.handleWorkBuddyCallback();
    if (error) {
      console.warn('[auth] workbuddy callback exchange failed:', error.message);
      return;
    }
    // 兑换成功后清掉 URL 上的 code/state/provider，保留其余业务参数
    const url = new URL(window.location.href);
    if (url.searchParams.has('code') || url.searchParams.has('state') || url.searchParams.has('provider')) {
      url.searchParams.delete('code');
      url.searchParams.delete('state');
      url.searchParams.delete('provider');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch (e) {
    console.warn('[auth] consumeWorkBuddyCallback threw:', e instanceof Error ? e.message : String(e));
  }
}
