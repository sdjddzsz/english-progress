/**
 * ECDICT 裁剪导入脚本（种子数据，架构文档 T02：importEcdict.ts）。
 *
 * 用法：
 *   1) 全量导入（推荐，上线前必须执行一次）：
 *      npx tsx src/data/seed/importEcdict.ts --csv <ECDICT.csv 路径> --out src/data/seed/seed-cet6.json
 *      （ECDICT CSV 可从 GitHub kimjix/ECDICT、openkg 等公开镜像获取，或官方 npm 包 `ecdict`）
 *   2) 无 CSV 时输出内置样例种子（⚠ 仅用于开发跑通链路，上线前替换全量！）：
 *      npx tsx src/data/seed/importEcdict.ts --out src/data/seed/seed-cet6.json
 *
 * 裁剪口径（主理人拍板）：word + IPA 音标 + 中文释义 + 词频 + 四/六级标记；
 * 例句【不】随包（例句后续按需从云端补）。输出按词频降序，供摸底抽样加权。
 *
 * 推送云端（可选，需 .env 已配置且已登录）：
 *   npx tsx src/data/seed/importEcdict.ts --csv <path> --push --book <bookId> --user <userId>
 */
import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';

export interface SeedWord {
  lemma: string;
  ipa: string;
  /** CMUdict ARPAbet 发音真源（T7：由 joinCmuDict 脚本写入；命中才有，未命中无此字段） */
  arpabet?: string;
  translation: string;
  frq: number;
  tags: string[]; // 'cet4' | 'cet6' ...
}

// ===== 内置样例种子（60 词，真实六级高频词；上线前用 ECDICT CSV 替换全量 ~7000 词）=====
export const SAMPLE_SEED: SeedWord[] = [
  { lemma: 'accommodate', ipa: '/əˈkɒm.ə.deɪt/', translation: 'v. 容纳；向…提供住处；适应', frq: 12013, tags: ['cet4', 'cet6'] },
  { lemma: 'acknowledge', ipa: '/əkˈnɒl.ɪdʒ/', translation: 'v. 承认；答谢；告知收到', frq: 11465, tags: ['cet4', 'cet6'] },
  { lemma: 'adequate', ipa: '/ˈæd.ɪ.kwət/', translation: 'adj. 足够的；适当的', frq: 9823, tags: ['cet4', 'cet6'] },
  { lemma: 'advocate', ipa: '/ˈæd.və.keɪt/', translation: 'v. 提倡，主张 n. 拥护者', frq: 8712, tags: ['cet6'] },
  { lemma: 'ambiguous', ipa: '/æmˈbɪɡ.ju.əs/', translation: 'adj. 模棱两可的，含糊不清的', frq: 7456, tags: ['cet6'] },
  { lemma: 'anticipate', ipa: '/ænˈtɪs.ɪ.peɪt/', translation: 'v. 预期，预料；先于…行动', frq: 10234, tags: ['cet4', 'cet6'] },
  { lemma: 'apparent', ipa: '/əˈpær.ənt/', translation: 'adj. 显然的；表面上的', frq: 9102, tags: ['cet4', 'cet6'] },
  { lemma: 'appreciate', ipa: '/əˈpriː.ʃi.eɪt/', translation: 'v. 欣赏；感激；领会', frq: 10876, tags: ['cet4', 'cet6'] },
  { lemma: 'arbitrary', ipa: '/ˈɑː.bɪ.trər.i/', translation: 'adj. 任意的；武断的', frq: 6321, tags: ['cet6'] },
  { lemma: 'articulate', ipa: '/ɑːˈtɪk.jə.leɪt/', translation: 'v. 清楚表达 adj. 口齿清晰的', frq: 4210, tags: ['cet6'] },
  { lemma: 'assess', ipa: '/əˈses/', translation: 'v. 评估，估价', frq: 12430, tags: ['cet4', 'cet6'] },
  { lemma: 'attribute', ipa: '/ˈæd.trɪ.bjuːt/', translation: 'v. 把…归因于 n. 属性', frq: 10054, tags: ['cet4', 'cet6'] },
  { lemma: 'benchmark', ipa: '/ˈbentʃ.mɑːk/', translation: 'n. 基准，参照标准', frq: 5487, tags: ['cet6'] },
  { lemma: 'bias', ipa: '/ˈbaɪ.əs/', translation: 'n. 偏见 v. 使有偏见', frq: 8642, tags: ['cet6'] },
  { lemma: 'boost', ipa: '/buːst/', translation: 'v. 增强，推动 n. 推动', frq: 7985, tags: ['cet6'] },
  { lemma: 'boundary', ipa: '/ˈbaʊn.dri/', translation: 'n. 边界，分界线', frq: 7620, tags: ['cet4', 'cet6'] },
  { lemma: 'capture', ipa: '/ˈkæp.tʃər/', translation: 'v. 捕获；夺取；记录', frq: 10450, tags: ['cet4', 'cet6'] },
  { lemma: 'cease', ipa: '/siːs/', translation: 'v. 停止，终止', frq: 5914, tags: ['cet6'] },
  { lemma: 'circumstance', ipa: '/ˈsɜː.kəm.stɑːns/', translation: 'n. 环境，情况', frq: 9530, tags: ['cet4', 'cet6'] },
  { lemma: 'coherent', ipa: '/kəʊˈhɪə.rənt/', translation: 'adj. 连贯的，一致的', frq: 4310, tags: ['cet6'] },
  { lemma: 'collaborate', ipa: '/kəˈlæb.ə.reɪt/', translation: 'v. 合作，协作', frq: 5230, tags: ['cet6'] },
  { lemma: 'commodity', ipa: '/kəˈmɒd.ə.ti/', translation: 'n. 商品，日用品', frq: 6890, tags: ['cet6'] },
  { lemma: 'compatible', ipa: '/kəmˈpæt.ə.bəl/', translation: 'adj. 兼容的；合得来的', frq: 5721, tags: ['cet6'] },
  { lemma: 'compensate', ipa: '/ˈkɒm.pən.seɪt/', translation: 'v. 补偿，弥补', frq: 7140, tags: ['cet6'] },
  { lemma: 'competent', ipa: '/ˈkɒm.pɪ.tənt/', translation: 'adj. 有能力的，胜任的', frq: 5410, tags: ['cet6'] },
  { lemma: 'comprehensive', ipa: '/ˌkɒm.prɪˈhen.sɪv/', translation: 'adj. 全面的，综合的', frq: 11020, tags: ['cet4', 'cet6'] },
  { lemma: 'comprise', ipa: '/kəmˈpraɪz/', translation: 'v. 包含，由…组成', frq: 5124, tags: ['cet6'] },
  { lemma: 'compromise', ipa: '/ˈkɒm.prə.maɪz/', translation: 'n./v. 妥协，折中', frq: 7330, tags: ['cet4', 'cet6'] },
  { lemma: 'conceal', ipa: '/kənˈsiːl/', translation: 'v. 隐藏，隐瞒', frq: 4650, tags: ['cet6'] },
  { lemma: 'conceive', ipa: '/kənˈsiːv/', translation: 'v. 构想，设想；怀孕', frq: 4320, tags: ['cet6'] },
  { lemma: 'confer', ipa: '/kənˈfɜːr/', translation: 'v. 商讨；授予', frq: 4102, tags: ['cet6'] },
  { lemma: 'conform', ipa: '/kənˈfɔːm/', translation: 'v. 遵守，符合', frq: 5210, tags: ['cet6'] },
  { lemma: 'confront', ipa: '/kənˈfrʌnt/', translation: 'v. 面对，对抗', frq: 6875, tags: ['cet6'] },
  { lemma: 'consecutive', ipa: '/kənˈsek.jə.tɪv/', translation: 'adj. 连续的', frq: 4401, tags: ['cet6'] },
  { lemma: 'consensus', ipa: '/kənˈsen.səs/', translation: 'n. 共识，一致', frq: 7120, tags: ['cet6'] },
  { lemma: 'consent', ipa: '/kənˈsent/', translation: 'n./v. 同意，准许', frq: 6210, tags: ['cet6'] },
  { lemma: 'conserve', ipa: '/kənˈsɜːv/', translation: 'v. 保护，保存；节约', frq: 3980, tags: ['cet6'] },
  { lemma: 'consistent', ipa: '/kənˈsɪs.tənt/', translation: 'adj. 一致的，始终如一的', frq: 12130, tags: ['cet4', 'cet6'] },
  { lemma: 'consolidate', ipa: '/kənˈsɒl.ɪ.deɪt/', translation: 'v. 巩固；合并', frq: 3810, tags: ['cet6'] },
  { lemma: 'constitute', ipa: '/ˈkɒn.stɪ.tjuːt/', translation: 'v. 构成；设立', frq: 8340, tags: ['cet6'] },
  { lemma: 'constrain', ipa: '/kənˈstreɪn/', translation: 'v. 限制，约束', frq: 5610, tags: ['cet6'] },
  { lemma: 'consult', ipa: '/kənˈsʌlt/', translation: 'v. 咨询；查阅', frq: 8940, tags: ['cet4', 'cet6'] },
  { lemma: 'contaminate', ipa: '/kənˈtæm.ɪ.neɪt/', translation: 'v. 污染', frq: 3450, tags: ['cet6'] },
  { lemma: 'contemplate', ipa: '/ˈkɒn.təm.pleɪt/', translation: 'v. 沉思；考虑', frq: 3620, tags: ['cet6'] },
  { lemma: 'contemporary', ipa: '/kənˈtem.prə.rər.i/', translation: 'adj. 当代的；同时代的', frq: 9210, tags: ['cet4', 'cet6'] },
  { lemma: 'contradict', ipa: '/ˌkɒn.trəˈdɪkt/', translation: 'v. 反驳；与…矛盾', frq: 4210, tags: ['cet6'] },
  { lemma: 'convey', ipa: '/kənˈveɪ/', translation: 'v. 传达，传递；运送', frq: 7150, tags: ['cet6'] },
  { lemma: 'convince', ipa: '/kənˈvɪns/', translation: 'v. 说服，使确信', frq: 11240, tags: ['cet4', 'cet6'] },
  { lemma: 'coordinate', ipa: '/kəʊˈɔː.dɪ.neɪt/', translation: 'v. 协调 n. 坐标', frq: 6420, tags: ['cet6'] },
  { lemma: 'correspond', ipa: '/ˌkɒr.ɪˈspɒnd/', translation: 'v. 符合；通信；相当于', frq: 6110, tags: ['cet6'] },
  { lemma: 'crucial', ipa: '/ˈkruː.ʃəl/', translation: 'adj. 至关重要的', frq: 13540, tags: ['cet4', 'cet6'] },
  { lemma: 'cultivate', ipa: '/ˈkʌl.tɪ.veɪt/', translation: 'v. 培养；耕作', frq: 5980, tags: ['cet6'] },
  { lemma: 'cumulative', ipa: '/ˈkjuː.mjə.lə.tɪv/', translation: 'adj. 累积的', frq: 3210, tags: ['cet6'] },
  { lemma: 'curb', ipa: '/kɜːb/', translation: 'v. 控制，约束 n. 路缘', frq: 3890, tags: ['cet6'] },
  { lemma: 'curriculum', ipa: '/kəˈrɪk.jə.ləm/', translation: 'n. 课程，课程体系', frq: 4720, tags: ['cet6'] },
  { lemma: 'deteriorate', ipa: '/dɪˈtɪə.ri.ə.reɪt/', translation: 'v. 恶化，变坏', frq: 3140, tags: ['cet6'] },
  { lemma: 'diminish', ipa: '/dɪˈmɪn.ɪʃ/', translation: 'v. 减少，削弱', frq: 4460, tags: ['cet6'] },
  { lemma: 'discern', ipa: '/dɪˈsɜːn/', translation: 'v. 辨别，察觉', frq: 2870, tags: ['cet6'] },
  { lemma: 'elaborate', ipa: '/ɪˈlæb.ə.reɪt/', translation: 'v. 详述 adj. 精心制作的', frq: 5340, tags: ['cet6'] },
  { lemma: 'eligible', ipa: '/ˈel.ɪ.dʒə.bəl/', translation: 'adj. 有资格的', frq: 4120, tags: ['cet6'] },
];

// ===== CSV 行 → 种子词（ECDICT 标准字段）=====

interface EcdictRow {
  word?: string;
  phonetic?: string;
  translation?: string;
  definition?: string;
  frq?: string;
  bnc?: string;
  tag?: string;
}

/** tag 字段形如 "cet4 cet6 ky toefl"；空格分隔 */
function parseTags(tag: string | undefined): string[] {
  if (!tag) return [];
  const tags: string[] = [];
  const parts = tag.trim().toLowerCase().split(/\s+/);
  if (parts.includes('cet4')) tags.push('cet4');
  if (parts.includes('cet6')) tags.push('cet6');
  return tags;
}

function rowToSeed(row: EcdictRow): SeedWord | null {
  const lemma = row.word?.trim().toLowerCase();
  if (!lemma) return null;
  const tags = parseTags(row.tag);
  // 裁剪口径：六级词（含四级标记的六级词书通常覆盖四级，这里保留 cet4/cet6 标记词）
  if (!tags.includes('cet6')) return null;
  const frq = Number(row.frq ?? row.bnc ?? 0) || 0;
  return {
    lemma,
    ipa: row.phonetic?.trim() ? `/${row.phonetic.trim()}/` : '',
    translation: (row.translation ?? row.definition ?? '').trim().replace(/\\n/g, '；'),
    frq,
    tags,
  };
}

function parseArgs(): { csv?: string; out?: string; push: boolean; bookId?: string; userId?: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    csv: get('--csv'),
    out: get('--out'),
    push: args.includes('--push'),
    bookId: get('--book'),
    userId: get('--user'),
  };
}

/** 种子词 → Word / BookWord 领域文档（--push 模式用） */
export function seedToDomainDocs(
  seed: SeedWord[],
  bookId: string,
  listSize: number,
): { words: Record<string, unknown>[]; bookWords: Record<string, unknown>[] } {
  const words: Record<string, unknown>[] = [];
  const bookWords: Record<string, unknown>[] = [];
  seed.forEach((w, idx) => {
    // 简易四层：词频前 25% → T2，其余按序均分 T3/T4（正式分层由摸底校准覆盖）
    const tier = idx < seed.length * 0.25 ? 2 : idx < seed.length * 0.6 ? 3 : 4;
    const wordId = `word_${w.lemma}`;
    words.push({
      id: wordId,
      lemma: w.lemma,
      // ipa 用 seed 文件内派生值；arpabet 命中才透传（与 seedBootstrap.seedToDocs 保持一致）
      ipa: w.ipa,
      ...(w.arpabet ? { arpabet: w.arpabet } : {}),
      senses: w.translation ? [w.translation] : [],
      examples: [],
      frequency: w.frq,
      tags: w.tags,
    });
    bookWords.push({
      id: `bw_${bookId}_${w.lemma}`,
      bookId,
      wordId,
      listNo: Math.floor(idx / listSize) + 1,
      orderInList: (idx % listSize) + 1,
      tier,
      tierUpdatedAt: new Date().toISOString(),
      status: 'normal',
    });
  });
  return { words, bookWords };
}

async function main(): Promise<void> {
  const { csv, out, push, bookId, userId } = parseArgs();
  let seed: SeedWord[];

  if (csv) {
    console.log(`[importEcdict] reading ${csv} ...`);
    const text = fs.readFileSync(path.resolve(csv), 'utf-8');
    const parsed = Papa.parse<EcdictRow>(text, { header: true, skipEmptyLines: true });
    const seen = new Set<string>();
    seed = [];
    for (const row of parsed.data) {
      const s = rowToSeed(row);
      if (s && !seen.has(s.lemma)) {
        seen.add(s.lemma);
        seed.push(s);
      }
    }
    console.log(`[importEcdict] extracted ${seed.length} CET6 words`);
  } else {
    console.warn(
      '[importEcdict] WARNING: no --csv given, writing BUILT-IN SAMPLE seed ' +
        '(development only — replace with the full ECDICT export before going live! ' +
        '样例种子仅用于开发，上线前必须替换全量 ECDICT 导入)',
    );
    seed = SAMPLE_SEED;
  }

  seed.sort((a, b) => b.frq - a.frq);

  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), JSON.stringify(seed, null, 2), 'utf-8');
    console.log(`[importEcdict] wrote ${seed.length} words → ${out}`);
  }

  if (push) {
    // 动态 import：保持脚本在无云配置时也能产出 JSON
    const { createWordRepo } = await import('../repos/wordRepo');
    if (!bookId || !userId) {
      console.error('[importEcdict] --push requires --book <bookId> and --user <userId>');
      process.exit(1);
    }
    const repo = createWordRepo();
    const docs = seedToDomainDocs(seed, bookId, 50);
    console.log(`[importEcdict] pushing ${docs.words.length} words / ${docs.bookWords.length} book_words to cloud ...`);
    await repo.upsertWords(docs.words as never);
    await repo.upsertBookWords(docs.bookWords as never);
    console.log('[importEcdict] push done');
  }
}

// 直接执行时运行 main；被测试 import 时不执行
if (process.argv[1] && process.argv[1].endsWith('importEcdict.ts')) {
  main().catch((err) => {
    console.error('[importEcdict] failed:', err);
    process.exit(1);
  });
}
