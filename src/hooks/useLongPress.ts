/**
 * useLongPress.ts —— 长按手势（用户 2026-10-18：手机上没有右键，长按=编辑入口）。
 * 500ms 按住触发；抬手/移出/取消即撤销。桌面端顺手支持右键（contextmenu）。
 * ⚠ 只挂在该行释义上，别挂整页——长按滚动中的列表会误触。
 */
import { useCallback, useEffect, useRef } from 'react';

export function useLongPress(onLongPress: () => void, ms = 500) {
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
        onLongPress();
      }, ms);
    },
    [ms, onLongPress, clear],
  );

  useEffect(() => clear, [clear]);

  return {
    onPointerDown: start,
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      onLongPress();
    },
  };
}
