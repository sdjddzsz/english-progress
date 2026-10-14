/**
 * judging.test.ts —— 考查制判定规则（用户 2026-10-14 定案）逐条钉死。
 */
import { describe, expect, it } from 'vitest';
import {
  QUIZ_GRADUATE_STREAK,
  QUIZ_SPECIAL_TRAINING_FAILS,
  failStreakAfterVerdict,
  judgeAnswer,
  shouldQuizToday,
  specialTrainingAfter,
  streakAfterVerdict,
  tierAfterVerdict,
} from '../../src/features/quiz/judging';

describe('judgeAnswer：用时 + 对错 → 四档', () => {
  it('1 秒内选对 = 熟练', () => {
    expect(judgeAnswer(0, true)).toBe('skilled');
    expect(judgeAnswer(999, true)).toBe('skilled');
    expect(judgeAnswer(1000, true)).toBe('skilled');
  });
  it('1-3 秒选对 = 认识', () => {
    expect(judgeAnswer(1001, true)).toBe('recognized');
    expect(judgeAnswer(3000, true)).toBe('recognized');
  });
  it('3-5 秒选对 = 不熟', () => {
    expect(judgeAnswer(3001, true)).toBe('unfamiliar');
    expect(judgeAnswer(5000, true)).toBe('unfamiliar');
  });
  it('超过 5 秒 = 生词（哪怕选对）', () => {
    expect(judgeAnswer(5001, true)).toBe('unknown');
  });
  it('选错永远是生词（哪怕 0.1 秒就点）', () => {
    expect(judgeAnswer(100, false)).toBe('unknown');
  });
});

describe('streak：只有熟练累加，其余清零（「连续」才作数）', () => {
  it('熟练 +1', () => {
    expect(streakAfterVerdict(0, 'skilled')).toBe(1);
    expect(streakAfterVerdict(4, 'skilled')).toBe(5);
  });
  it('认识/不熟/生词都清零', () => {
    expect(streakAfterVerdict(4, 'recognized')).toBe(0);
    expect(streakAfterVerdict(4, 'unfamiliar')).toBe(0);
    expect(streakAfterVerdict(4, 'unknown')).toBe(0);
  });
});

describe('tier：熟练升层、生词降层、认识/不熟维持', () => {
  it('熟练：2→1（1 封顶）', () => {
    expect(tierAfterVerdict(2, 'skilled')).toBe(1);
    expect(tierAfterVerdict(1, 'skilled')).toBe(1);
  });
  it('生词：3→4（4 兜底）', () => {
    expect(tierAfterVerdict(3, 'unknown')).toBe(4);
    expect(tierAfterVerdict(4, 'unknown')).toBe(4);
  });
  it('认识与不熟维持原层', () => {
    expect(tierAfterVerdict(3, 'recognized')).toBe(3);
    expect(tierAfterVerdict(3, 'unfamiliar')).toBe(3);
  });
});

describe('failStreak 与特种训练', () => {
  it('不熟/生词累加，熟练/认识清零', () => {
    expect(failStreakAfterVerdict(2, 'unknown')).toBe(3);
    expect(failStreakAfterVerdict(2, 'unfamiliar')).toBe(3);
    expect(failStreakAfterVerdict(2, 'skilled')).toBe(0);
    expect(failStreakAfterVerdict(2, 'recognized')).toBe(0);
  });
  it(`连续不熟/生词 ≥${QUIZ_SPECIAL_TRAINING_FAILS} 进入特种训练`, () => {
    expect(specialTrainingAfter(2, 0, false)).toBe(false);
    expect(specialTrainingAfter(3, 0, false)).toBe(true);
    // 曾在特种训练的词，failStreak 清零后仍保持（直到毕业解除）
    expect(specialTrainingAfter(0, 2, true)).toBe(true);
  });
  it('毕业（连续熟练达标）解除特种训练', () => {
    expect(specialTrainingAfter(5, QUIZ_GRADUATE_STREAK, true)).toBe(false);
  });
});

describe('shouldQuizToday：频率（越生疏越勤）+ 特种训练必考 + 毕业出池', () => {
  const now = new Date('2026-10-14T12:00:00+08:00');
  const daysAgo = (n: number): string =>
    new Date(now.getTime() - n * 86400000).toISOString();

  it('从没考过的词必考', () => {
    expect(shouldQuizToday({ tier: 4, streak: 0, specialTraining: false }, now)).toBe(true);
  });
  it('毕业词（streak≥5）不再出现', () => {
    expect(
      shouldQuizToday({ tier: 1, streak: 5, specialTraining: false, lastQuizAt: daysAgo(0) }, now),
    ).toBe(false);
  });
  it('T4 每天都能考（间隔 1）：昨天考过今天还能考，同日不重复', () => {
    expect(
      shouldQuizToday({ tier: 4, streak: 2, specialTraining: false, lastQuizAt: daysAgo(1) }, now),
    ).toBe(true);
    expect(
      shouldQuizToday({ tier: 4, streak: 2, specialTraining: false, lastQuizAt: daysAgo(0) }, now),
    ).toBe(false);
  });
  it('T3 隔天考：昨天考过今天不考，前天考过今天考', () => {
    expect(
      shouldQuizToday({ tier: 3, streak: 2, specialTraining: false, lastQuizAt: daysAgo(1) }, now),
    ).toBe(false);
    expect(
      shouldQuizToday({ tier: 3, streak: 2, specialTraining: false, lastQuizAt: daysAgo(2) }, now),
    ).toBe(true);
  });
  it('T1 四天一考', () => {
    expect(
      shouldQuizToday({ tier: 1, streak: 3, specialTraining: false, lastQuizAt: daysAgo(3) }, now),
    ).toBe(false);
    expect(
      shouldQuizToday({ tier: 1, streak: 3, specialTraining: false, lastQuizAt: daysAgo(4) }, now),
    ).toBe(true);
  });
  it('特种训练每天必考，但同日不重复（中断重进不会立刻重出刚答过的词）', () => {
    expect(
      shouldQuizToday({ tier: 2, streak: 1, specialTraining: true, lastQuizAt: daysAgo(1) }, now),
    ).toBe(true);
    expect(
      shouldQuizToday({ tier: 2, streak: 1, specialTraining: true, lastQuizAt: daysAgo(0) }, now),
    ).toBe(false);
  });
  it('特种训练但已毕业 → 不考', () => {
    expect(
      shouldQuizToday({ tier: 2, streak: 5, specialTraining: true, lastQuizAt: daysAgo(0) }, now),
    ).toBe(false);
  });
});
