import type { Config } from 'tailwindcss';

/**
 * Tailwind 仅做布局微调（架构文档 §1.3）；组件库主体为 MUI，
 * 主题色板统一由 src/app/theme.ts 管理。
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      spacing: {
        // 移动端优先的安全区
        'safe-bottom': 'env(safe-area-inset-bottom)',
      },
    },
  },
  plugins: [],
  // 与 postcss.config.js 内联保持一致（架构文档 T01：tailwind.config.ts 含 postcss 内联配置）
  // postcss 配置独立放置于 postcss.config.js，此处不重复。
} satisfies Config;
