/**
 * timing.ts —— 考查计时展示（用户 2026-10-19：每个单词考查时显示计时，答题后停止计时）。
 * 与 judging.ts 的判定档位同源口径：毫秒进来，秒字符串出去。
 *
 * 纯函数、零 IO、零 React 依赖（hook 与组件共用，测试可直跑）。
 */
import { QUIZ_MS_INSTANT, QUIZ_MS_RECOGNIZED, QUIZ_MS_UNFAMILIAR } from './judging';

/** 毫秒 → "12.3s"（一位小数；≥60s 带分钟，防止长考时位数无限增长） */
export function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}m${s.toFixed(1)}s`;
}

/** 计时徽标副文案：与判定档位一致的一句话（≤3s 熟练 / ≤5s 认识 / ≤7s 不熟 / 其余生词） */
export const TIMING_HINT =
  `${QUIZ_MS_INSTANT / 1000} 秒内选对=熟练 · ${QUIZ_MS_RECOGNIZED / 1000} 秒内=认识 · ` +
  `${QUIZ_MS_UNFAMILIAR / 1000} 秒内=不熟 · 超时或选错=生词`;
