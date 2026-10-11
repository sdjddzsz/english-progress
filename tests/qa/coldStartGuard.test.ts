/**
 * coldStartGuard.test.ts —— 冷启动回归锚点（QA Round 2 后部署期补测）。
 *
 * 线上事故：全新用户（无词书/无计划）首次打开首页，
 * OverdueGuardRoute 在 overdue==null 时无限转圈——因为 refreshToday
 * 在无 activePlan 时直接空返回，overdue 永远无法被计算。
 * 本测试锁死 guardDecision 的四条分支：无生效计划时守卫必须放行。
 */
import { describe, expect, it } from 'vitest';
import { guardDecision } from '../../src/components/guards/OverdueGuardRoute';

describe('OverdueGuardRoute 冷启动（无词书/无计划）', () => {
  it('云未配置：放行到页面引导态', () => {
    expect(guardDecision({ cloudReady: false, hasActivePlan: false, overdue: null })).toBe('pass');
    expect(guardDecision({ cloudReady: false, hasActivePlan: true, overdue: null })).toBe('pass');
  });

  it('云就绪但无生效计划：必须放行到页面引导态，不得转圈（本次线上事故回归锚点）', () => {
    expect(guardDecision({ cloudReady: true, hasActivePlan: false, overdue: null })).toBe('pass');
  });

  it('云就绪且有生效计划、欠账尚未计算：短暂转圈等待计算', () => {
    expect(guardDecision({ cloudReady: true, hasActivePlan: true, overdue: null })).toBe('spinner');
  });

  it('欠账已计算：未超阈值放行，超阈值强制重排面板', () => {
    expect(guardDecision({ cloudReady: true, hasActivePlan: true, overdue: { mustReschedule: false } })).toBe('pass');
    expect(guardDecision({ cloudReady: true, hasActivePlan: true, overdue: { mustReschedule: true } })).toBe('panel');
  });
});
