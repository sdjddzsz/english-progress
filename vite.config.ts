import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { copyFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 深链回退（站点无 SPA rewrite）。
 * 静态托管对 /book、/dashboard 这类深链会直接 404——目前只靠 Service Worker 的
 * navigateFallback 兜住，一旦清缓存 / 无痕 / 换设备首次打开就白给。
 * 构建后补两个通用兜底产物，不动部署方式（仍是 static）：
 *   - 404.html   ：多数静态服务器的未命中页（GitHub Pages 约定），URL 不变、SPA 照常接管路由
 *   - _redirects ：Netlify / Cloudflare Pages 风格的显式 rewrite
 */
function spaHistoryFallback(): Plugin {
  let outDir = 'dist';
  return {
    name: 'spa-history-fallback',
    configResolved(cfg) {
      outDir = cfg.build.outDir;
    },
    closeBundle() {
      const dir = resolve(process.cwd(), outDir);
      copyFileSync(resolve(dir, 'index.html'), resolve(dir, '404.html'));
      writeFileSync(resolve(dir, '_redirects'), '/*    /index.html   200\n');
    },
  };
}

/**
 * Vite 配置：React + MUI + Tailwind + vite-plugin-pwa。
 * PWA manifest 使用 public/manifest.webmanifest（架构文档 T01 产出要求），
 * 因此 vite-plugin-pwa 关闭内联 manifest，仅负责 Service Worker 预缓存。
 */
export default defineConfig({
  plugins: [
    react(),
    spaHistoryFallback(),
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
