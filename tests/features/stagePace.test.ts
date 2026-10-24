/**
 * stagePace.test.ts —— 四阶段真实节奏与完成预估（用户 2026-10-23 选「方案 2」，
 * 2026-10-24 起原料改云端聚合）。
 *
 * 背景：首页计划卡原来显示 tier 模型预估（Σ词数×轮次 ÷ 窗口 × 秒数），四阶段用户身上
 * 是持续误报（红线常年亮）。改为按真实答题节奏推算。
 * 数据源事实：2026-10-24 起 dailyCounts 由云端 PG 函数 ep_home_summary 算好
 * （每天答过的不同词数，UTC 日分组 + distinct）——「同日多答只算一次」的
 * distinct 口径由 mockDb.rpc 的测试钉死（tests/data/homeSummaryRpc.test.ts），
 * 这里只测「原料 → 节奏/预估/判定」的纯计算。
 */
import { describe, expect, it } from 'vitest';
import { computeStagePace, paceVerdict, projectStageFinish } from '../../src/features/quiz/stagePace';
import type { DailyCount } from '../../src/data/repos/wordRepo';

const NOW = new Date('2026-10-23T10:00:00.000Z');
const DAY = 86_400_000;

/** UTC 日字符串（N 天前） */
function dayStr(n: number): string {
  return new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);
}

/** 云端 dailyCounts 原料的一行：N 天前答过 count 个不同的词 */
function dc(n: number, count: number): DailyCount {
  return { date: dayStr(n), count };
}

describe('computeStagePace', () => {
  it('14 天窗口内按 UTC 日汇总；学习日均速 = 去重词数 ÷ 学习日', () => {
    const pace = computeStagePace([dc(0, 30), dc(1, 10)], NOW);
    expect(pace.activeDays).toBe(2);
    expect(pace.touchedWords).toBe(40);
    expect(pace.wordsPerDay).toBe(20); // 40 ÷ 2
    expect(pace.minutesPerDay).toBeCloseTo((20 * 12) / 60, 5); // 4 分钟
  });

  it('窗口外（15 天前）的条目不计入', () => {
    const pace = computeStagePace([dc(15, 5), dc(13, 3)], NOW);
    expect(pace.activeDays).toBe(1);
    expect(pace.touchedWords).toBe(3);
  });

  it('自定义窗口天数与 avgHitSec 生效', () => {
    const pace = computeStagePace([dc(6, 1), dc(1, 1)], NOW, 7, 20);
    expect(pace.windowDays).toBe(7);
    expect(pace.activeDays).toBe(2);
    expect(pace.wordsPerDay).toBe(1);
    expect(pace.minutesPerDay).toBeCloseTo((1 * 20) / 60, 5);
  });

  it('没有任何学习记录（空原料）⇒ 全 0', () => {
    const pace = computeStagePace([], NOW);
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
