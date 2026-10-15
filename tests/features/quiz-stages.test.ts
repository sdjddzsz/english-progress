/**
 * stages.test.ts —— 四阶段制引擎逐条钉死（用户 2026-10-15 拍板 + 追加"不限每天一轮"）。
 */
import { describe, expect, it } from 'vitest';
import type { BookWord } from '../../src/types/domain';
import {
  applyStageChoiceResult,
  applyStageSpellingResult,
  selectStagePool,
  stageStats,
  STAGE_SPECIAL_FAILS,
} from '../../src/features/quiz/stages';

let seq = 0;
function bw(overrides: Partial<BookWord>): BookWord {
  seq += 1;
  return {
    id: `bw${seq}`,
    bookId: 'book1',
    wordId: `w${seq}`,
    listNo: 1,
    orderInList: seq,
    tier: 3,
    tierUpdatedAt: '2026-10-01T00:00:00Z',
    status: 'normal',
    streak: 0,
    failStreak: 0,
    specialTraining: false,
    quizDayStreak: 0,
    quizDayPassed: false,
    stage: 1,
    stageStreak: 0,
    ...overrides,
  };
}

const NOW = new Date('2026-10-15T10:00:00Z');

describe('selectStagePool', () => {
  it('只含该阶段的词；彻底毕业（stage=0）不入任何池', () => {
    const all = [
      bw({ stage: 1 }),
      bw({ stage: 2 }),
      bw({ stage: 4 }),
      bw({ stage: 0 }),
    ];
    expect(selectStagePool(all, 1, NOW).length).toBe(1);
    expect(selectStagePool(all, 2, NOW).length).toBe(1);
    expect(selectStagePool(all, 3, NOW).length).toBe(0);
    expect(selectStagePool(all, 4, NOW).length).toBe(1);
  });

  it('不限每天一轮：今天刚答过的词仍在池里（追加需求）', () => {
    const all = [bw({ stage: 1, lastQuizAt: '2026-10-15T01:00:00Z' })];
    expect(selectStagePool(all, 1, NOW).length).toBe(1);
  });

  it('排序：特种优先 → 层高靠前 → 久未考靠前', () => {
    const a = bw({ stage: 1, tier: 2, lastQuizAt: '2026-10-01T00:00:00Z' });
    const b = bw({ stage: 1, tier: 4, lastQuizAt: '2026-10-02T00:00:00Z' });
    const c = bw({ stage: 1, tier: 4, lastQuizAt: '2026-10-03T00:00:00Z', specialTraining: true });
    const pool = selectStagePool([a, b, c], 1, NOW);
    expect(pool.map((x) => x.id)).toEqual([c.id, b.id, a.id]);
  });
});

describe('applyStageChoiceResult（阶段一~三）', () => {
  it('熟练 → stageStreak+1、层升；未达阈值不晋级', () => {
    const p = applyStageChoiceResult(bw({ stage: 1, tier: 3, stageStreak: 0 }), 'skilled', 3, NOW);
    expect(p.stageStreak).toBe(1);
    expect(p.stage).toBe(1);
    expect(p.tier).toBe(2);
  });

  it('连续熟练达阈值 → 晋级下一阶段、连击与特训清零', () => {
    const p = applyStageChoiceResult(bw({ stage: 1, tier: 3, stageStreak: 2, specialTraining: true, failStreak: 3 }), 'skilled', 3, NOW);
    expect(p.stage).toBe(2);
    expect(p.stageStreak).toBe(0);
    expect(p.specialTraining).toBe(false);
    expect(p.failStreak).toBe(0);
  });

  it('认识/不熟/生词 → 连击清零；生词降层、不熟/生词累 failStreak', () => {
    const r = applyStageChoiceResult(bw({ stage: 1, stageStreak: 2 }), 'recognized', 3, NOW);
    expect(r.stageStreak).toBe(0);
    const u = applyStageChoiceResult(bw({ stage: 1, stageStreak: 2, failStreak: 0 }), 'unfamiliar', 3, NOW);
    expect(u.failStreak).toBe(1);
    const k = applyStageChoiceResult(bw({ stage: 1, tier: 3, stageStreak: 2 }), 'unknown', 3, NOW);
    expect(k.tier).toBe(4);
    expect(k.failStreak).toBe(1);
  });

  it(`连续不熟/生词 ≥ ${STAGE_SPECIAL_FAILS} → 特种训练`, () => {
    const p = applyStageChoiceResult(bw({ stage: 1, failStreak: 2 }), 'unknown', 3, NOW);
    expect(p.specialTraining).toBe(true);
  });

  it('阶段三毕业 → 进阶段四', () => {
    const p = applyStageChoiceResult(bw({ stage: 3, stageStreak: 2 }), 'skilled', 3, NOW);
    expect(p.stage).toBe(4);
    expect(p.stageStreak).toBe(0);
  });

  it('阈值取自设置（如改 5）：连 3 不毕业、连 5 毕业且只进一阶', () => {
    const no = applyStageChoiceResult(bw({ stage: 1, stageStreak: 3 }), 'skilled', 5, NOW);
    expect(no.stage).toBe(1);
    const yes = applyStageChoiceResult(bw({ stage: 1, stageStreak: 4 }), 'skilled', 5, NOW);
    expect(yes.stage).toBe(2);
  });
});

describe('applyStageSpellingResult（阶段四）', () => {
  it('写对一次 → 彻底毕业（stage=0）、特训解除', () => {
    const p = applyStageSpellingResult(bw({ stage: 4, specialTraining: true, failStreak: 3 }), true, NOW);
    expect(p.stage).toBe(0);
    expect(p.specialTraining).toBe(false);
    expect(p.failStreak).toBe(0);
  });

  it('写错 → 降层 + failStreak 累计，仍在阶段四', () => {
    const p = applyStageSpellingResult(bw({ stage: 4, tier: 3, failStreak: 0 }), false, NOW);
    expect(p.stage).toBe(4);
    expect(p.tier).toBe(4);
    expect(p.failStreak).toBe(1);
  });
});

describe('stageStats', () => {
  it('彻底毕业不计入任何阶段；待刷=词库量（不限一轮）', () => {
    const all = [bw({ stage: 1 }), bw({ stage: 1, specialTraining: true }), bw({ stage: 2 }), bw({ stage: 0 })];
    const s = stageStats(all, NOW);
    expect(s[1].total).toBe(2);
    expect(s[1].due).toBe(2);
    expect(s[1].special).toBe(1);
    expect(s[2].total).toBe(1);
    expect(s[3].total).toBe(0);
    expect(s[4].total).toBe(0);
  });
});
