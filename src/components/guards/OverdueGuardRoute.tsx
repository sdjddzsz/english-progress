/**
 * OverdueGuardRoute.tsx —— 欠账路由级拦截（T05，PRD 硬约束 #5 配套）：
 * mustReschedule 时，学习类路由（Today/Study/Training/听词联想/中→英）整页替换为
 * ReschedulePanel（standalone）；重排完成（overdue 回落阈值内）后自动放行。
 * 本组件同时兜底触发 bootstrap/refreshToday，确保欠账状态在任何直达路由下已加载。
 */
import { useEffect, type ReactNode } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { useAppStore } from '../../store/useAppStore';
import ReschedulePanel from '../plan/ReschedulePanel';

export default function OverdueGuardRoute({ children }: { children: ReactNode }) {
  const { overdue, cloudReady, error, bootstrap, refreshToday } = useAppStore();

  // 直达路由（刷新/外链）时兜底加载状态
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 已登录但欠账状态尚未计算：先刷新一次
  useEffect(() => {
    if (cloudReady && overdue == null && !error) {
      void refreshToday();
    }
  }, [cloudReady, overdue, error, refreshToday]);

  if (!cloudReady) {
    // 云未配置/未登录：放行到页面自身的引导态（Today/Settings 各有处理）
    return <>{children}</>;
  }
  if (overdue == null) {
    return (
      <Box p={6} textAlign="center">
        <CircularProgress />
      </Box>
    );
  }
  if (overdue.mustReschedule) {
    return <ReschedulePanel standalone />;
  }
  return <>{children}</>;
}
