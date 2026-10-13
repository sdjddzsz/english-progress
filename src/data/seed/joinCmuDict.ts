/**
 * joinCmuDict.ts —— 构建期 CMUdict ⋈ seed 脚本（架构增量 v0.1，T1）。
 *
 * 作用：把 CMUdict（ARPAbet 发音真源）join 进 `public/seed-cet6.json`：
 *  - 命中词：写入 `arpabet`（CMUdict 原值，DashScope `<phoneme alphabet="cmu">` 零转换直用），
 *            并把 `ipa` 覆盖为 `arpabetToIpa` 派生值（展示与 espeak 兜底共用同一真源）；
 *  - 未命中词：不写 `arpabet`，`ipa` 保留 ECDICT 原值（P0-9 降级语义）。
 *
 * 用法：
 *   npm run seed:cmu                                   # 默认读/写 public/seed-cet6.json，用 npm 包词库
 *   npx tsx src/data/seed/joinCmuDict.ts --cmudict-file <cmudict.dict 路径>   # 备选：官方文本词库
 *   npx tsx src/data/seed/joinCmuDict.ts --report <输出路径>                  # 覆盖率报告 JSON
 *
 * 契约（架构增量 §5.4 / §七.9）：
 *  - 输出字段顺序固定 `lemma, arpabet, ipa, translation, frq, tags`；`arpabet` 仅命中时出现；2 空格缩进；
 *  - 只 import `src/tts/*` 的纯函数（`arpabetToIpa`），**不 import 任何其它应用代码**，
 *    避免把云端 SDK / React 依赖带进构建期；
 *  - 重生成只走本脚本，不手改 seed 文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { arpabetToIpa } from '../../tts/arpabetToIpa';

/** seed 输入词（与 ECDICT 产物对齐；不含 arpabet——由本脚本派生） */
export interface SeedWord {
  lemma: string;
  ipa: string;
  translation: string;
  frq: number;
  tags: string[];
}

/** seed 输出词（v2）：字段顺序即 JSON 序列化顺序（lemma, arpabet, ipa, translation, frq, tags） */
export interface SeedWordV2 {
  lemma: string;
  /** CMUdict ARPAbet 原值；仅命中时出现 */
  arpabet?: string;
  /** 命中 = arpabetToIpa 派生值；未命中 = 保留 ECDICT 原值 */
  ipa: string;
  translation: string;
  frq: number;
  tags: string[];
}

/** 覆盖率报告（stdout + 可选 JSON 文件） */
export interface JoinReport {
  total: number;
  hit: number;
  miss: number;
  /** 命中率 0~1 */
  hitRate: number;
  /** 未命中 lemma 清单（人工过目，P2-2 校正候选） */
  misses: string[];
  /** 使用了编号变体（非主词条）的词数 */
  variantCount: number;
}

/** CMUdict 词库形态：小写词形（含编号变体）→ ARPAbet 音素串 */
export type CmuDict = Record<string, string>;

/** 编号变体键 `word(1)` / `word(2)` … */
const VARIANT_RE = /^(.+?)\((\d+)\)$/;

/** 索引条目：选中音素串 + 是否来自编号变体 */
interface CmuEntry {
  phonemes: string;
  variant: boolean;
}

/**
 * 一次扫描构建「基础词 → 选中主词条」索引（O(N)，供 joinSeedWithCmu 高效批量使用）。
 * 选择规则（Q2）：`WORD` 优先于 `WORD(1)`；无主词条时取编号最小的变体。
 */
export function buildSelectedIndex(dict: CmuDict): Map<string, CmuEntry> {
  const index = new Map<string, CmuEntry>();
  const variantNum = new Map<string, number>();
  // 第一遍：编号变体（记录每个 base 的最小编号）
  for (const key of Object.keys(dict)) {
    const m = VARIANT_RE.exec(key);
    if (!m) continue;
    const base = m[1];
    const num = Number(m[2]);
    const cur = variantNum.get(base);
    if (cur === undefined || num < cur) {
      variantNum.set(base, num);
      index.set(base, { phonemes: dict[key], variant: true });
    }
  }
  // 第二遍：主词条（无编号）覆盖变体选择
  for (const key of Object.keys(dict)) {
    if (VARIANT_RE.test(key)) continue;
    index.set(key, { phonemes: dict[key], variant: false });
  }
  return index;
}

/**
 * 主词条选择（Q2，纯函数，单测锚点）：`WORD` 优先于 `WORD(1)/WORD(2)…`；只有编号条目时取编号最小；
 * 均无 → undefined。大小写不敏感（内部转小写）。
 *
 * 注：本函数为「单次查询」语义，内部每次重建索引（O(N)）；批量场景请直接用 `buildSelectedIndex`
 * 一次建索引后查 Map（`joinSeedWithCmu` 即如此），避免 O(N×M)。
 */
export function selectMainEntry(dict: CmuDict, lemma: string): string | undefined {
  const key = lemma.trim().toLowerCase();
  if (!key) return undefined;
  return buildSelectedIndex(dict).get(key)?.phonemes;
}

/**
 * 纯函数部分（可单测）：seed ⋈ CMUdict → 新 seed + 报告。
 * 命中：写 arpabet + 派生 ipa；未命中 / 音素非法：不写 arpabet，保留 ECDICT ipa，计入 misses。
 */
export function joinSeedWithCmu(seed: SeedWord[], dict: CmuDict): { seed: SeedWordV2[]; report: JoinReport } {
  const index = buildSelectedIndex(dict);
  const misses: string[] = [];
  let hit = 0;
  let variantCount = 0;

  const out: SeedWordV2[] = seed.map((w) => {
    const entry = index.get(w.lemma.trim().toLowerCase());
    const passthrough: SeedWordV2 = {
      lemma: w.lemma,
      ipa: w.ipa,
      translation: w.translation,
      frq: w.frq,
      tags: w.tags,
    };
    if (!entry) {
      misses.push(w.lemma);
      return passthrough;
    }
    let ipa: string;
    try {
      ipa = arpabetToIpa(entry.phonemes);
    } catch {
      // CMUdict 音素串非法（极少数）：按未命中处理，保留 ECDICT ipa，不阻断整体生成
      misses.push(w.lemma);
      return passthrough;
    }
    hit += 1;
    if (entry.variant) variantCount += 1;
    return {
      lemma: w.lemma,
      arpabet: entry.phonemes,
      ipa,
      translation: w.translation,
      frq: w.frq,
      tags: w.tags,
    };
  });

  const total = seed.length;
  const miss = misses.length;
  const report: JoinReport = {
    total,
    hit,
    miss,
    hitRate: total === 0 ? 0 : hit / total,
    misses,
    variantCount,
  };
  return { seed: out, report };
}

/**
 * 解析官方 `cmudict.dict` 文本（每行 `WORD  PHONEMES`，变体 `WORD(1)`，`;;;` 为注释）。
 * 键统一转小写，返回与 npm 包同形态的字典对象。
 */
export function parseCmudictText(text: string): CmuDict {
  const dict: CmuDict = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';;;') || line.startsWith('#')) continue;
    // 行尾 `#` 后为注释
    const hashIdx = line.indexOf('#');
    const body = (hashIdx >= 0 ? line.slice(0, hashIdx) : line).trim();
    if (!body) continue;
    const parts = body.split(/\s+/);
    const word = parts[0].toLowerCase();
    const phonemes = parts.slice(1).join(' ');
    if (!word || !phonemes) continue;
    dict[word] = phonemes;
  }
  return dict;
}

// ===== CLI =====

interface CliArgs {
  seed: string;
  cmudictFile?: string;
  report?: string;
}

/** 解析 CLI 参数（Windows/Git Bash 友好：仅位置无关的 `--flag value`） */
export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    seed: get('--seed') ?? 'public/seed-cet6.json',
    cmudictFile: get('--cmudict-file'),
    report: get('--report'),
  };
}

/** 动态 import npm 词库（避免在 `--cmudict-file` 路径下强依赖包存在） */
async function loadNpmDict(): Promise<CmuDict> {
  const mod = (await import('cmu-pronouncing-dictionary')) as { dictionary?: CmuDict };
  if (!mod.dictionary) {
    throw new Error('cmu-pronouncing-dictionary: named export "dictionary" not found');
  }
  return mod.dictionary;
}

function formatReport(report: JoinReport, source: string): string {
  const lines = [
    `[joinCmuDict] source = ${source}`,
    `[joinCmuDict] total=${report.total} hit=${report.hit} miss=${report.miss} ` +
      `hitRate=${(report.hitRate * 100).toFixed(2)}% variantCount=${report.variantCount}`,
  ];
  if (report.misses.length > 0) {
    lines.push(`[joinCmuDict] misses (${report.misses.length}): ${report.misses.join(', ')}`);
  } else {
    lines.push('[joinCmuDict] misses: (none)');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { seed, cmudictFile, report: reportPath } = parseCliArgs(process.argv);
  const seedAbs = path.resolve(seed);

  console.log(`[joinCmuDict] reading seed ${seedAbs} ...`);
  const rawSeed = JSON.parse(fs.readFileSync(seedAbs, 'utf-8')) as SeedWord[];
  if (!Array.isArray(rawSeed)) throw new Error(`seed is not an array: ${seedAbs}`);

  let dict: CmuDict;
  let source: string;
  if (cmudictFile) {
    const cmuAbs = path.resolve(cmudictFile);
    console.log(`[joinCmuDict] reading cmudict file ${cmuAbs} ...`);
    dict = parseCmudictText(fs.readFileSync(cmuAbs, 'utf-8'));
    source = `file:${cmuAbs}`;
  } else {
    console.log('[joinCmuDict] loading cmu-pronouncing-dictionary (npm) ...');
    dict = await loadNpmDict();
    source = 'npm:cmu-pronouncing-dictionary';
  }
  console.log(`[joinCmuDict] cmudict entries = ${Object.keys(dict).length}`);

  const { seed: joined, report } = joinSeedWithCmu(rawSeed, dict);

  fs.writeFileSync(seedAbs, `${JSON.stringify(joined, null, 2)}\n`, 'utf-8');
  console.log(`[joinCmuDict] wrote ${joined.length} words → ${seedAbs}`);

  if (reportPath) {
    const reportAbs = path.resolve(reportPath);
    fs.mkdirSync(path.dirname(reportAbs), { recursive: true });
    fs.writeFileSync(reportAbs, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    console.log(`[joinCmuDict] report → ${reportAbs}`);
  }

  console.log(formatReport(report, source));
}

// 直接执行时运行 main；被测试 import 时不执行
if (process.argv[1] && process.argv[1].endsWith('joinCmuDict.ts')) {
  main().catch((err) => {
    console.error('[joinCmuDict] failed:', err);
    process.exit(1);
  });
}
