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
import type { CloudDatabaseLike } from './repository';

const endpoint = import.meta.env.VITE_CLOUD_ENDPOINT;
const publishableKey = import.meta.env.VITE_CLOUD_PUBLISHABLE_KEY;
const oauthRelayBaseUrl = import.meta.env.VITE_CLOUD_OAUTH_RELAY_BASE_URL;

export type WorkBuddyCloudClient = ReturnType<typeof createWorkBuddyCloud>;

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
