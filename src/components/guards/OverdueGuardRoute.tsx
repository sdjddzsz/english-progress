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
  const activePlan = useAppStore((s) => s.activePlan);

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

  const decision = guardDecision({ cloudReady, hasActivePlan: activePlan != null, overdue });
  if (decision === 'spinner') {
    return (
      <Box p={6} textAlign="center">
        <CircularProgress />
      </Box>
    );
  }
  if (decision === 'panel') {
    return <ReschedulePanel standalone />;
  }
  return <>{children}</>;
}

/** 守卫决策（纯函数，可单测）：pass=放行页面引导态 / spinner=等待欠账计算 / panel=强制重排 */
export type GuardDecision = 'pass' | 'spinner' | 'panel';

export function guardDecision(input: {
  cloudReady: boolean;
  hasActivePlan: boolean;
  overdue: { mustReschedule: boolean } | null;
}): GuardDecision {
  const { cloudReady, hasActivePlan, overdue } = input;
  if (!cloudReady) return 'pass'; // 云未配置/未登录：放行到页面自身引导态
  if (overdue == null) {
    // ⚠ 无生效计划时 refreshToday 直接空返回，overdue 永远不会被计算——
    // 此时欠账守卫无数据可守，放行到页面自身的引导态（"还没有生效中的计划"等），
    // 否则新用户在冷启动路径上被永久卡在加载态。
    if (!hasActivePlan) return 'pass';
    return 'spinner';
  }
  return overdue.mustReschedule ? 'panel' : 'pass';
}
