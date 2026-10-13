/**
 * seedArpabet.test.ts —— T7 单测：seed v2 的 arpabet 透传（seedToDocs / seedToDomainDocs）。
 * 断言依据：架构增量 §六 T7 验收②（ipa 用文件内派生值；arpabet 命中才透传，未命中无该键）。
 */
import { describe, expect, it } from 'vitest';
import { CET6_BOOK_ID, seedToDocs } from '../../src/data/seedBootstrap';
import { seedToDomainDocs } from '../../src/data/seed/importEcdict';

const SEED = [
  { lemma: 'academy', ipa: '/ə.ˈkæ.də.mi/', arpabet: 'AH0 K AE1 D AH0 M IY0', translation: 'n. 学院', frq: 4895, tags: ['cet6'] },
  { lemma: 'wilful', ipa: "/'wilful/", translation: 'a. 任性的', frq: 44654, tags: ['cet6'] }, // CMUdict 未命中：无 arpabet
];

describe('seedToDocs（seedBootstrap）透传 arpabet', () => {
  const { words } = seedToDocs(SEED, CET6_BOOK_ID, 50);

  it('命中词：word 文档含 arpabet，ipa 用文件内派生值', () => {
    const hit = words.find((w) => w.lemma === 'academy');
    expect(hit?.arpabet).toBe('AH0 K AE1 D AH0 M IY0');
    expect(hit?.ipa).toBe('/ə.ˈkæ.də.mi/');
    expect(hit?.id).toBe('word_academy');
  });

  it('未命中词：无 arpabet 键，ipa 保留原值', () => {
    const miss = words.find((w) => w.lemma === 'wilful');
    expect(miss && Object.prototype.hasOwnProperty.call(miss, 'arpabet')).toBe(false);
    expect(miss?.ipa).toBe("/'wilful/");
  });
});

describe('seedToDomainDocs（importEcdict）透传 arpabet（与 seedBootstrap 一致）', () => {
  const { words } = seedToDomainDocs(SEED, CET6_BOOK_ID, 50) as unknown as { words: Record<string, unknown>[] };

  it('命中词透传 arpabet；未命中词无 arpabet 键', () => {
    const hit = words.find((w) => w.lemma === 'academy');
    expect(hit?.arpabet).toBe('AH0 K AE1 D AH0 M IY0');
    expect(hit?.ipa).toBe('/ə.ˈkæ.də.mi/');
    const miss = words.find((w) => w.lemma === 'wilful');
    expect(miss && 'arpabet' in miss).toBe(false);
  });
});
