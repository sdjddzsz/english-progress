import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 深链回退（站点由 Python http.server 托管，无 SPA rewrite）。
 * 实测平台静态服务就是 `python3 -m http.server`：对目录会先 301 补斜杠、再取目录内
 * index.html（已验证 /icons → 301 → /icons/ → 200），但**不认 404.html**（/book 直接 404）。
 * 因此按路由预生成「同名目录 + index.html」，深链即可命中：
 *   /book → 301 → /book/ → book/index.html（SPA 入口）
 * React Router 默认 strict:false，末尾斜杠不影响匹配。
 * 保留 404.html 作为换托管环境时的通用兜底。
 */
const SPA_ROUTES = [
  'study',
  'training',
  'training/audio',
  'training/cn2en',
  'training/spelling',
  'book',
  'plan-editor',
  'placement',
  'search',
  'bookmarks',
  'dashboard',
  'dashboard/diag',
  'mock',
  'ai-plan',
  'settings',
  // 四阶段制（2026-10-15）：这三条路由上线时漏补，导致 /quiz、/stage/1 深链 404
  // （stage-quiz/1 虽重定向 /quiz，但重定向前 HTML 也要能加载，一并补）
  'quiz',
  'stage',
  'stage/1',
  'stage/2',
  'stage/3',
  'stage/4',
  'stage-quiz',
  'stage-quiz/1',
  'stage-quiz/2',
  'stage-quiz/3',
  'stage-quiz/4',
];

function spaHistoryFallback(): Plugin {
  let outDir = 'dist';
  return {
    name: 'spa-history-fallback',
    configResolved(cfg) {
      outDir = cfg.build.outDir;
    },
    closeBundle() {
      const dir = resolve(process.cwd(), outDir);
      const entry = resolve(dir, 'index.html');
      const html = readFileSync(entry);
      copyFileSync(entry, resolve(dir, '404.html'));
      for (const route of SPA_ROUTES) {
        const target = resolve(dir, route);
        mkdirSync(target, { recursive: true });
        writeFileSync(resolve(target, 'index.html'), html);
      }
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
    // 沙箱的 node-safe-delete-shim 会把 Vite 的 emptyDir（清空 dist）判为批量删除并报
    // SAFE_DELETE_BULK_GUARD_ERROR（2026-10-15 实测：build 连续两次挂在清 dist 这一步）。
    // dist 是构建产物目录（非个人文件），此处关闭自动清空，改由脚本手动清理；
    // 旧 chunk 残留无害（index.html 引用新 hash），发布前 ensure_clean_dist 兜底。
    emptyOutDir: false,
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
