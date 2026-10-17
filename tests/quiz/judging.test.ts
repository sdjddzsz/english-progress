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

describe('judgeAnswer：用时 + 对错 → 四档（用户 2026-10-15 放宽：熟练 ≤3s，各档 +2s）', () => {
  it('3 秒内选对 = 熟练', () => {
    expect(judgeAnswer(0, true)).toBe('skilled');
    expect(judgeAnswer(2999, true)).toBe('skilled');
    expect(judgeAnswer(3000, true)).toBe('skilled');
  });
  it('3-5 秒选对 = 认识', () => {
    expect(judgeAnswer(3001, true)).toBe('recognized');
    expect(judgeAnswer(5000, true)).toBe('recognized');
  });
  it('5-7 秒选对 = 不熟', () => {
    expect(judgeAnswer(5001, true)).toBe('unfamiliar');
    expect(judgeAnswer(7000, true)).toBe('unfamiliar');
  });
  it('超过 7 秒 = 生词（哪怕选对）', () => {
    expect(judgeAnswer(7001, true)).toBe('unknown');
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

// ===== 当天小循环三档（用户 2026-10-14）=====
import {
  QUIZ_DAY_PASS_COUNT,
  dayVerdictOk,
  isDayPassedToday,
  isSameUtcDay,
  quizDayStreakAfter,
  roundRelease,
  tierAfterQuiz,
} from '../../src/features/quiz/judging';

describe('当天过关三档：连续 3 次达线', () => {
  it('宽松线 = 至少不熟（unfamiliar 及以上算过）', () => {
    expect(dayVerdictOk('unfamiliar', 'lenient')).toBe(true);
    expect(dayVerdictOk('recognized', 'lenient')).toBe(true);
    expect(dayVerdictOk('skilled', 'lenient')).toBe(true);
    expect(dayVerdictOk('unknown', 'lenient')).toBe(false);
  });
  it('适当线 = 至少认识', () => {
    expect(dayVerdictOk('recognized', 'standard')).toBe(true);
    expect(dayVerdictOk('unfamiliar', 'standard')).toBe(false);
    expect(dayVerdictOk('unknown', 'standard')).toBe(false);
  });
  it('严格线 = 至少熟练', () => {
    expect(dayVerdictOk('skilled', 'strict')).toBe(true);
    expect(dayVerdictOk('recognized', 'strict')).toBe(false);
  });
  it('连续达标累加、一次不达标清零', () => {
    expect(quizDayStreakAfter(1, 'skilled', 'strict')).toBe(2);
    expect(quizDayStreakAfter(2, 'skilled', 'strict')).toBe(QUIZ_DAY_PASS_COUNT);
    expect(quizDayStreakAfter(2, 'recognized', 'strict')).toBe(0);
    expect(quizDayStreakAfter(2, 'unknown', 'lenient')).toBe(0);
  });
  it('宽松档 3 次不熟即可过关', () => {
    let n = 0;
    n = quizDayStreakAfter(n, 'unfamiliar', 'lenient');
    n = quizDayStreakAfter(n, 'unfamiliar', 'lenient');
    expect(quizDayStreakAfter(n, 'unfamiliar', 'lenient')).toBe(3);
  });
});

// ===== 每轮放行（用户 2026-10-15：放行机制必须匹配设置页「每轮过关挡位」，
// 旧规则「答对一次就放行」已废弃）=====
describe('roundRelease：连续达标才放行，晋级/毕业立即放行', () => {
  const now = new Date('2026-10-15T20:00:00+08:00');
  const todayIso = now.toISOString();
  const yestIso = new Date(now.getTime() - 86400000).toISOString();

  it('一次达标远没到线：不放行', () => {
    const r = roundRelease({
      verdict: 'skilled',
      prevStreak: 0,
      threshold: 'strict',
      leftStage: false,
      lastQuizAt: todayIso,
      now,
    });
    expect(r.dayStreak).toBe(1);
    expect(r.release).toBe(false);
  });

  it('连续 3 次达标（严格档）→ 第 3 次放行', () => {
    let streak = 0;
    let release = false;
    for (let i = 0; i < 3; i++) {
      const r = roundRelease({
        verdict: 'skilled',
        prevStreak: streak,
        threshold: 'strict',
        leftStage: false,
        lastQuizAt: todayIso,
        now,
      });
      streak = r.dayStreak;
      release = r.release;
    }
    expect(streak).toBe(QUIZ_DAY_PASS_COUNT);
    expect(release).toBe(true);
  });

  it('中途一次没到达标线 → 计数清零、继续关着', () => {
    const r = roundRelease({
      verdict: 'recognized',
      prevStreak: 2,
      threshold: 'strict',
      leftStage: false,
      lastQuizAt: todayIso,
      now,
    });
    expect(r.dayStreak).toBe(0);
    expect(r.release).toBe(false);
  });

  it('晋级/毕业（离开本阶段）→ 不论计数立即放行', () => {
    const r = roundRelease({
      verdict: 'skilled',
      prevStreak: 0,
      threshold: 'strict',
      leftStage: true,
      lastQuizAt: todayIso,
      now,
    });
    expect(r.dayStreak).toBe(1);
    expect(r.release).toBe(true);
  });

  it('跨天：昨天累计的 2 次不作数，今天从 0 重新起算', () => {
    const r = roundRelease({
      verdict: 'skilled',
      prevStreak: 2,
      threshold: 'strict',
      leftStage: false,
      lastQuizAt: yestIso,
      now,
    });
    expect(r.dayStreak).toBe(1);
    expect(r.release).toBe(false);
  });

  it('本轮首答即熟练 → 一遍过，立即放行（用户 2026-10-17）', () => {
    const r = roundRelease({
      verdict: 'skilled',
      prevStreak: 0,
      threshold: 'strict',
      leftStage: false,
      attemptNo: 1,
      lastQuizAt: todayIso,
      now,
    });
    expect(r.release).toBe(true);
  });

  it('首答但只到「认识」（适当档线）→ 不放行，仍要连续 3 次', () => {
    const r = roundRelease({
      verdict: 'recognized',
      prevStreak: 0,
      threshold: 'standard',
      leftStage: false,
      attemptNo: 1,
      lastQuizAt: todayIso,
      now,
    });
    expect(r.dayStreak).toBe(1);
    expect(r.release).toBe(false);
  });

  it('第 2 次起即使熟练也要按连续 3 次走（首答规则只算第 1 次）', () => {
    const r = roundRelease({
      verdict: 'skilled',
      prevStreak: 1,
      threshold: 'strict',
      leftStage: false,
      attemptNo: 2,
      lastQuizAt: todayIso,
      now,
    });
    expect(r.dayStreak).toBe(2);
    expect(r.release).toBe(false);
    const r2 = roundRelease({
      verdict: 'skilled',
      prevStreak: 2,
      threshold: 'strict',
      leftStage: false,
      attemptNo: 3,
      lastQuizAt: todayIso,
      now,
    });
    expect(r2.release).toBe(true);
  });

  it('宽松档：3 次「不熟」也放行（挡位低但同样要连续 3 次）', () => {
    let streak = 0;
    let release = false;
    for (let i = 0; i < 3; i++) {
      const r = roundRelease({
        verdict: 'unfamiliar',
        prevStreak: streak,
        threshold: 'lenient',
        leftStage: false,
        lastQuizAt: todayIso,
        now,
      });
      streak = r.dayStreak;
      release = r.release;
    }
    expect(release).toBe(true);
  });
});

describe('isDayPassedToday：只对当天有效，隔夜失效', () => {
  const now = new Date('2026-10-14T20:00:00+08:00');
  it('当天过关 → true', () => {
    expect(
      isDayPassedToday({ quizDayPassed: true, lastQuizAt: now.toISOString() }, now),
    ).toBe(true);
  });
  it('昨天过关 → false（隔夜失效，明天重新按档位过）', () => {
    expect(
      isDayPassedToday(
        { quizDayPassed: true, lastQuizAt: new Date(now.getTime() - 86400000).toISOString() },
        now,
      ),
    ).toBe(false);
  });
  it('没过关 → false', () => {
    expect(isDayPassedToday({ quizDayPassed: false }, now)).toBe(false);
  });
});

describe('tierAfterQuiz：总计划排次只看当天第一次判定', () => {
  it('当天第一次判定：按判定升/降档', () => {
    expect(tierAfterQuiz(3, 'skilled', true)).toBe(2);
    expect(tierAfterQuiz(3, 'unknown', true)).toBe(4);
  });
  it('当天后续判定：tier 冻结（不被当天最终熟悉度影响）', () => {
    expect(tierAfterQuiz(3, 'skilled', false)).toBe(3);
    expect(tierAfterQuiz(4, 'unknown', false)).toBe(4);
  });
});

describe('isSameUtcDay', () => {
  it('同日为 true、跨日为 false、空/脏值为 false', () => {
    const now = new Date('2026-10-14T12:00:00+08:00');
    expect(isSameUtcDay(now.toISOString(), now)).toBe(true);
    expect(isSameUtcDay(new Date(now.getTime() - 86400000).toISOString(), now)).toBe(false);
    expect(isSameUtcDay(undefined, now)).toBe(false);
    expect(isSameUtcDay('not-a-date', now)).toBe(false);
  });
});
