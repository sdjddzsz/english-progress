/**
 * useLongPress.ts —— 长按手势（用户 2026-10-18：手机上没有右键，长按=编辑入口）。
 * 500ms 按住触发；抬手/移出/取消即撤销。桌面端顺手支持右键（contextmenu）。
 * ⚠ 只挂在该行释义上，别挂整页——长按滚动中的列表会误触。
 *
 * onLongPress 收一个可选参数 = 触发元素的 DOM 节点（供 Menu 锚定用；不需要的调用方忽略即可）。
 *
 * consumeFired（用户 2026-10-18 追加）：长按触发后，同一次手势的 click 还会照发——
 * 按钮同时挂 onClick 时会长按开完面板又触发一次单击动作。onClick 里先问一句
 * 「上一次手势是不是长按」，是则吞掉这次 click。
 */
import { useCallback, useEffect, useRef } from 'react';

export function useLongPress(onLongPress: (el?: HTMLElement) => void, ms = 500) {
  const timer = useRef<number | null>(null);
  const firedRef = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(
    (e: React.PointerEvent) => {
      // 鼠标只认左键；中键/右键不拦（右键走 contextmenu）
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      firedRef.current = false;
      clear();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        firedRef.current = true;
        onLongPress(e.currentTarget as HTMLElement);
      }, ms);
    },
    [ms, onLongPress, clear],
  );

  /** 消费「已触发长按」标记：返回 true 表示这次 click 应被抑制（并自动复位） */
  const consumeFired = useCallback(() => {
    const fired = firedRef.current;
    firedRef.current = false;
    return fired;
  }, []);

  useEffect(() => clear, [clear]);

  return {
    onPointerDown: start,
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      onLongPress(e.currentTarget as HTMLElement);
    },
    consumeFired,
  };
}
