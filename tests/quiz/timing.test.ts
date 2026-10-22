/**
 * timing.test.ts —— 考查计时展示（用户 2026-10-19）。
 * formatElapsedMs：毫秒 → 秒字符串；TIMING_HINT 与 judging.ts 档位同源。
 */
import { describe, expect, it } from 'vitest';
import { formatElapsedMs, TIMING_HINT } from '../../src/features/quiz/timing';
import { QUIZ_MS_INSTANT, QUIZ_MS_RECOGNIZED, QUIZ_MS_UNFAMILIAR } from '../../src/features/quiz/judging';

describe('formatElapsedMs', () => {
  it('秒级一位小数', () => {
    expect(formatElapsedMs(0)).toBe('0.0s');
    expect(formatElapsedMs(3200)).toBe('3.2s');
    expect(formatElapsedMs(7500)).toBe('7.5s');
  });

  it('≥60s 带分钟', () => {
    expect(formatElapsedMs(61_000)).toBe('1m1.0s');
    expect(formatElapsedMs(125_400)).toBe('2m5.4s');
  });

  it('脏值兜底为 0.0s（不给用户看 NaN/-1）', () => {
    expect(formatElapsedMs(-5)).toBe('0.0s');
    expect(formatElapsedMs(Number.NaN)).toBe('0.0s');
    expect(formatElapsedMs(Number.POSITIVE_INFINITY)).toBe('0.0s');
  });
});

describe('TIMING_HINT：与判定档位同口径', () => {
  it('包含三档秒数提示', () => {
    expect(TIMING_HINT).toContain(`${QUIZ_MS_INSTANT / 1000} 秒内选对=熟练`);
    expect(TIMING_HINT).toContain(`${QUIZ_MS_RECOGNIZED / 1000} 秒内=认识`);
    expect(TIMING_HINT).toContain(`${QUIZ_MS_UNFAMILIAR / 1000} 秒内=不熟`);
    expect(TIMING_HINT).toContain('超时或选错=生词');
  });
});
