/**
 * joinCmuDict.test.ts —— T1 单测：selectMainEntry 主词条选择、joinSeedWithCmu 纯逻辑、
 * 字段顺序契约、parseCmudictText 官方文本解析。
 * 断言依据：架构增量 §5.4 / §六 T1 验收（WORD 优先；无主词条取编号最小；未命中不写 arpabet）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildSelectedIndex,
  joinSeedWithCmu,
  parseCmudictText,
  selectMainEntry,
  type CmuDict,
  type SeedWord,
} from '../../src/data/seed/joinCmuDict';

const DICT: CmuDict = {
  academy: 'AH0 K AE1 D AH0 M IY0',
  'academy(2)': 'AH0 K AE1 D AH0 M IY1',
  wilful: 'W IH1 L F AH0 L',
  // 只有编号变体（无主词条）
  'colour(1)': 'K AH1 L ER0',
  'colour(2)': 'K AO1 L ER0',
  progress: 'P R AA1 G R EH2 S',
};

describe('selectMainEntry：主词条选择（Q2）', () => {
  it('WORD 优先于 WORD(1)/WORD(2)', () => {
    expect(selectMainEntry(DICT, 'academy')).toBe('AH0 K AE1 D AH0 M IY0');
  });

  it('只有编号条目时取编号最小', () => {
    expect(selectMainEntry(DICT, 'colour')).toBe('K AH1 L ER0'); // (1) 优先于 (2)
  });

  it('大小写 / 前后空白不敏感', () => {
    expect(selectMainEntry(DICT, '  Academy ')).toBe('AH0 K AE1 D AH0 M IY0');
    expect(selectMainEntry(DICT, 'WILFUL')).toBe('W IH1 L F AH0 L');
  });

  it('未命中 → undefined；空串 → undefined', () => {
    expect(selectMainEntry(DICT, 'notaword')).toBeUndefined();
    expect(selectMainEntry(DICT, '')).toBeUndefined();
    expect(selectMainEntry(DICT, '   ')).toBeUndefined();
  });
});

describe('buildSelectedIndex：一次扫描索引（与 selectMainEntry 等价）', () => {
  it('主词条覆盖变体；变体标记 variant=true', () => {
    const idx = buildSelectedIndex(DICT);
    expect(idx.get('academy')).toEqual({ phonemes: 'AH0 K AE1 D AH0 M IY0', variant: false });
    expect(idx.get('colour')).toEqual({ phonemes: 'K AH1 L ER0', variant: true });
  });

  it('与 selectMainEntry 结果一致', () => {
    const idx = buildSelectedIndex(DICT);
    for (const lemma of ['academy', 'colour', 'wilful', 'progress']) {
      expect(idx.get(lemma)?.phonemes).toBe(selectMainEntry(DICT, lemma));
    }
  });
});

const SEED: SeedWord[] = [
  { lemma: 'academy', ipa: "/'i:gl/", translation: 'n. 学院', frq: 45890, tags: ['cet6'] },
  { lemma: 'wilful', ipa: "/'wilful/", translation: 'a. 任性的', frq: 44654, tags: ['cet6'] },
  { lemma: 'zzzunknown', ipa: '/z-z/', translation: 'n. 未命中', frq: 100, tags: ['cet6'] },
];

describe('joinSeedWithCmu：命中 / 未命中 / 报告', () => {
  it('命中：写 arpabet + 派生 ipa；字段顺序固定 lemma,arpabet,ipa,translation,frq,tags', () => {
    const { seed } = joinSeedWithCmu(SEED, DICT);
    const hit = seed[0];
    expect(Object.keys(hit)).toEqual(['lemma', 'arpabet', 'ipa', 'translation', 'frq', 'tags']);
    expect(hit.arpabet).toBe('AH0 K AE1 D AH0 M IY0');
    expect(hit.ipa).toBe('/ə.ˈkæ.də.mi/'); // 由 arpabetToIpa 派生（真源唯一）
    expect(hit.translation).toBe('n. 学院');
    expect(hit.frq).toBe(45890);
    expect(hit.tags).toEqual(['cet6']);
  });

  it('未命中：不写 arpabet，ipa 保留 ECDICT 原值，字段顺序无 arpabet', () => {
    const { seed } = joinSeedWithCmu(SEED, DICT);
    const miss = seed[2];
    expect('arpabet' in miss).toBe(false);
    expect(Object.keys(miss)).toEqual(['lemma', 'ipa', 'translation', 'frq', 'tags']);
    expect(miss.ipa).toBe('/z-z/');
  });

  it('报告：total / hit / miss / hitRate / misses / variantCount', () => {
    const { report } = joinSeedWithCmu(SEED, DICT);
    expect(report.total).toBe(3);
    expect(report.hit).toBe(2);
    expect(report.miss).toBe(1);
    expect(report.hitRate).toBeCloseTo(2 / 3, 10);
    expect(report.misses).toEqual(['zzzunknown']);
    expect(report.variantCount).toBe(0); // academy 用主词条，非变体
  });

  it('variantCount：使用编号变体的词计数', () => {
    const seed: SeedWord[] = [{ lemma: 'colour', ipa: '/x/', translation: 'n. 颜色', frq: 1, tags: [] }];
    const { report } = joinSeedWithCmu(seed, DICT);
    expect(report.hit).toBe(1);
    expect(report.variantCount).toBe(1);
  });

  it('空 seed → 空结果 + 零报告（hitRate=0）', () => {
    const { seed, report } = joinSeedWithCmu([], DICT);
    expect(seed).toEqual([]);
    expect(report).toEqual({ total: 0, hit: 0, miss: 0, hitRate: 0, misses: [], variantCount: 0 });
  });

  it('空 dict → 全部未命中（不写 arpabet）', () => {
    const { seed, report } = joinSeedWithCmu(SEED, {});
    expect(report.hit).toBe(0);
    expect(report.miss).toBe(3);
    expect(seed.every((w) => !('arpabet' in w))).toBe(true);
    expect(seed.map((w) => w.ipa)).toEqual(SEED.map((w) => w.ipa));
  });
});

describe('parseCmudictText：官方 cmudict.dict 文本解析', () => {
  it('每行 WORD  PHONEMES；键转小写；变体保留编号', () => {
    const text = [
      ';;; CMUdict sample',
      'ACADEMY  AH0 K AE1 D AH0 M IY0',
      'COLOUR(1)  K AH1 L ER0',
      'COLOUR(2)  K AO1 L ER0',
      '',
      'WILFUL  W IH1 L F AH0 L',
    ].join('\n');
    const dict = parseCmudictText(text);
    expect(dict.academy).toBe('AH0 K AE1 D AH0 M IY0');
    expect(dict['colour(1)']).toBe('K AH1 L ER0');
    expect(dict.wilful).toBe('W IH1 L F AH0 L');
    expect(Object.keys(dict)).toHaveLength(4); // 注释/空行不计
  });

  it('行尾 # 注释被剥离；解析结果可被 selectMainEntry 直接使用', () => {
    const dict = parseCmudictText('PROGRESS  P R AA1 G R EH2 S  # noun\n');
    expect(dict.progress).toBe('P R AA1 G R EH2 S');
    expect(selectMainEntry(dict, 'progress')).toBe('P R AA1 G R EH2 S');
  });
});
