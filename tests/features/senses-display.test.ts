/**
 * senses-display.test.ts —— 词性展示兜底（用户 2026-10-15：词性标记始终都有）。
 * 背景：ECDICT 行首领域括注（[法]/[计]/[医]…）曾被旧解析误存进 pos（实测 3240 个义项），
 * 词性展示兜底 = displaySenses。
 */
import { describe, expect, it } from 'vitest';
import type { Word, WordSense } from '../../src/types/domain';
import { applySenseDelete, applySenseEdit, displaySenses, isDomainTag, normalizeSenses } from '../../src/features/senses';

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
