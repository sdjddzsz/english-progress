/**
 * stagePace.test.ts —— 四阶段真实节奏与完成预估（用户 2026-10-23 选「方案 2」）。
 *
 * 背景：首页计划卡原来显示 tier 模型预估（Σ词数×轮次 ÷ 窗口 × 秒数），四阶段用户身上
 * 是持续误报（红线常年亮）。改为按 book_words.lastQuizAt 的真实节奏推算。
 * 数据源事实：每次答题都写 lastQuizAt（考查页也写），refreshToday 已拉全表，零额外请求。
 */
import { describe, expect, it } from 'vitest';
import { computeStagePace, paceVerdict, projectStageFinish } from '../../src/features/quiz/stagePace';
import type { BookWord } from '../../src/types/domain';

const NOW = new Date('2026-10-23T10:00:00.000Z');
const DAY = 86_400_000;

function bw(id: string, stage: BookWord['stage'], lastQuizAt: string | null): BookWord {
  return {
    id,
    bookId: 'b1',
    wordId: `w-${id}`,
    listNo: 1,
    orderInList: 0,
    tier: 2,
    tierUpdatedAt: '2026-10-01T00:00:00.000Z',
    status: 'normal',
    streak: 0,
    failStreak: 0,
    specialTraining: false,
    quizDayStreak: 0,
    quizDayPassed: false,
    stage,
    stageStreak: 0,
    ...(lastQuizAt ? { lastQuizAt } : {}),
  };
}

/** 近 N 天里，有几天在学习、每天答多少词 */
function daysAgo(n: number, hour = 9): string {
  return new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10) + `T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

describe('computeStagePace', () => {
  it('14 天窗口内按 UTC 日汇总；学习日均速 = 去重词数 ÷ 学习日', () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => bw(`d0-${i}`, 1, daysAgo(0))), // 今天 30 词
      ...Array.from({ length: 10 }, (_, i) => bw(`d1-${i}`, 1, daysAgo(1))), // 昨天 10 词
    ];
    const pace = computeStagePace(rows, NOW);
    expect(pace.activeDays).toBe(2);
    expect(pace.touchedWords).toBe(40);
    expect(pace.wordsPerDay).toBe(20); // 40 ÷ 2
    expect(pace.minutesPerDay).toBeCloseTo((20 * 12) / 60, 5); // 4 分钟
  });

  it('同一个词一天内答多次只算一次（lastQuizAt 是最后答题时间）', () => {
    const rows = [bw('a', 1, daysAgo(0)), bw('b', 1, daysAgo(0)), bw('c', 1, daysAgo(1))];
    const pace = computeStagePace(rows, NOW);
    expect(pace.activeDays).toBe(2);
    expect(pace.touchedWords).toBe(3);
    expect(pace.wordsPerDay).toBe(2); // 3 词分布在 2 天
  });

  it('窗口外（15 天前）与无 lastQuizAt 的都不计入', () => {
    const rows = [bw('old', 1, daysAgo(15)), bw('never', 1, null), bw('fresh', 1, daysAgo(13))];
    const pace = computeStagePace(rows, NOW);
    expect(pace.activeDays).toBe(1);
    expect(pace.touchedWords).toBe(1);
  });

  it('自定义窗口天数与 avgHitSec 生效', () => {
    const rows = [bw('a', 1, daysAgo(6)), bw('b', 1, daysAgo(1))];
    const pace = computeStagePace(rows, NOW, 7, 20);
    expect(pace.windowDays).toBe(7);
    expect(pace.activeDays).toBe(2);
    expect(pace.wordsPerDay).toBe(1);
    expect(pace.minutesPerDay).toBeCloseTo((1 * 20) / 60, 5);
  });

  it('没有任何学习记录 ⇒ 全 0', () => {
    const pace = computeStagePace([bw('a', 1, null)], NOW);
    expect(pace).toMatchObject({ activeDays: 0, wordsPerDay: 0, minutesPerDay: 0, touchedWords: 0 });
  });
});

describe('projectStageFinish', () => {
  const pace = { windowDays: 14, activeDays: 7, wordsPerDay: 100, minutesPerDay: 20, touchedWords: 700 };

  it('剩余 ÷ 日均速 = 学习日；按学习频率折算自然日（7/14 天 ⇒ ×2）', () => {
    const proj = projectStageFinish({ remaining: 1000, pace, now: NOW });
    expect(proj).not.toBeNull();
    expect(proj?.studyDaysNeeded).toBe(10); // 1000 ÷ 100
    expect(proj?.calendarDays).toBe(20); // 10 × 14/7
    expect(proj?.finishDate).toBe('2026-11-12'); // 10-23 + 20 天
  });

  it('天天学（14/14）时自然日 = 学习日', () => {
    const proj = projectStageFinish({ remaining: 700, pace: { ...pace, activeDays: 14 }, now: NOW });
    expect(proj?.studyDaysNeeded).toBe(7);
    expect(proj?.calendarDays).toBe(7);
  });

  it('学习日不足 3 天 ⇒ null（不硬估）', () => {
    expect(projectStageFinish({ remaining: 100, pace: { ...pace, activeDays: 2 }, now: NOW })).toBeNull();
  });

  it('日均速 0 / 剩余 0 ⇒ null', () => {
    expect(projectStageFinish({ remaining: 100, pace: { ...pace, wordsPerDay: 0 }, now: NOW })).toBeNull();
    expect(projectStageFinish({ remaining: 0, pace, now: NOW })).toBeNull();
  });
});

describe('paceVerdict', () => {
  const base = { remaining: 1000, now: NOW, deadlineDate: '2026-12-05', avgHitSec: 12 };

  it('剩余 0 ⇒ finished', () => {
    expect(paceVerdict({ ...base, remaining: 0, pace: { windowDays: 14, activeDays: 0, wordsPerDay: 0, minutesPerDay: 0, touchedWords: 0 } }).kind).toBe('finished');
  });

  it('学习日 < 3 ⇒ insufficient（不显示瞎猜的日期）', () => {
    const v = paceVerdict({ ...base, pace: { windowDays: 14, activeDays: 2, wordsPerDay: 500, minutesPerDay: 100, touchedWords: 1000 } });
    expect(v).toEqual({ kind: 'insufficient', activeDays: 2 });
  });

  it('预计在窗口内 ⇒ ontrack + 余量天数', () => {
    // 天天学 500 词/天 ⇒ 2 个学习日 ⇒ 11-25 前完成，早于 12-05 十余天
    const v = paceVerdict({ ...base, pace: { windowDays: 14, activeDays: 14, wordsPerDay: 500, minutesPerDay: 100, touchedWords: 7000 } });
    expect(v.kind).toBe('ontrack');
    if (v.kind === 'ontrack') {
      expect(v.finishDate).toBe('2026-10-25');
      expect(v.gapDays).toBeGreaterThan(0);
    }
  });

  it('超出窗口 ⇒ behind + 差距 + 按时所需日均速', () => {
    // 14 天学 3 天、日均 50 词 ⇒ 1000 词需 20 学习日 ≈ 94 自然日 ⇒ 2027-01-25，超 12-05 约 51 天
    const v = paceVerdict({ ...base, pace: { windowDays: 14, activeDays: 3, wordsPerDay: 50, minutesPerDay: 10, touchedWords: 150 } });
    expect(v.kind).toBe('behind');
    if (v.kind === 'behind') {
      expect(v.gapDays).toBeGreaterThan(0);
      // 距截止 43 天 ⇒ 需日均 ceil(1000/43)=24 词
      expect(v.neededPerDay).toBe(24);
      expect(v.neededMinutes).toBeCloseTo((24 * 12) / 60, 5);
    }
  });
});
