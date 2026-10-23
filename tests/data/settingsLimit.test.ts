/**
 * settingsLimit.test.ts —— 每日考查词量设置（用户 2026-10-15 拍板：默认 300，可调 50–1000）。
 * 背景：原硬编码 50/天被用户抓出来不合理（8296 词铺完要 166 天 > 考试窗口 58 天）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import { QUIZ_DAILY_LIMIT_DEFAULT, QUIZ_DAILY_LIMIT_MAX, QUIZ_DAILY_LIMIT_MIN } from '../../src/config/constants';

describe('quizDailyLimit：默认 300，clamp 50–1000', () => {
  beforeEach(() => {
    // 重置到默认（persist 在 node 无 localStorage，仅内存态）
    useSettingsStore.setState({ quizDailyLimit: QUIZ_DAILY_LIMIT_DEFAULT });
  });

  it('默认值 = 300', () => {
    expect(QUIZ_DAILY_LIMIT_DEFAULT).toBe(300);
    expect(useSettingsStore.getState().quizDailyLimit).toBe(300);
  });

  it('边界内正常设置', () => {
    useSettingsStore.getState().setQuizDailyLimit(150);
    expect(useSettingsStore.getState().quizDailyLimit).toBe(150);
  });

  it('低于下限夹到 50', () => {
    useSettingsStore.getState().setQuizDailyLimit(10);
    expect(useSettingsStore.getState().quizDailyLimit).toBe(QUIZ_DAILY_LIMIT_MIN);
  });

  it('高于上限夹到 1000', () => {
    useSettingsStore.getState().setQuizDailyLimit(5000);
    expect(useSettingsStore.getState().quizDailyLimit).toBe(QUIZ_DAILY_LIMIT_MAX);
  });
});

describe('firstPassThreshold：首答即过关挡位（用户 2026-10-23 拆线）', () => {
  it('默认 = strict（首答熟练才算一遍过；旧设备无持久化字段时也落这条）', () => {
    expect(useSettingsStore.getState().firstPassThreshold).toBe('strict');
  });

  it('可设置且与轮标线挡位互不影响', () => {
    useSettingsStore.getState().setFirstPassThreshold('standard');
    useSettingsStore.getState().setQuizDayThreshold('strict');
    const s = useSettingsStore.getState();
    expect(s.firstPassThreshold).toBe('standard');
    expect(s.quizDayThreshold).toBe('strict');
  });
});
