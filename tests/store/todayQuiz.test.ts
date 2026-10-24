/**
 * todayQuiz.test.ts —— 今日检测统计的 store 语义（用户 2026-10-23 建，2026-10-24 改口径）。
 *
 * 钉死两件事：
 *  1. **firstSeen 口径 = 有史以来第一次露面（答题前该词 firstSeenAt 为空）**，
 *     不是「本轮第一次露面（attemptNo===1）」。昨天首答的词今天新一轮再露面：
 *     本机不计、云端（firstSeenAt=昨天）也不计 ⇒ 刷新后数字不回落。
 *     旧实现的症状：本机 attemptNo===1 算 firstSeen，刷新后被云端口径顶掉 ⇒ 首页数字跳水。
 *  2. words/firstSeen 两个集合：本机当场累加 + 云端播种（seedTodayQuiz）合并去重不双算；
 *     UTC 日变自动清零（当天有效，不跨天）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';

const state = () => useAppStore.getState().todayQuiz;

beforeEach(() => {
  // store 是模块级单例：每个用例先按「昨天的记忆」起底（noteQuizAnswer/seedTodayQuiz
  // 发现 day 不匹配就会整表重置，等价于跨天清零，顺便覆盖那条路径）
  useAppStore.setState({ todayQuiz: { day: '2000-01-01', words: [], firstSeen: [] } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('noteQuizAnswer：firstSeen 口径（2026-10-24 统一为「有史以来首露」）', () => {
  it('firstEver=true（答题前无 firstSeenAt）⇒ 计入 firstSeen；words 总计入', () => {
    useAppStore.getState().noteQuizAnswer('w1', true);
    expect(state().words).toEqual(['w1']);
    expect(state().firstSeen).toEqual(['w1']);
  });

  it('firstEver=false（昨天/更早首答过）⇒ 只计入 words，不计 firstSeen', () => {
    // 真实场景：该词 firstSeenAt=昨天，今天新一轮 attemptNo=1 再露面——
    // 旧实现按 attemptNo===1 会算 firstSeen，与云端 firstSeenAt 口径冲突（刷新回落）
    useAppStore.getState().noteQuizAnswer('w1', false);
    expect(state().words).toEqual(['w1']);
    expect(state().firstSeen).toEqual([]);
  });

  it('同词当轮多次露面（attemptNo 2/3…，本地 firstSeenAt 副本未更新）⇒ 不双算', () => {
    useAppStore.getState().noteQuizAnswer('w1', true);
    useAppStore.getState().noteQuizAnswer('w1', true); // 第二次露面：集合去重
    useAppStore.getState().noteQuizAnswer('w1', true);
    expect(state().words).toEqual(['w1']);
    expect(state().firstSeen).toEqual(['w1']);
  });

  it('首露 + 再露面混合：firstSeen 只留第一个', () => {
    useAppStore.getState().noteQuizAnswer('w1', true);
    useAppStore.getState().noteQuizAnswer('w1', false);
    useAppStore.getState().noteQuizAnswer('w2', false);
    expect(state().words).toEqual(['w1', 'w2']);
    expect(state().firstSeen).toEqual(['w1']);
  });
});

describe('seedTodayQuiz：云端播种与本机累加合并去重', () => {
  it('云端播过的词本机再答不双算（两个集合都去重）', () => {
    useAppStore.getState().seedTodayQuiz({ wordIds: ['w1', 'w2'], firstSeenIds: ['w1'] });
    useAppStore.getState().noteQuizAnswer('w1', true); // 云端已算过 firstSeen
    useAppStore.getState().noteQuizAnswer('w3', true);
    expect(state().words).toEqual(['w1', 'w2', 'w3']);
    expect(state().firstSeen).toEqual(['w1', 'w3']);
  });

  it('空播种直接返回，不动本机已累加的数据', () => {
    useAppStore.getState().noteQuizAnswer('w1', true);
    useAppStore.getState().seedTodayQuiz({ wordIds: [], firstSeenIds: [] });
    expect(state().words).toEqual(['w1']);
    expect(state().firstSeen).toEqual(['w1']);
  });
});

describe('UTC 日变：当天有效，不跨天', () => {
  it('换一天后旧数据不带入（todayQuiz.day 不匹配即整表重置）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    useAppStore.getState().noteQuizAnswer('w1', true);
    expect(state()).toEqual({ day: '2026-10-25', words: ['w1'], firstSeen: ['w1'] });

    vi.setSystemTime(new Date('2026-10-26T00:30:00Z')); // UTC 已过零点
    useAppStore.getState().noteQuizAnswer('w2', false);
    expect(state()).toEqual({ day: '2026-10-26', words: ['w2'], firstSeen: [] });
  });
});
