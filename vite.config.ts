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
        // T05：espeak-ng WASM/词典改为运行时懒加载，移出预缓存（glob v8 不支持 ! 负模式，用 globIgnores）
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'],
        globIgnores: ['**/espeak-engine-*.js', '**/*.wasm', '**/*.data'],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        // meSpeak（espeak 兜底轨）单独分包：动态 import 已懒加载，配合 workbox 排除项不进 precache
        manualChunks(id: string) {
          if (id.includes('node_modules/mespeak')) return 'espeak-engine';
        },
      },
    },
  },
  test: {
    environment: 'node', // 调度器与数据层测试均为纯 Node 环境（Dexie 用 fake-indexeddb）
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
