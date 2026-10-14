/**
 * useSfx.ts —— 答题音效的统一入口：自动遵循设置里的开关。
 *
 * 页面只写 `const sfx = useSfx(); sfx('correct')`，
 * 不关心"开关是否打开""AudioContext 是否可用"——这些都在 audio/sfx 与这里收口。
 */
import { useCallback } from 'react';
import { playSfx, type SfxKind } from '../audio/sfx';
import { useSettingsStore } from '../store/useSettingsStore';

export function useSfx(): (kind: SfxKind) => void {
  const enabled = useSettingsStore((s) => s.sfxEnabled);
  return useCallback(
    (kind: SfxKind) => {
      if (!enabled) return;
      playSfx(kind);
    },
    [enabled],
  );
}
