/**
 * question.test.ts —— 单题构建 + 回顾恢复（用户 2026-10-15）：
 * 未答题生成四选项（每项带 lemma，判定后能看出是哪个词）；已答题返回 null 走恢复。
 */
import { describe, expect, it } from 'vitest';
import type { BookWord, Word, WordSense } from '../../src/types/domain';
import { buildQuestion, type QuestionInput } from '../../src/features/quiz/question';
import { optionSuffix, type DistractorCandidate } from '../../src/features/quiz/distractors';

function word(lemma: string, senses: Partial<WordSense>[]): Word {
  return {
    id: `id-${lemma}`,
    lemma,
    pos: '',
    senses: [],
    ipa: '',
    arpabet: '',
    frequency: 1,
    tags: [],
    examples: [],
    sensesDetail: senses.map((s, i) => ({
      senseId: `${lemma}#${i}`,
      lemma,
      pos: '',
      zh: '',
      pronunciationKey: '',
      arpabet: '',
      ...s,
    })) as WordSense[],
  } as unknown as Word;
}

const bookWord = (over: Partial<BookWord> = {}): BookWord =>
  ({
    id: 'bw1',
    bookId: 'book1',
    wordId: 'id-acquire',
    listNo: 1,
    orderInList: 1,
    tier: 4,
    tierUpdatedAt: '2026-10-15T00:00:00Z',
    status: 'normal',
    streak: 0,
    failStreak: 0,
    specialTraining: false,
    quizDayStreak: 0,
    quizDayPassed: false,
    ...over,
  }) as BookWord;

const cand = (key: string, lemma: string): DistractorCandidate => ({
  key,
  lemma,
  zh: '释义',
  pos: '',
  order: 0,
});

describe('buildQuestion：未答题', () => {
  it('生成四选项，且每个选项都带 lemma（判定后显示所属词）', () => {
    const item: QuestionInput = {
      bookWord: bookWord(),
      word: word('acquire', [
        { pos: 'n.', zh: '获得' },
        { pos: '[经]', zh: '购置' },
      ]),
      senseIndex: 1,
    };
    const pool = [cand('id-adapt#0', 'adapt'), cand('id-adopt#0', 'adopt'), cand('id-obtain#0', 'obtain'), cand('id-requisite#0', 'requisite')];
    const built = buildQuestion(item, pool);
    expect(built).not.toBeNull();
    expect(built?.options).toHaveLength(4);
    for (const o of built?.options ?? []) {
      expect(typeof o.lemma).toBe('string');
      expect(o.lemma.length).toBeGreaterThan(0);
    }
    // 正确项 = 目标词的选定义项（领域标记借位后 pos 非空）
    const correct = built?.options.find((o) => o.key === 'id-acquire#1');
    expect(correct).toBeDefined();
    expect(correct?.lemma).toBe('acquire');
  });

  it('正确项 key 与 correctKey 一致（answer() 据此判对错）', () => {
    const item: QuestionInput = {
      bookWord: bookWord(),
      word: word('acquire', [{ pos: 'n.', zh: '获得' }]),
      senseIndex: 0,
    };
    const built = buildQuestion(item, [cand('id-adapt#0', 'adapt')]);
    expect(built?.correctKey).toBe('id-acquire#0');
  });
});

describe('buildQuestion：已答题（上一题回顾）', () => {
  it('已带 options/correctKey 的题返回 null（调用方原样恢复，不重摇不重判）', () => {
    const item: QuestionInput = {
      bookWord: bookWord(),
      word: word('acquire', [{ pos: 'n.', zh: '获得' }]),
      senseIndex: 0,
      options: [cand('id-acquire#0', 'acquire')],
      correctKey: 'id-acquire#0',
    };
    expect(buildQuestion(item, [cand('id-adapt#0', 'adapt')])).toBeNull();
  });
});

describe('optionSuffix：判定后带词形，未判定不带', () => {
  const o = cand('k1', 'adapt');
  it('未判定不显示（避免提前泄题）', () => {
    expect(optionSuffix(o, false)).toBe('');
  });
  it('判定后显示（选错也能看出干扰项是哪个词）', () => {
    expect(optionSuffix(o, true)).toBe('（adapt）');
  });
  it('lemma 为空时不显示括号', () => {
    expect(optionSuffix({ ...o, lemma: '' }, true)).toBe('');
  });
});
