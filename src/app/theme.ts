import { createTheme } from '@mui/material/styles';

/**
 * MUI 主题 —— 两套口径的色板变量（架构文档 §1.3）：
 * - 学习口径（前台 Today/背单词/训练）：低刺激、无激励色；
 * - 诊断口径（后台 /dashboard、AI 方案）：允许数据密度更高的中性蓝灰。
 * 前台禁止出现打卡/圆环/烟花等激励型视觉（PRD §4.8.1）。
 */

/** 诊断口径色板（仅后台组件使用） */
export const diagnosisPalette = {
  primary: '#3949ab',
  surface: '#f5f6fa',
  warning: '#f9a825',
  danger: '#c62828',
  ok: '#2e7d32',
} as const;

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#1a237e' },
    secondary: { main: '#00695c' },
    background: { default: '#fafafa', paper: '#ffffff' },
    error: { main: '#c62828' },
    warning: { main: '#f9a825' },
    success: { main: '#2e7d32' },
  },
  typography: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  },
  shape: { borderRadius: 10 },
  components: {
    MuiBottomNavigation: {
      styleOverrides: {
        root: {
          // 移动端安全区
          paddingBottom: 'env(safe-area-inset-bottom)',
        },
      },
    },
  },
});
