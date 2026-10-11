/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** 云数据面基础 URL（来自云服务 publicConfig.endpoint） */
  readonly VITE_CLOUD_ENDPOINT?: string;
  /** 应用标识 key（来自云服务 publicConfig.publishableKey） */
  readonly VITE_CLOUD_PUBLISHABLE_KEY?: string;
  /** OAuth Relay 基础 URL（微信扫码登录用，可缺省） */
  readonly VITE_CLOUD_OAUTH_RELAY_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
