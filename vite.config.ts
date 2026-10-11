import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Vite 配置：React + MUI + Tailwind + vite-plugin-pwa。
 * PWA manifest 使用 public/manifest.webmanifest（架构文档 T01 产出要求），
 * 因此 vite-plugin-pwa 关闭内联 manifest，仅负责 Service Worker 预缓存。
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['manifest.webmanifest', 'icons/icon.svg'],
      manifest: false, // manifest 由 public/manifest.webmanifest 提供
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'],
        // espeak WASM 兜底轨约 2MB，放宽单文件预缓存上限
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
  build: {
    target: 'es2020',
    sourcemap: false,
  },
  test: {
    environment: 'node', // 调度器与数据层测试均为纯 Node 环境（Dexie 用 fake-indexeddb）
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
