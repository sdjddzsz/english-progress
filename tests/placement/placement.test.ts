/**
 * placement.test.ts —— T05 摸底分层（抽样 ≤300 / 频带配比 / L1→tier 映射 / 前两周校准）：
 * - pickPlacementSample：上限 300、确定性（两次同输入同输出）、各频带都有覆盖、高频词必入样；
 * - l1ToTier / estimateTierAssignments 映射；
 * - applySelfCheck：**核对后改判**（用户 2026-10-13 的核心要求：宣称认识却对不上答案 ⇒ 降层）；
 * - toSenseCandidates：**同词不同读音拆成不同判定单位**（不同读音 ⇒ 当成不同的单词）；
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
  applySelfCheck,
  estimateTierAssignments,
  l1ToTier,
  pickPlacementSample,
  toSenseCandidates,
  type PlacementCandidate,
} from '../../src/features/placement/sampling';
import { normalizeSenses, isSameWordUnit } from '../../src/features/senses';
import type { Word } from '../../src/types/domain';
import { PLACEMENT_MAX_WORDS } from '../../src/config/constants';

/** 判定单位从 wordId 改为 senseId（`lemma#序号`） */
function makeWords(n: number): PlacementCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    senseId: `lemma${i}#0`,
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
    const ids = new Set(sample.map((w) => w.senseId));
    expect(ids.has('lemma0#0')).toBe(true); // 最高频必入
    // 带边界（0-499 / 500-999 / 1000-1499 / 1500-1999）各有词入样
    const bands = new Set(sample.map((w) => Math.floor(Number(w.senseId.slice(5).split('#')[0]) / 500)));
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
    const byId = new Map(out.map((o) => [o.senseId, o.tier]));
    expect(byId.get('a')).toBe(1);
    expect(byId.get('b')).toBe(4);
    expect(byId.get('c')).toBe(2);
  });
});

/**
 * 用户 2026-10-13：「谁知道自己是不是记错了」—— 纯自评属于自欺欺人，
 * 因此揭晓答案后必须再核对一次，记错就降层。这一组用例钉死这个规则。
 */
describe('揭晓答案后的自我核对（消除自评自欺）', () => {
  it('宣称认识但核对为记错 ⇒ 降一层（认识 → 见过想不起）', () => {
    expect(applySelfCheck('recognized', true)).toBe('familiar_but_forgotten');
  });

  it('宣称秒认但核对为记错 ⇒ 同样降一层', () => {
    expect(applySelfCheck('instant', true)).toBe('familiar_but_forgotten');
  });

  it('核对为没记错 ⇒ 维持初判（不因为"多问了一次"而改变真实水平）', () => {
    expect(applySelfCheck('recognized', false)).toBe('recognized');
    expect(applySelfCheck('instant', false)).toBe('instant');
  });

  it('本来就不认识 / 想不起 ⇒ 记错也不进一步恶化（已是最差档）', () => {
    expect(applySelfCheck('unknown', true)).toBe('unknown');
    expect(applySelfCheck('familiar_but_forgotten', true)).toBe('unknown');
  });

  it('核对改判必须真的改变最终层（认识 T2 → 见过想不起 T3）', () => {
    const before = l1ToTier('recognized');
    const after = l1ToTier(applySelfCheck('recognized', true));
    expect(before).toBe(2);
    expect(after).toBe(3);
    expect(after).toBeGreaterThan(before);
  });
});

/**
 * 用户 2026-10-13：「哪怕同一个单词只要不同读音对应不同意思，就当成不同的单词判定」。
 * 这一组钉死义项级判定：判定键从 wordId 变为 senseId，读音不同 ⇒ 独立判定。
 */
describe('同词不同读音 ⇒ 不同判定单位', () => {
  const recordWord: Word = {
    id: 'word_record',
    lemma: 'record',
    ipa: '/ɹɪˈkɔɹd/',
    arpabet: 'R IH0 K AO1 R D',
    senses: ['记录', '录制'],
    sensesDetail: [
      {
        senseId: 'record#0',
        lemma: 'record',
        pos: 'n.',
        zh: '记录',
        pronunciationKey: 'R EH1 K ER0 D',
        arpabet: 'R EH1 K ER0 D',
        ipa: '/ˈɹɛkɚd/',
      },
      {
        senseId: 'record#1',
        lemma: 'record',
        pos: 'vt.',
        zh: '录制',
        pronunciationKey: 'R IH0 K AO1 R D',
        arpabet: 'R IH0 K AO1 R D',
        ipa: '/ɹɪˈkɔɹd/',
      },
    ],
    examples: [],
    frequency: 100,
    tags: ['cet4', 'cet6'],
  };

  it('多读音词被拆成多条判定单位，senseId 互不相同', () => {
    const out = toSenseCandidates([recordWord]);
    expect(out.length).toBe(2);
    expect(out[0].senseId).not.toBe(out[1].senseId);
    expect(out.map((c) => c.senseId)).toEqual(['record#0', 'record#1']);
  });

  it('两条判定单位的读音不同 ⇒ isSameWordUnit 判为不同的词', () => {
    const [a, b] = normalizeSenses(recordWord);
    expect(isSameWordUnit(a, b)).toBe(false);
  });

  it('两条判定单位共享同一个 lemma（词书层仍是同一个词行）', () => {
    const [a, b] = normalizeSenses(recordWord);
    expect(a.lemma).toBe(b.lemma);
    expect(a.lemma).toBe('record');
  });

  it('单读音多词性词 ⇒ 合并为一条（用户定义：不同读音才算不同的单词）', () => {
    const single: Word = {
      ...recordWord,
      lemma: 'address',
      sensesDetail: [
        {
          senseId: 'address#0',
          lemma: 'address',
          pos: 'n.',
          zh: '住址',
          pronunciationKey: 'AE1 D R EH2 S',
          arpabet: 'AE1 D R EH2 S',
          ipa: '/ˈædrɛs/',
        },
        {
          senseId: 'address#1',
          lemma: 'address',
          pos: 'vt.',
          zh: '写地址',
          pronunciationKey: 'AE1 D R EH2 S', // 同读音
          arpabet: 'AE1 D R EH2 S',
          ipa: '/ˈædrɛs/',
        },
      ],
    };
    const out = toSenseCandidates([single]);
    expect(out.length).toBe(1);
    // 但释义要合并（揭晓时一眼看全）
    expect(out[0].zh).toContain('住址');
    expect(out[0].zh).toContain('写地址');
    expect(out[0].pronunciationCount).toBe(1);
  });

  it('旧数据（无 sensesDetail）降级为单词级单义项且 pronunciationKey 非空稳定', () => {
    const legacy: Word = {
      id: 'word_legacy',
      lemma: 'legacy',
      ipa: '/ˈlɛɡəsi/',
      arpabet: 'L EH1 G AH0 S IY0',
      senses: ['遗产'],
      examples: [],
      frequency: 10,
      tags: ['cet6'],
    };
    const s = normalizeSenses(legacy);
    expect(s).toHaveLength(1);
    expect(s[0].senseId).toBe('legacy#0');
    expect(s[0].pronunciationKey).toBe('L EH1 G AH0 S IY0');
    // 降级路径与义项路径对同一读音必须算出同一个 key（否则同一词会被判成两个单位）
    const viaSenseDetail = normalizeSenses({ ...legacy, sensesDetail: [s[0]] });
    expect(viaSenseDetail[0].pronunciationKey).toBe(s[0].pronunciationKey);
  });

  it('无读音（CMUdict 未命中）时 key 仍稳定非空，不与任何读音混淆', () => {
    const noPron: Word = {
      id: 'word_x',
      lemma: 'x',
      ipa: '',
      senses: ['某义'],
      examples: [],
      frequency: 1,
      tags: [],
    };
    const s = normalizeSenses(noPron);
    expect(s[0].pronunciationKey).toBe('NO_PRONUNCIATION');
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
