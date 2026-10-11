/**
 * placement.test.ts —— T05 摸底分层（抽样 ≤300 / 频带配比 / L1→tier 映射 / 前两周校准）：
 * - pickPlacementSample：上限 300、确定性（两次同输入同输出）、各频带都有覆盖、高频词必入样；
 * - l1ToTier / estimateTierAssignments 映射；
 * - inCalibrationWindow 边界（第 0/13 天内、第 14 天外）；
 * - suggestTierFromFeedback：连续 2 次秒认上移 / 出现"不认识"下移 / 不动；
 * - exceedsConfirmRatio：>10% 触发 Confirm 提案口径。
 */
import { describe, expect, it } from 'vitest';
import {
  buildCalibrationAssignments,
  exceedsConfirmRatio,
  inCalibrationWindow,
  suggestTierFromFeedback,
} from '../../src/features/placement/calibration';
import { TIER_RECALIBRATION_CONFIRM_RATIO } from '../../src/config/constants';
import {
  estimateTierAssignments,
  l1ToTier,
  pickPlacementSample,
  type PlacementCandidate,
} from '../../src/features/placement/sampling';
import { PLACEMENT_MAX_WORDS } from '../../src/config/constants';

function makeWords(n: number): PlacementCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    wordId: `w${i}`,
    lemma: `lemma${i}`,
    frequency: Math.max(1, 10000 - i * 5), // 严格递减
  }));
}

describe('摸底抽样（≤300 词，词频先验分带配比）', () => {
  it('大词书：抽样不超过上限且恰为 300', () => {
    const sample = pickPlacementSample(makeWords(3000));
    expect(sample.length).toBe(PLACEMENT_MAX_WORDS);
    expect(sample.length).toBe(300);
  });

  it('确定性：同输入两次抽样逐项一致', () => {
    const words = makeWords(2000);
    expect(pickPlacementSample(words)).toEqual(pickPlacementSample(words));
  });

  it('词量 ≤ 上限时全量返回（保持频序）', () => {
    const words = makeWords(150);
    const sample = pickPlacementSample(words);
    expect(sample.length).toBe(150);
    expect(sample[0].frequency).toBeGreaterThanOrEqual(sample[sample.length - 1].frequency);
  });

  it('分带覆盖：高频词必入样，四个频带各有代表', () => {
    const words = makeWords(2000);
    const sample = pickPlacementSample(words);
    const ids = new Set(sample.map((w) => w.wordId));
    expect(ids.has('w0')).toBe(true); // 最高频必入
    // 带边界（0-499 / 500-999 / 1000-1499 / 1500-1999）各有词入样
    const bands = new Set(sample.map((w) => Math.floor(Number(w.wordId.slice(1)) / 500)));
    expect(bands.size).toBe(4);
  });
});

describe('L1 快答 → 初始层映射', () => {
  it('四级映射正确', () => {
    expect(l1ToTier('instant')).toBe(1);
    expect(l1ToTier('recognized')).toBe(2);
    expect(l1ToTier('familiar_but_forgotten')).toBe(3);
    expect(l1ToTier('unknown')).toBe(4);
  });

  it('estimateTierAssignments：每条快答一条 assignment', () => {
    const out = estimateTierAssignments({ a: 'instant', b: 'unknown', c: 'recognized' });
    expect(out).toHaveLength(3);
    const byId = new Map(out.map((o) => [o.wordId, o.tier]));
    expect(byId.get('a')).toBe(1);
    expect(byId.get('b')).toBe(4);
    expect(byId.get('c')).toBe(2);
  });
});

describe('前两周每日校准', () => {
  it('窗口边界：第 0/13 天在内，第 14 天起关闭', () => {
    const start = '2026-10-11';
    expect(inCalibrationWindow(start, '2026-10-11')).toBe(true); // 第 0 天
    expect(inCalibrationWindow(start, '2026-10-24')).toBe(true); // 第 13 天
    expect(inCalibrationWindow(start, '2026-10-25')).toBe(false); // 第 14 天
  });

  it('层修正：连续 2 次秒认上移；出现不认识下移；其余不动', () => {
    expect(suggestTierFromFeedback(['instant', 'instant'], 3)).toBe(2);
    expect(suggestTierFromFeedback(['unknown'], 3)).toBe(4);
    expect(suggestTierFromFeedback(['instant'], 3)).toBe(3); // 仅 1 次秒认不动
    expect(suggestTierFromFeedback(['recognized', 'recognized'], 2)).toBe(2);
    // 边界 clamp：T1 不上移，T4 不再下移
    expect(suggestTierFromFeedback(['instant', 'instant'], 1)).toBe(1);
    expect(suggestTierFromFeedback(['unknown'], 4)).toBe(4);
    // 下移优先于上移（宁严勿松）
    expect(suggestTierFromFeedback(['instant', 'instant', 'unknown'], 2)).toBe(3);
  });

  it('buildCalibrationAssignments：只产变更项', () => {
    const out = buildCalibrationAssignments([
      { wordId: 'w1', currentTier: 3, recentL1: ['instant', 'instant'] }, // → 2 变更
      { wordId: 'w2', currentTier: 2, recentL1: ['recognized'] }, // 不变
      { wordId: 'w3', currentTier: 3, recentL1: ['unknown'] }, // → 4 变更
      { wordId: 'w4', currentTier: 3, recentL1: [] }, // 无数据不变
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.wordId).sort()).toEqual(['w1', 'w3']);
  });

  it('Confirm 阈值：变更 >10% 触发（recompute_word_tiers 动态风险路由依据）', () => {
    expect(exceedsConfirmRatio(2, 20)).toBe(false); // 恰 10% → 不大于，不触发
    expect(exceedsConfirmRatio(3, 20)).toBe(true); // 15% → 触发
    expect(exceedsConfirmRatio(0, 20)).toBe(false);
    expect(exceedsConfirmRatio(1, 0)).toBe(false); // 防除零
  });

  it('阈值常量与 PRD §4.3 一致（0.1）', () => {
    expect(TIER_RECALIBRATION_CONFIRM_RATIO).toBe(0.1);
  });
});
