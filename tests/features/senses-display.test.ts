/**
 * senses-display.test.ts —— 词性展示兜底（用户 2026-10-15：词性标记始终都有）。
 * 背景：ECDICT 行首领域括注（[法]/[计]/[医]…）曾被旧解析误存进 pos（实测 3240 个义项），
 * 词性展示兜底 = displaySenses。
 */
import { describe, expect, it } from 'vitest';
import type { Word, WordSense } from '../../src/types/domain';
import { applySenseAdd, applySenseDelete, applySenseEdit, applySensePronEdit, applyWordPronEdit, clampSenseIndex, displaySenses, hasMultiplePronunciations, isDomainTag, normalizeSenses } from '../../src/features/senses';

function word(overrides: Partial<Word>, senses: Partial<WordSense>[]): Word {
  const base: Word = {
    id: 'w1',
    lemma: 'defence',
    pos: '',
    senses: [],
    ipa: '',
    arpabet: '',
    examples: [],
    ...overrides,
  } as Word;
  base.sensesDetail = senses.map((s, i) => ({
    senseId: `${base.lemma}#${i}`,
    lemma: base.lemma,
    pos: '',
    zh: '',
    pronunciationKey: '',
    arpabet: '',
    ...s,
  })) as WordSense[];
  return base;
}

describe('isDomainTag：领域括注 vs 真词性括注', () => {
  it('领域标记（不以点结尾）识别为 true', () => {
    expect(isDomainTag('[法]')).toBe(true);
    expect(isDomainTag('[计]')).toBe(true);
    expect(isDomainTag('[生态]')).toBe(true);
  });
  it('真词性不是领域标记', () => {
    expect(isDomainTag('n.')).toBe(false);
    expect(isDomainTag('[adj.]')).toBe(false);
    expect(isDomainTag('')).toBe(false);
  });
});

describe('displaySenses：词性始终都有', () => {
  it('领域标记义项向最近的先行真词性借，领域标记保留在释义前', () => {
    const w = word({}, [
      { pos: 'n.', zh: '防御, 保卫' },
      { pos: '[经]', zh: '(诉讼程序中的)辩护' },
    ]);
    const ds = displaySenses(w);
    expect(ds[0].pos).toBe('n.');
    expect(ds[1].pos).toBe('n.');
    expect(ds[1].zh).toBe('[经] (诉讼程序中的)辩护');
  });

  it('连续多个领域标记都借到同一个先行词性', () => {
    const w = word({}, [
      { pos: 'n.', zh: '定义' },
      { pos: '[计]', zh: '定址' },
      { pos: '[计]', zh: '访问' },
    ]);
    const ds = displaySenses(w);
    expect(ds[1].pos).toBe('n.');
    expect(ds[2].pos).toBe('n.');
    expect(ds[2].zh).toBe('[计] 访问');
  });

  it('词开头就是领域标记时向后借', () => {
    const w = word({}, [
      { pos: '[法]', zh: '遗赠' },
      { pos: 'v.', zh: '把…遗赠给' },
    ]);
    const ds = displaySenses(w);
    expect(ds[0].pos).toBe('v.');
    expect(ds[0].zh).toBe('[法] 遗赠');
    expect(ds[1].pos).toBe('v.');
  });

  it('zh 内嵌 interj./pl./aux. 前缀提取到 pos', () => {
    const w = word({}, [
      { pos: '', zh: 'interj. 再会, 回头见' },
      { pos: '', zh: 'pl. 裤子, 长裤' },
    ]);
    const ds = displaySenses(w);
    expect(ds[0].pos).toBe('interj.');
    expect(ds[0].zh).toBe('再会, 回头见');
    expect(ds[1].pos).toBe('pl.');
    expect(ds[1].zh).toBe('裤子, 长裤');
  });

  it('全词无真词性（专名类）保持空，不编造', () => {
    const w = word({}, [{ pos: '', zh: '伍伦贡' }]);
    expect(displaySenses(w)[0].pos).toBe('');
  });

  it('不动判定字段：顺序、senseId、arpabet 与 normalizeSenses 一致', () => {
    const w = word({}, [
      { pos: 'n.', zh: '防御', arpabet: 'D AH0 F EH1 N S' },
      { pos: '[经]', zh: '辩护', arpabet: 'D AH0 F EH1 N S' },
    ]);
    const raw = normalizeSenses(w);
    const ds = displaySenses(w);
    expect(ds.map((s) => s.senseId)).toEqual(raw.map((s) => s.senseId));
    expect(ds.map((s) => s.arpabet)).toEqual(raw.map((s) => s.arpabet));
    expect(ds.map((s) => s.pronunciationKey)).toEqual(raw.map((s) => s.pronunciationKey));
  });
});

describe('义项长按编辑/删除（用户 2026-10-18）', () => {
  const word: Word = {
    id: 'w1',
    lemma: 'record',
    ipa: '/ˈrekɔːd/',
    arpabet: 'R IH1 K AO2 D',
    pos: 'n.',
    frequency: 0,
    tags: [],
    senses: ['记录', '录制'],
    sensesDetail: [
      { senseId: 'record#0', lemma: 'record', pos: 'n.', zh: '记录', pronunciationKey: 'R IH1 K AO2 D', arpabet: 'R IH1 K AO2 D', ipa: '/ˈrekɔːd/' },
      { senseId: 'record#1', lemma: 'record', pos: 'v.', zh: '录制', pronunciationKey: 'R IH1 K AO2 D', arpabet: 'R IH1 K AO2 D', ipa: '/ˈrekɔːd/' },
    ],
    examples: [],
  };

  it('编辑某个义项：只改该义项，词级 senses/pos 同步，读音字段原样不动', () => {
    const next = applySenseEdit(word, 1, { zh: '录下来' });
    expect(next.sensesDetail?.[1].zh).toBe('录下来');
    expect(next.sensesDetail?.[0].zh).toBe('记录'); // 另一个义项不受影响
    expect(next.senses[1]).toBe('录下来'); // 扁平串同步
    expect(next.sensesDetail?.[1].arpabet).toBe('R IH1 K AO2 D'); // 读音不动
  });

  it('删除某个义项：列表变短、扁平串同步；只剩一个时拒绝（返回 null）', () => {
    const next = applySenseDelete(word, 0);
    expect(next?.sensesDetail).toHaveLength(1);
    expect(next?.senses).toEqual(['录制']);
    expect(next?.pos).toBe('v.'); // 首义项词性同步
    expect(applySenseDelete(next!, 0)).toBeNull(); // 只剩一个 ⇒ 拒绝删空
  });

  it('编辑不改原对象（调用方凭引用相等判断要不要刷新）', () => {
    const next = applySenseEdit(word, 0, { zh: '记载' });
    expect(next).not.toBe(word);
    expect(word.sensesDetail?.[0].zh).toBe('记录');
  });
});

describe('义项新增（用户 2026-10-19：词书漏义项要能补，写回词书）', () => {
  const word: Word = {
    id: 'w1',
    lemma: 'record',
    ipa: '/ˈrekɔːd/',
    arpabet: 'R IH1 K AO2 D',
    pos: 'n.',
    frequency: 0,
    tags: [],
    senses: ['记录', '录制'],
    sensesDetail: [
      { senseId: 'record#0', lemma: 'record', pos: 'n.', zh: '记录', pronunciationKey: 'R IH1 K AO2 D', arpabet: 'R IH1 K AO2 D', ipa: '/ˈrekɔːd/' },
      { senseId: 'record#1', lemma: 'record', pos: 'v.', zh: '录制', pronunciationKey: 'R IH1 K AO2 D', arpabet: 'R IH1 K AO2 D', ipa: '/ˈrekɔːd/' },
    ],
    examples: [],
  };

  it('追加到末尾：新义项带用户填的词性/释义，词级 senses 同步', () => {
    const next = applySenseAdd(word, { pos: 'n.', zh: '最高纪录' });
    expect(next.sensesDetail).toHaveLength(3);
    expect(next.sensesDetail?.[2].zh).toBe('最高纪录');
    expect(next.sensesDetail?.[2].pos).toBe('n.');
    expect(next.senses).toEqual(['记录', '录制', '最高纪录']);
    expect(next.sensesDetail?.[0].zh).toBe('记录'); // 原有义项不动
  });

  it('新义项 senseId 唯一，读音继承首义项（不留空——空读音会被判成另一个"词"）', () => {
    const next = applySenseAdd(word, { zh: '唱片' });
    const added = next.sensesDetail?.[2];
    expect(added?.senseId).toBe('record#2');
    expect(added?.arpabet).toBe('R IH1 K AO2 D');
    expect(added?.pronunciationKey).toBe('R IH1 K AO2 D');
    expect(added?.ipa).toBe('/ˈrekɔːd/');
    // 新义项与首义项同判定身份 ⇒ 听音选词等按 pronunciationKey 的逻辑不会把它漏掉
    expect(normalizeSenses(next).map((s) => s.senseId)).toEqual(['record#0', 'record#1', 'record#2']);
  });

  it('老词没有 sensesDetail（降级路径）也能加：新义项挂在降级义项后面', () => {
    const legacy: Word = { ...word, senses: ['记录'], sensesDetail: undefined };
    const next = applySenseAdd(legacy, { pos: 'v.', zh: '录制' });
    expect(next.sensesDetail).toHaveLength(2);
    expect(next.sensesDetail?.[1].zh).toBe('录制');
    expect(next.senses).toEqual(['记录', '录制']);
    expect(next.sensesDetail?.[1].arpabet).toBe('R IH1 K AO2 D');
  });

  it('senseId 撞已有 id 时向后顺延（手写数据可能有非常规 id）', () => {
    const odd: Word = {
      ...word,
      sensesDetail: [
        { senseId: 'record#0', lemma: 'record', pos: 'n.', zh: '记录', pronunciationKey: 'R IH1 K AO2 D', arpabet: 'R IH1 K AO2 D', ipa: '/ˈrekɔːd/' },
        { senseId: 'record#2', lemma: 'record', pos: 'v.', zh: '录制', pronunciationKey: 'R IH1 K AO2 D', arpabet: 'R IH1 K AO2 D', ipa: '/ˈrekɔːd/' },
      ],
    };
    const next = applySenseAdd(odd, { zh: '唱片' });
    expect(next.sensesDetail?.[2].senseId).toBe('record#3');
  });

  it('新增后 clampSenseIndex 不动原题锚点（追加在末尾，不是插队）', () => {
    const next = applySenseAdd(word, { zh: '唱片' });
    expect(clampSenseIndex(next, 1)).toBe(1);
  });

  it('新增不改原对象', () => {
    const next = applySenseAdd(word, { zh: '唱片' });
    expect(next).not.toBe(word);
    expect(next.sensesDetail).not.toBe(word.sensesDetail);
    expect(word.senses).toEqual(['记录', '录制']);
  });
});

describe('clampSenseIndex：删义项后题目锚点收敛（用户 2026-10-18）', () => {
  const word: Word = {
    id: 'w1', lemma: 'record', ipa: '', arpabet: '', pos: '', frequency: 0, tags: [], senses: [],
    sensesDetail: [
      { senseId: 'record#0', lemma: 'record', pos: 'n.', zh: '记录', pronunciationKey: 'k', arpabet: '', ipa: '' },
      { senseId: 'record#1', lemma: 'record', pos: 'v.', zh: '录制', pronunciationKey: 'k', arpabet: '', ipa: '' },
    ],
    examples: [],
  };
  it('删掉正在考的那个义项 ⇒ 收敛到还剩的最后一个（题卡不消失）', () => {
    const after = applySenseDelete(word, 1)!; // 删「录制」，原锚点 1 越界
    expect(clampSenseIndex(after, 1)).toBe(0);
  });
  it('删掉当前义项前面的 ⇒ 目标前移对齐', () => {
    const after = applySenseDelete(word, 0)!; // 删「记录」，原锚点 1（录制）应变 0
    expect(clampSenseIndex(after, 1)).toBe(0);
  });
  it('没删当前词 / 编辑不改数量 ⇒ 锚点原样', () => {
    expect(clampSenseIndex(word, 1)).toBe(1);
    expect(clampSenseIndex(applySenseEdit(word, 0, { zh: '记载' }), 1)).toBe(1);
  });
});

describe('读音长按编辑（用户 2026-10-24：fine 音标数据错了要能就地修）', () => {
  /** fine 云端真值（修正前）：6 个义项，#1/#3/#5 的音标是坏的 /ˈfɪ.nə/ */
  const fine = (): Word =>
    word({ lemma: 'fine', ipa: '/ˈfaɪn/', arpabet: 'F AY1 N', pos: 'n.' }, [
      { pos: 'n.', zh: '罚款, 罚金', ipa: '/ˈfaɪn/', arpabet: 'F AY1 N', pronunciationKey: 'F AY1 N' },
      { pos: 'adj.', zh: '好的', ipa: '/ˈfɪ.nə/', arpabet: 'F IH1 N AH0', pronunciationKey: 'F IH1 N AH0' },
      { pos: 'vt.', zh: '罚款', ipa: '/ˈfaɪn/', arpabet: 'F AY1 N', pronunciationKey: 'F AY1 N' },
      { pos: 'vi.', zh: '变清', ipa: '/ˈfɪ.nə/', arpabet: 'F IH1 N AH0', pronunciationKey: 'F IH1 N AH0' },
      { pos: 'adv.', zh: '很好', ipa: '/ˈfaɪn/', arpabet: 'F AY1 N', pronunciationKey: 'F AY1 N' },
      { pos: '[计]', zh: '精细', ipa: '/ˈfɪ.nə/', arpabet: 'F IH1 N AH0', pronunciationKey: 'F IH1 N AH0' },
    ]);

  it('applySensePronEdit：义项 ipa/arpabet/pronunciationKey 三字段一起换', () => {
    const next = applySensePronEdit(fine(), 1, { ipa: '/ˈfaɪn/', arpabet: 'F AY1 N' });
    const s = next.sensesDetail![1];
    expect(s.ipa).toBe('/ˈfaɪn/');
    expect(s.arpabet).toBe('F AY1 N');
    expect(s.pronunciationKey).toBe('F AY1 N');
  });

  it('applySensePronEdit：只碰目标义项，其它义项与 senseId 原样', () => {
    const before = fine();
    const next = applySensePronEdit(before, 3, { ipa: '/ˈfaɪn/', arpabet: 'F AY1 N' });
    expect(next.sensesDetail!.map((s) => s.senseId)).toEqual(before.sensesDetail!.map((s) => s.senseId));
    expect(next.sensesDetail![0]).toEqual(before.sensesDetail![0]);
    expect(next.sensesDetail![5]).toEqual(before.sensesDetail![5]);
    // 释义/词性不动
    expect(next.sensesDetail![3].zh).toBe('变清');
    expect(next.sensesDetail![3].pos).toBe('vi.');
  });

  it('applySensePronEdit：修正后 6 个义项并回同一档读音（多读音标识消失）', () => {
    let w = fine();
    for (const i of [1, 3, 5]) w = applySensePronEdit(w, i, { ipa: '/ˈfaɪn/', arpabet: 'F AY1 N' });
    const keys = new Set(w.sensesDetail!.map((s) => s.pronunciationKey));
    expect(keys.size).toBe(1);
    expect(hasMultiplePronunciations(w)).toBe(false);
  });

  it('applySensePronEdit：改第 0 个义项时同步词级 ipa/arpabet（兼容口径）', () => {
    const w = word({ lemma: 'read', ipa: '/riːd/', arpabet: 'R IY1 D', pos: 'v.' }, [
      { pos: 'v.', zh: '阅读', ipa: '/riːd/', arpabet: 'R IY1 D', pronunciationKey: 'R IY1 D' },
      { pos: 'adj.', zh: '博学的', ipa: '/rɛd/', arpabet: 'R EH1 D', pronunciationKey: 'R EH1 D' },
    ]);
    const next = applySensePronEdit(w, 1, { ipa: '/red/', arpabet: 'R EH0 D' });
    // 改的是第 1 个 ⇒ 词级不动
    expect(next.ipa).toBe('/riːd/');
    expect(next.arpabet).toBe('R IY1 D');
    const next0 = applySensePronEdit(w, 0, { ipa: '/riːd/', arpabet: 'R IY0 D' });
    // 改的是第 0 个 ⇒ 词级跟着走
    expect(next0.ipa).toBe('/riːd/');
    expect(next0.arpabet).toBe('R IY0 D');
  });

  it('applyWordPronEdit：只换词级读音，义项数据原样', () => {
    const before = fine();
    const next = applyWordPronEdit(before, { ipa: '/ˈfaɪn/', arpabet: 'F AY1 N' });
    expect(next.ipa).toBe('/ˈfaɪn/');
    expect(next.arpabet).toBe('F AY1 N');
    expect(next.sensesDetail).toEqual(before.sensesDetail);
  });

  it('senseId 不变 ⇒ 学习进度锚点不受影响（判定单位稳定）', () => {
    const before = fine();
    const next = applySensePronEdit(before, 1, { ipa: '/ˈfaɪn/', arpabet: 'F AY1 N' });
    expect(next.sensesDetail![1].senseId).toBe('fine#1');
    // 题卡锚的是 senseIndex，义项数量没变 ⇒ clamp 原样
    expect(clampSenseIndex(next, 1)).toBe(1);
  });
});
