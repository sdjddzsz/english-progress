/**
 * distractors.test.ts —— 干扰项「相似优先，随机补齐」（用户 2026-10-14：干扰项不要太随机）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildOptions,
  pickDistractors,
  type DistractorCandidate,
} from '../../src/features/quiz/distractors';

const c = (key: string, zh: string, pos: string, order = 0, lemma = `word-${key}`): DistractorCandidate => ({
  key,
  zh,
  pos,
  lemma,
  order,
});

describe('pickDistractors', () => {
  const correct = c('a#0', '珍珠, 珠灰色, 杰出者', 'n.', 5);

  it('同词性优先入选（池里有同词性时，得分高的先进）', () => {
    const pool = [
      c('v1', '用珍珠镶, 使成珠状', 'vt.', 5),
      c('v2', '立为女王', 'vt.', 4),
      c('n1', '王后, 女王', 'n.', 4),
      c('n2', '回顾, 追忆, 反省', 'n.', 6),
      c('x1', '任性的, 固执的', 'adj.', 9),
      c('x2', '做女王', 'vi.', 4),
    ];
    const picked = pickDistractors(correct, pool, 3);
    expect(picked).toHaveLength(3);
    const keys = picked.map((p) => p.key);
    // n1/n2 同词性（+2）且结构/长度相近，应稳进前 3
    expect(keys).toContain('n1');
    expect(keys).toContain('n2');
  });

  it('不含正确项自身，也不含同 zh 的重复释义', () => {
    const pool = [
      c('a#1', '珍珠, 珠灰色, 杰出者', 'n.', 5), // 同 zh 的重复义项
      c('b#0', '珍珠, 珠灰色, 杰出者', 'n.', 6), // 与正确项同 zh
      c('n1', '王后, 女王', 'n.', 4),
      c('n2', '回顾, 追忆, 反省', 'n.', 6),
      c('n3', '荣誉, 尊敬', 'n.', 7),
    ];
    const picked = pickDistractors(correct, pool, 3);
    for (const p of picked) {
      expect(p.key).not.toBe(correct.key);
      expect(p.zh).not.toBe(correct.zh);
    }
  });

  it('池子不足时放宽补齐到 n 个', () => {
    const pool = [c('x1', '立为女王', 'vt.', 4)];
    expect(pickDistractors(correct, pool, 3)).toHaveLength(1);
  });

  it('同词义项不互为干扰（用户 2026-10-15：同词同读音哪怕不同词性也是同一个单词）', () => {
    // 正确项 lemma=word-a#0（c() 默认 lemma=`word-${key}`）；同词义项显式同名 lemma
    const sameWordSense: DistractorCandidate = {
      ...c('a#3', '约会, 委任的职位', 'n.', 5),
      lemma: correct.lemma,
    };
    const pool = [
      sameWordSense, // 同词不同义项：必须被排除
      c('n1', '王后, 女王', 'n.', 4),
      c('n2', '回顾, 追忆, 反省', 'n.', 6),
      c('n3', '荣誉, 尊敬', 'n.', 7),
    ];
    const picked = pickDistractors(correct, pool, 3);
    for (const p of picked) {
      expect(p.lemma).not.toBe(correct.lemma);
    }
    expect(picked.map((p) => p.key)).not.toContain('a#3');
  });

  it('buildOptions：正确项 + 3 干扰，共 4 个且互不重复', () => {
    const pool = [
      c('n1', '王后, 女王', 'n.', 4),
      c('n2', '回顾, 追忆, 反省', 'n.', 6),
      c('v1', '用珍珠镶, 使成珠状', 'vt.', 5),
      c('x1', '任性的, 固执的', 'adj.', 9),
    ];
    const opts = buildOptions(correct, pool);
    expect(opts).toHaveLength(4);
    expect(new Set(opts.map((o) => o.key)).size).toBe(4);
    expect(opts.map((o) => o.key)).toContain(correct.key);
  });
});
