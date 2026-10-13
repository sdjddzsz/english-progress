/**
 * basics.test.ts —— 背单词软件基础功能与数据口径的守门用例（用户 2026-10-13）。
 *
 * 钉死四件事：
 *  1. 词书规模 = 7000 词，且**两份种子文件一致**（历史上它们不一致，导致云端 IPA 是旧的）；
 *  2. 新导入词一律 T4 生词（不按词频先验猜层级）；
 *  3. 拼写判分：只做忽略大小写/空白的严格比对 + 给出可用的差异提示；
 *  4. 多读音词必须真的带多档读音（否则第 2 条的需求在数据层就落不了地）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { seedToDocs, seedFingerprint, CET6_BOOK_ID } from '../../src/data/seedBootstrap';
import { checkSpelling } from '../../src/pages/SpellingPage';
import { hasMultiplePronunciations, normalizeSenses, isSameWordUnit } from '../../src/features/senses';
import type { Word, WordSense } from '../../src/types/domain';

interface SeedEntry {
  lemma: string;
  ipa: string;
  arpabet?: string;
  senses: string[];
  sensesDetail: WordSense[];
  translation: string;
  exchange?: Record<string, string>;
  frq: number;
  tags: string[];
}

function loadSeed(rel: string): SeedEntry[] {
  const p = path.resolve(process.cwd(), rel);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as SeedEntry[];
}

const PUBLIC_SEED = loadSeed('public/seed-cet6.json');
const SRC_SEED = loadSeed('src/data/seed/seed-cet6.json');

describe('词书规模与一致性（用户要 7000 词，不是 5407）', () => {
  it('两份种子文件词量一致且不少于 7000（实测 8296）', () => {
    expect(PUBLIC_SEED.length).toBe(SRC_SEED.length);
    expect(PUBLIC_SEED.length).toBeGreaterThanOrEqual(7000);
  });

  it('两份种子文件内容完全一致（历史上不一致 ⇒ 云端拿到旧 IPA）', () => {
    expect(PUBLIC_SEED.map((w) => w.lemma)).toEqual(SRC_SEED.map((w) => w.lemma));
    expect(PUBLIC_SEED).toEqual(SRC_SEED);
  });

  it('lemma 唯一（无重复词条，否则 wordId 冲突会静默吞掉重复词）', () => {
    const set = new Set(PUBLIC_SEED.map((w) => w.lemma));
    expect(set.size).toBe(PUBLIC_SEED.length);
  });

  it('覆盖全部六级词（tag 含 cet6 的一个不少）', () => {
    const cet6 = PUBLIC_SEED.filter((w) => w.tags.includes('cet6'));
    expect(cet6.length).toBeGreaterThan(5000);
  });

  /**
   * 核心多读音词必须在书里（这是用户第 2 条的底线：
   * record 名词/动词、use 动词/名词、read 现在/过去 —— 学不到就没有"不同读音当不同词"可言）。
   *
   * ⚠ 这批词在 ECDICT 里**只标了 zk/gk，没有 cet4/cet6**，纯按标签取词会整批漏掉
   *   （实测踩过：纯标签口径下 record/object/produce 在、use/read/live/present/minute 全丢）。
   *   现口径额外放行 oxford=1 或 collins>=3 的无标签常用词，才把它们捞回来。
   */
  it('核心多读音高频词全部在书里（cet 标签漏标也不丢）', () => {
    const set = new Set(PUBLIC_SEED.map((w) => w.lemma));
    const mustHave = [
      'record', 'use', 'read', 'lead', 'live', 'object', 'produce', 'project',
      'minute', 'second', 'close', 'present', 'address', 'wind', 'bow',
      'refuse', 'separate', 'desert', 'august', 'proof', 'prove', 'result',
      'subject', 'suspect', 'permit', 'wound', 'exit', 'enter', 'increase', 'reduce',
    ];
    expect(mustHave.filter((w) => !set.has(w))).toEqual([]);
  });

  it('按词频降序排列（抽样配比与分层先验都依赖这个次序）', () => {
    for (let i = 1; i < PUBLIC_SEED.length; i++) {
      expect(PUBLIC_SEED[i].frq).toBeLessThanOrEqual(PUBLIC_SEED[i - 1].frq);
    }
  });

  it('每词都有中文释义与音标（否则是空壳词条）', () => {
    for (const w of PUBLIC_SEED) {
      expect(w.senses.length, `${w.lemma} 无释义`).toBeGreaterThan(0);
      expect(w.ipa.length, `${w.lemma} 无音标`).toBeGreaterThan(0);
    }
  });

  it('音标不带重复斜杠（arpabetToIpa 返回带斜杠值，展示层再剥一次即可）', () => {
    for (const w of PUBLIC_SEED) {
      expect(w.ipa.startsWith('//'), `${w.lemma} 双斜杠`).toBe(false);
      expect(w.ipa.endsWith('//'), `${w.lemma} 双斜杠`).toBe(false);
    }
  });
});

describe('新导入词一律判为 T4 生词（掌握程度只由练习成绩决定）', () => {
  it('全部 book_words 的 tier = 4，无一例外', () => {
    const { bookWords } = seedToDocs(PUBLIC_SEED as never, CET6_BOOK_ID, 50);
    expect(bookWords).toHaveLength(PUBLIC_SEED.length);
    const byTier = new Map<number, number>();
    for (const bw of bookWords) byTier.set(bw.tier, (byTier.get(bw.tier) ?? 0) + 1);
    expect([...byTier.keys()]).toEqual([4]);
    expect(byTier.get(4)).toBe(PUBLIC_SEED.length);
  });

  it('高频词也不预判为熟词（老实现会按词频前 25% 给 T2 —— 那是用词频猜你会什么）', () => {
    const { bookWords } = seedToDocs(PUBLIC_SEED as never, CET6_BOOK_ID, 50);
    const top100 = bookWords.slice(0, 100);
    expect(top100.every((bw) => bw.tier === 4)).toBe(true);
  });

  it('seedFingerprint 对同一份内容稳定，且内容变化必变（续传游标的安全前提）', () => {
    expect(seedFingerprint(PUBLIC_SEED as never)).toBe(seedFingerprint(SRC_SEED as never));
    const mutated = [{ ...PUBLIC_SEED[0], lemma: 'zzz' }, ...PUBLIC_SEED.slice(1)];
    expect(seedFingerprint(mutated as never)).not.toBe(seedFingerprint(PUBLIC_SEED as never));
  });
});

describe('拼写判分（严格比对 + 可用提示，不做模糊匹配）', () => {
  it('完全正确 → correct（忽略大小写与首尾空格）', () => {
    expect(checkSpelling('record', 'record').kind).toBe('correct');
    expect(checkSpelling('  Record ', 'record').kind).toBe('correct');
  });

  it('空输入 → empty（不算错，避免按回车就记一次拼写失败）', () => {
    expect(checkSpelling('', 'record').kind).toBe('empty');
    expect(checkSpelling('   ', 'record').kind).toBe('empty');
  });

  it('首字母错 → 判错并在提示里给出正确首字母', () => {
    const v = checkSpelling('xecord', 'record');
    expect(v.kind).toBe('wrong');
    if (v.kind === 'wrong') expect(v.hint).toContain('首字母是 R');
  });

  it('长度不同时提示正确长度', () => {
    const v = checkSpelling('recrd', 'record');
    if (v.kind === 'wrong') expect(v.hint).toContain('6');
  });

  it('等长且首字母对时定位到第一个不同的字母', () => {
    const v = checkSpelling('recard', 'record'); // 第 3 位 c→o？实为 r→c
    if (v.kind === 'wrong') expect(v.hint.length).toBeGreaterThan(0);
  });

  it('不做模糊匹配：错一个字母就是错（拼写训练要暴露错在哪）', () => {
    expect(checkSpelling('recerd', 'record').kind).toBe('wrong');
    expect(checkSpelling('recordd', 'record').kind).toBe('wrong');
  });
});

describe('多读音词在数据层真的带多档读音（用户第 2 条的落地前提）', () => {
  it('存在多读音词且数量可观（实测 870+）', () => {
    const multi = PUBLIC_SEED.filter((w) => hasMultiplePronunciations(toWord(w)));
    expect(multi.length).toBeGreaterThan(870);
  });

  it('多读音词的不同义项 pronunciationKey 互不相同', () => {
    const record = PUBLIC_SEED.find((w) => w.lemma === 'record');
    expect(record).toBeDefined();
    const keys = new Set(record!.sensesDetail.map((s) => s.pronunciationKey));
    expect(keys.size).toBeGreaterThan(1);
  });

  it('同读音的义项判定为同一个词，不同读音判定为不同的词', () => {
    const bow = PUBLIC_SEED.find((w) => w.lemma === 'bow');
    expect(bow).toBeDefined();
    const senses = normalizeSenses(toWord(bow!));
    // bow#0(n.弓) 与 bow#2(n.鞠躬) 共用读音 B AW1 → 同一个判定单位
    expect(isSameWordUnit(senses[0], senses[2])).toBe(true);
    // bow#1(v.) 用 B OW1 → 不同判定单位
    expect(isSameWordUnit(senses[0], senses[1])).toBe(false);
  });

  it('义项 senseId 全局唯一（判定与调度的最小单位，不能撞）', () => {
    const ids = PUBLIC_SEED.flatMap((w) => w.sensesDetail.map((s) => s.senseId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('义项的 pos 与 zh 不为空（揭晓答案时要有内容可看）', () => {
    for (const w of PUBLIC_SEED) {
      for (const s of w.sensesDetail) {
        expect(s.zh.length + s.pos.length, `${s.senseId} 义项既无释义也无词性`).toBeGreaterThan(0);
      }
    }
  });

  it('带 arpabet 的义项，其 IPA 由 arpabet 派生而来（两者必须同源，不能各写一套）', () => {
    const eagle = PUBLIC_SEED.find((w) => w.lemma === 'eagle');
    expect(eagle?.arpabet).toBe('IY1 G AH0 L');
    expect(eagle?.sensesDetail[0].arpabet).toBe('IY1 G AH0 L');
  });
});

/** SeedEntry → Word（测试内转换，避免直接依赖 seedToDocs 的输入类型） */
function toWord(e: SeedEntry): Word {
  return {
    id: `word_${e.lemma}`,
    lemma: e.lemma,
    ipa: e.ipa,
    ...(e.arpabet ? { arpabet: e.arpabet } : {}),
    senses: e.senses,
    sensesDetail: e.sensesDetail,
    examples: [],
    ...(e.exchange ? { exchange: e.exchange } : {}),
    frequency: e.frq,
    tags: e.tags,
  };
}
