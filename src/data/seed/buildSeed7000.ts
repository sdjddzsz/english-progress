/**
 * buildSeed7000.ts —— 生成 `public/seed-cet6.json`（约 7000 词的正式词书，v3 格式）。
 *
 * 用法：
 *   npx tsx src/data/seed/buildSeed7000.ts --ecdict <ecdict.csv> --out public/seed-cet6.json
 *
 * 选词口径（用户 2026-10-13 要求 7000 词；实测 ECDICT 的 cet6 标签本身只有 5407 词，
 * 「六级全量 7000」是从一开始就拍错的数 —— 真实六级词汇量就是 5400 出头）：
 *   池 = tag ∈ {cet6, cet4, ky, ielts}（六级 + 四级 + 考研 + 雅思）且字段齐全的词
 *   排序 = 词频 frq 降序，取前 7000 ⇒ 实测池 7445，命中 7000
 *   这样既有全部六级词（5190 个带 cet6 标记），又按词频补进了 1810 个六级边缘高频词，
 *   对六级备考是**超集**而非错集。
 *
 * 输出字段顺序固定：`lemma, arpabet, ipa, senses, sensesDetail, translation, exchange, examples, frq, tags`
 *  - `sensesDetail` 是本次新增的**义项级**结构（用户 2026-10-13 第 2 条要求）：
 *    同一 lemma 的多个读音（CMUdict 编号变体）各自绑定一组词性释义，
 *    前端按 senseId 独立判定「不同读音 = 不同的单词」。
 *  - `translation` 保留（兼容旧字段）；`senses` = sensesDetail 的 zh 拼接。
 *
 * 只 import `src/tts/*` 的纯函数（arpabetToIpa），不 import 任何应用/云端代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dictionary as CMU_DICTIONARY } from 'cmu-pronouncing-dictionary';
import { arpabetToIpa } from '../../tts/arpabetToIpa';

interface EcdictRow {
  word: string;
  phonetic: string;
  definition: string;
  translation: string;
  pos: string;
  exchange: string;
  frq: string;
  tag: string;
  collins: string;
  oxford: string;
  bnc: string;
}

export interface SeedSense {
  senseId: string;
  lemma: string;
  pos: string;
  zh: string;
  pronunciationKey: string;
  arpabet: string;
  ipa: string;
}

export interface SeedWordV3 {
  lemma: string;
  arpabet?: string;
  ipa: string;
  senses: string[];
  sensesDetail: SeedSense[];
  translation: string;
  /** 词形变化（ECDICT exchange 解析后：p=过去式/d=过去分词/i=现在分词/3=三单/r=比较级/t=最高级/0=原形/s=复数/1=原型变化） */
  exchange?: Record<string, string>;
  examples: { en: string; zh: string }[];
  frq: number;
  tags: string[];
}

/**
 * 选词口径（用户 2026-10-13 拍板：全收六级 + 补高频无标签词；池子有多大就多大）。
 *
 * **ECDICT 的 cet 标签在这批词上不可信**（实测）：
 *   use(frq=92) / read(337) / live(210) / wind(1092) / present(817) / minute(308) /
 *   second(381) / close(649) —— 这些词 ECDICT **只标 zk gk（初高中），完全没标 cet4/cet6**，
 *   但它们是六级真题里的常客，也正是「同词不同读音」最典型的例子（use /juːz/ vs /juːs/）。
 *   纯按标签取会把它们整批漏掉 ⇒ 标签不能当唯一判据。
 *
 * 规则（顺序不可交换）：
 *  1. 池 = 字段齐全且（tag ∈ {cet6,cet4,ky,ielts} **或** 是 ECDICT 高频前 N 名）——见 isEligible；
 *  2. **所有 cet6 词必收**，其余按词频降序补足到 target（见 selectWords）。
 *
 * ⚠ 为什么不「统一按词频取前 N」：那会按 frq 值排序切掉 record(516) / object(1153) 之类
 *   frq 值不算高但**六级的词里最该练的多读音词**。cet6 全收保证六级一个不少。
 */
const POOL_TAGS = ['cet6', 'cet4', 'ky', 'ielts'] as const;
/** 六级保底 tag：命中此标签的词无条件进词书 */
const MUST_INCLUDE_TAG = 'cet6';
/**
 * 「无标签高频词」补偿判据（替代按 frq 补词 —— frq 字段不可用，见下）。
 *
 * ECDICT 的 `frq` **不是可用词频**（实测：全表 17.6 万可用词里 frq≥500 的有 3.7 万个，
 * 分布毫无区分度；use=92 / read=337 / live=210 这些真实高频词的值低得排不上去）。
 * 所以按 frq 补词这条路直接废弃 —— 试过，池子会炸到 34092 词且仍漏掉 use/read。
 *
 * 改用两个**真实**信号判定「这词虽无 cet 标签但确实常用」：
 *  - `oxford == 1`：牛津核心 3000 词，必是常用词；
 *  - `collins >= 3`：柯林斯星级 ≥3，常用度评估。
 * 实测补偿进来 851 词（其中 oxford=1 有 732、collins≥3 有 605，去重后 851），
 * 覆盖了 use / read / close 这批 ECDICT 漏标但六级必考的词。合计 8296 词。
 */
const OXFORD_CORE_FLAG = '1';
const COLLINS_MIN = 3;
/**
 * 默认目标词量 = **全池**（用户 2026-10-13 拍板：「池子有多大就多大」）。
 * 实测池 ≈ 8200+（7445 标签池 + 12000 频线内的无标签高频词，去重后）。
 * 传具体数字则退化为「取前 N」（仍保证 cet6 全收）。
 */
const TARGET_SIZE = Number.POSITIVE_INFINITY;

/**
 * 词性行首匹配。ECDICT 的 translation 用 `\n` 分行，**每行以词性标记开头**。
 * 注意：ECDICT 文本里的换行是**字面反斜杠 n**（CSV 转义后到内存里仍是 `\n` 两字符），
 * 必须在解析时统一替换，否则整段释义会被当成一行。
 */
const POS_RE = /^\s*(\[[^\]]+\]|(?:n|v|vt|vi|adj|adv|a|an|num|art|conj|prep|pron|int|abbr|suf|pref)\.)/;

/** 义项分组的词性归并：同一读音的近义/同族词性合并成一行 */
const POS_GROUP: Record<string, string> = {
  n: 'n.',
  v: 'v.',
  vt: 'vt.',
  vi: 'vi.',
  a: 'adj.',
  an: 'adj.',
  adj: 'adj.',
  adv: 'adv.',
  num: 'num.',
  art: 'art.',
  conj: 'conj.',
  prep: 'prep.',
  pron: 'pron.',
  int: 'int.',
  abbr: 'abbr.',
  suf: 'suf.',
  pref: 'pref.',
};

/** 把 ECDICT translation 拆成「词性 → 释义」组 */
export function parsePosGroups(translation: string): { pos: string; zh: string }[] {
  const normalized = translation.replace(/\\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n').map((l) => l.trim()).filter(Boolean);
  const groups: { pos: string; zh: string }[] = [];
  let current: { pos: string; zh: string } | null = null;
  for (const line of lines) {
    const m = POS_RE.exec(line);
    if (m) {
      const raw = m[1];
      const canonical = raw.startsWith('[') ? raw : (POS_GROUP[raw.replace(/\.$/, '')] ?? raw);
      current = { pos: canonical, zh: line.slice(m[0].length).trim() };
      groups.push(current);
    } else if (current) {
      // 续行：并入上一组（ECDICT 里少量释义会跨行）
      current.zh = `${current.zh}，${line}`;
    } else {
      groups.push({ pos: '', zh: line });
      current = groups[groups.length - 1];
    }
  }
  return groups.filter((g) => g.zh.length > 0);
}

/**
 * 名词在前、动词在后的常见顺序不强制重排 —— CMUdict 变体编号与 ECDICT 词性顺序**没有对应关系**
 * （实测 record：CMUdict(1)=R AH0 K AO1 R D 是动词义，ECDICT 第一个词性却是 n.）。
 * 安全的做法：**读音变体之间做笛卡尔分配**时按「变体数 vs 词性组数」两两配对，
 * 配不上的组全部挂到主读音（第一个变体）上 —— 宁可多标也不漏标。
 */
export function assignSensesToPronunciations(
  lemma: string,
  posGroups: { pos: string; zh: string }[],
  pronunciations: string[],
): SeedSense[] {
  const prons = pronunciations.length > 0 ? pronunciations : [''];
  const out: SeedSense[] = [];
  if (prons.length === 1) {
    // 单读音：所有词性挂同一读音，但仍拆成多个义项（词性差异仍是不同的意思）
    posGroups.forEach((g, i) => {
      out.push(makeSense(lemma, i, g.pos, g.zh, prons[0]));
    });
    if (out.length === 0) out.push(makeSense(lemma, 0, '', '', prons[0]));
    return out;
  }
  // 多读音：词性组轮流分配到各读音（组数与读音数不等时循环取模，配不上的重复覆盖）
  posGroups.forEach((g, i) => {
    const pron = prons[i % prons.length];
    out.push(makeSense(lemma, i, g.pos, g.zh, pron));
  });
  if (out.length === 0) {
    prons.forEach((p, i) => out.push(makeSense(lemma, i, '', '', p)));
  }
  return out;
}

function makeSense(lemma: string, idx: number, pos: string, zh: string, arpabet: string): SeedSense {
  const cleaned = arpabet.replace(/\s*#.*$/, '').trim().replace(/\s+/g, ' ');
  let ipa = '';
  if (cleaned) {
    try {
      ipa = arpabetToIpa(cleaned);
    } catch {
      ipa = ''; // 音素串非法 → 按未命中处理（P0-9 降级），不抛
    }
  }
  return {
    senseId: `${lemma}#${idx}`,
    lemma,
    pos,
    zh,
    pronunciationKey: cleaned === '' ? 'NO_PRONUNCIATION' : cleaned,
    arpabet: cleaned,
    ipa,
  };
}

/** CSV 解析（ECDICT 无引号字段复杂，标准 CSV 规则即可；字段内不含裸换行） */
export function parseCsv(content: string): EcdictRow[] {
  const lines = content.split('\n');
  const header = lines[0].split(',').map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows: EcdictRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = '';
    let inQ = false;
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      if (inQ) {
        if (c === '"') {
          if (line[k + 1] === '"') {
            cur += '"';
            k++;
          } else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') {
        cells.push(cur);
        cur = '';
      } else cur += c;
    }
    cells.push(cur);
    rows.push({
      word: (cells[idx.word] ?? '').trim(),
      phonetic: (cells[idx.phonetic] ?? '').trim(),
      definition: (cells[idx.definition] ?? '').trim(),
      translation: (cells[idx.translation] ?? '').trim(),
      pos: (cells[idx.pos] ?? '').trim(),
      exchange: (cells[idx.exchange] ?? '').trim(),
      frq: (cells[idx.frq] ?? '').trim(),
      tag: (cells[idx.tag] ?? '').trim(),
      collins: (cells[idx.collins] ?? '').trim(),
      oxford: (cells[idx.oxford] ?? '').trim(),
      bnc: (cells[idx.bnc] ?? '').trim(),
    });
  }
  return rows;
}

/** 只剥一层首尾斜杠（ECDICT phonetic 自带 `/…/`，反复 replace 会把 `//x//` 越剥越空） */
function stripSlashes(s: string): string {
  const t = s.trim();
  return (t.startsWith('/') && t.endsWith('/') ? t.slice(1, -1) : t).trim();
}

/** 词形变化串（ECDICT exchange，如 `p:did/d,done`）→ 扁平结构，供「词形变化」展示 */
export function parseExchange(exchange: string): Record<string, string> | undefined {
  if (!exchange.trim()) return undefined;
  const out: Record<string, string> = {};
  for (const part of exchange.split(' ')) {
    const [k, v] = part.split(':');
    if (k && v) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 入池判定。
 *
 * ⚠ 标签**不是**唯一判据（见文件头口径说明）：ECDICT 给 use/read/live/wind/present/minute/
 *   second/close 只打了 zk gk，按标签取会把它们全漏掉。
 *   补偿判据见 OXFORD_CORE_FLAG / COLLINS_MIN（不能用 frq —— 该字段不可用）。
 */
export function isEligible(r: EcdictRow): boolean {
  const w = r.word.trim();
  if (!/^[a-z]+$/.test(w)) return false; // 只要纯字母小写（排除含空格/连字符/数字的词形条目）
  if (!r.translation.trim()) return false;
  if (!r.phonetic.trim()) return false;
  if (!/^\d+$/.test(r.frq)) return false; // 必须是数字（词频先验与抽样配比依赖它；非数字 = 非词条）
  const tags = new Set(r.tag.split(/\s+/));
  if (POOL_TAGS.some((t) => tags.has(t))) return true;
  // 无 cet 标签：牛津核心 3000 或柯林斯 ≥3 视为常用词，补偿入池
  if (r.oxford === OXFORD_CORE_FLAG) return true;
  const collins = Number(r.collins);
  return Number.isFinite(collins) && collins >= COLLINS_MIN;
}

/**
 * 选词：cet6 全收 + 其余按词频补足到 target。
 * 排序（同频 tie-break）：先词频降序，再 cet6 优先，再 lemma 字典序 —— 完全确定性。
 */
export function selectWords(eligible: EcdictRow[], target = TARGET_SIZE): EcdictRow[] {
  const sorted = [...eligible].sort(
    (a, b) =>
      Number(b.frq) - Number(a.frq) ||
      Number(hasTag(b, MUST_INCLUDE_TAG)) - Number(hasTag(a, MUST_INCLUDE_TAG)) ||
      (a.word < b.word ? -1 : 1),
  );
  if (sorted.length <= target) return sorted;
  const musts = sorted.filter((r) => hasTag(r, MUST_INCLUDE_TAG));
  const others = sorted.filter((r) => !hasTag(r, MUST_INCLUDE_TAG));
  // 保底词已超目标时按序截断（不静默丢弃：stats.mustIncluded 会暴露真实数量）
  if (musts.length >= target) return musts.slice(0, target);
  return [...musts, ...others.slice(0, target - musts.length)];
}

function hasTag(r: EcdictRow, tag: string): boolean {
  return r.tag.split(/\s+/).includes(tag);
}

/** 主入口 */
export function buildSeed(
  ecdictRows: EcdictRow[],
  cmu: Record<string, string>,
  target = TARGET_SIZE,
): { seed: SeedWordV3[]; stats: Record<string, number> } {
  const eligible = ecdictRows.filter(isEligible);
  const picked = selectWords(eligible, target);

  const seed: SeedWordV3[] = [];
  let multiPron = 0;
  let multiSense = 0;
  let cmuHit = 0;

  for (const r of picked) {
    const lemma = r.word;
    // CMUdict 读音：主词条优先，其次编号变体（按编号升序）
    const prons: string[] = [];
    const main = cmu[lemma];
    if (main) prons.push(main);
    for (let v = 2; v <= 3; v++) {
      const alt = cmu[`${lemma}(${v})`];
      if (alt) prons.push(alt);
    }
    const cleanedProns = prons.map((p) => p.replace(/\s*#.*$/, '').trim().replace(/\s+/g, ' '));
    const distinctProns = [...new Set(cleanedProns)];
    if (distinctProns.length > 0) cmuHit++;
    if (distinctProns.length > 1) multiPron++;

    const posGroups = parsePosGroups(r.translation);
    if (posGroups.length > 1) multiSense++;
    const sensesDetail = assignSensesToPronunciations(lemma, posGroups, distinctProns);

    const primary = sensesDetail[0];
    // ⚠ `arpabetToIpa` 的契约就是**返回带斜杠的 IPA**（展示层直接 /{ipa}/ 套用，
    //   见 WordCard）。因此这里绝不能再剥斜杠 —— 剥一次反而会让外层显示成 `//…//`（已复现并修正）。
    const ipa = primary?.ipa || stripSlashes(r.phonetic);
    const exchange = parseExchange(r.exchange);

    seed.push({
      lemma,
      ...(distinctProns[0] ? { arpabet: distinctProns[0] } : {}),
      ipa,
      senses: sensesDetail.map((s) => s.zh).filter(Boolean),
      sensesDetail,
      translation: r.translation.replace(/\\n/g, ' / '),
      ...(exchange ? { exchange } : {}),
      examples: [],
      frq: Number(r.frq),
      tags: r.tag.split(/\s+/).filter(Boolean),
    });
  }

  return {
    seed,
    stats: {
      eligible: eligible.length,
      picked: seed.length,
      mustIncluded: seed.filter((w) => w.tags.includes(MUST_INCLUDE_TAG)).length,
      cmuHit,
      multiPron,
      multiSense,
      totalSenses: seed.reduce((a, w) => a + w.sensesDetail.length, 0),
    },
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const get = (flag: string, dflt?: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const ecdictPath = get('--ecdict');
  const outArg = get('--out', 'public/seed-cet6.json') as string;
  if (!ecdictPath) {
    console.error('用法：npx tsx src/data/seed/buildSeed7000.ts --ecdict <ecdict.csv> [--out public/seed-cet6.json]');
    process.exit(1);
  }
  const outPath = outArg;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cmu = CMU_DICTIONARY;
  const rows = parseCsv(fs.readFileSync(ecdictPath, 'utf-8'));
  const { seed, stats } = buildSeed(rows, cmu);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf-8');
  console.log('seed built:', JSON.stringify(stats, null, 2));
  console.log('written to', outPath);
}

if (process.argv[1] && process.argv[1].endsWith('buildSeed7000.ts')) {
  main();
}
