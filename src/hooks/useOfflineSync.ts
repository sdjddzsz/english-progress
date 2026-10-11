/**
 * useOfflineSync.ts —— 离线补传 Hook（T05）：
 * 监听 online/offline 事件 + 轮询待补传条数；联网恢复自动 replayPendingOps。
 * UI（SyncStatusBanner）只读状态与手动补传动作。
 */
import { useCallback, useEffect, useState } from 'react';
import { isOnline } from '../data/queue';
import { countPendingOps, replayPendingOps, type ReplayResult } from '../offline/syncManager';
import { getRepos, useAppStore } from '../store/useAppStore';

export interface SyncState {
  online: boolean;
  pending: number;
  replaying: boolean;
  lastResult: ReplayResult | null;
}

export function useOfflineSync(): SyncState & { replayNow(): Promise<void> } {
  const cloudReady = useAppStore((s) => s.cloudReady);
  const [online, setOnline] = useState(isOnline());
  const [pending, setPending] = useState(0);
  const [replaying, setReplaying] = useState(false);
  const [lastResult, setLastResult] = useState<ReplayResult | null>(null);

  const refreshCount = useCallback(async () => {
    try {
      setPending(await countPendingOps());
    } catch {
      // IndexedDB 不可用（隐私模式等）时静默
    }
  }, []);

  const replayNow = useCallback(async () => {
    if (replaying || !isOnline()) return;
    setReplaying(true);
    try {
      const result = await replayPendingOps(getRepos());
      setLastResult(result);
      await refreshCount();
    } catch {
      // 仓库初始化失败（云未配置）：不计入状态
    } finally {
      setReplaying(false);
    }
  }, [replaying, refreshCount]);

  // 在线/离线事件 + 联网恢复自动补传
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOnline = () => {
      setOnline(true);
      void replayNow();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [replayNow]);

  // 周期对账（30s）：覆盖事件漏发场景
  useEffect(() => {
    if (!cloudReady) return;
    void refreshCount();
    const t = setInterval(() => {
      void refreshCount();
      if (isOnline() && pending > 0) void replayNow();
    }, 30_000);
    return () => clearInterval(t);
  }, [cloudReady, refreshCount, replayNow, pending]);

  return { online, pending, replaying, lastResult, replayNow };
}
