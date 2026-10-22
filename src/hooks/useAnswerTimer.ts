/**
 * useAnswerTimer.ts —— 考查计时 hook（用户 2026-10-19：出题即走秒，答题即停）。
 *
 * startedAt：本题出题时间戳（Date.now()）。running：是否正在计时
 * （未答才为 true；答题/回顾已答题/离开题卡都会停）。
 * 每 tickMs 刷新一次；停止后定格显示 frozenMs（答题那一刻算出的用时），
 * frozenMs 为 null 表示没有留下用时记录（旧快照），调用方自行显示「未记录」。
 *
 * 注意：startedAt 变化（换题）时 effect 重建，节奏重新对齐；running 由
 * false→true 时先立刻 setNow 一次，避免沿用上一题的 now 显示出「秒表倒跳」。
 */
import { useEffect, useState } from 'react';

export function useAnswerTimer(
  startedAt: number,
  running: boolean,
  frozenMs: number | null,
  tickMs = 200,
): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [running, startedAt, tickMs]);
  if (!running) return Math.max(0, frozenMs ?? 0);
  return Math.max(0, now - startedAt);
}
