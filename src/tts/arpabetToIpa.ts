/**
 * arpabetToIpa.ts —— ARPAbet → IPA 确定性纯函数（CMUdict 发音真源的展示派生）。
 *
 * 单一真源（架构增量 §七.6）：seed 生成（joinCmuDict）、存量回填（backfillArpabet）
 * 与未来音节切分（P1-2）共用本文件；禁止在 UI / 脚本里另写映射。
 *
 * 规则集严格按架构增量 §5.2：
 *  1. 39 音素 1:1 映射（美式取向、不带长度符；AH0→ə、AH1/AH2→ʌ；ER→ɜr；R 一律→r）；
 *  2. 重音 1→ˈ、重音 2→ˌ，插在该音节起首辅音簇最左侧（从带重音的元音向左吞噬辅音，
 *     直到上一个元音或串首；元音开头则直接插元音前；重音 0 无标记）；
 *  3. 音节点：最大首辅音分点——两个音节核之间的辅音全部划归下一音节起首
 *     （不做语音学合法性检查）；两元音相邻则点直接插两元音之间；单音节词无点；
 *     同一位置同时有点与重音标记时顺序为「先点后标记」（.ˈ）；
 *  4. 双写辅音不去重（N N → nn）；
 *  5. 空串/空白 → ''；token 不在 39 音素表或重音数字非 0/1/2 → throw Error
 *     （调用方按未命中处理）。
 *
 * 纯函数：零 IO / React / DOM 依赖（T2 验收③；仅允许 import 同目录纯函数模块）。
 */
import { stripIpaSlashes } from './ipaMap';

/** 15 个元音音素（ARPAbet 基础形式，不含重音数字） */
const ARPABET_VOWELS: ReadonlySet<string> = new Set([
  'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW',
]);

/** 39 音素 → IPA（AH 按重音特判，不在此表展开） */
const ARPABET_IPA: Record<string, string> = {
  // 元音（AH 见 phonemeToIpa 的特判）
  AA: 'ɑ', AE: 'æ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ', EH: 'ɛ', ER: 'ɜr', EY: 'eɪ',
  IH: 'ɪ', IY: 'i', OW: 'oʊ', OY: 'ɔɪ', UH: 'ʊ', UW: 'u',
  // 辅音
  B: 'b', CH: 'tʃ', D: 'd', DH: 'ð', F: 'f', G: 'ɡ', HH: 'h', JH: 'dʒ', K: 'k',
  L: 'l', M: 'm', N: 'n', NG: 'ŋ', P: 'p', R: 'r', S: 's', SH: 'ʃ', T: 't',
  TH: 'θ', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
};

/**
 * 39 音素基础形式白名单（ARPABET_VOWELS ∪ 辅音表）。
 * 注意：AH 仅在 ARPABET_VOWELS 中（phonemeToIpa 特判），不在 ARPABET_IPA 中，
 * 因此校验必须用本集合而非 ARPABET_IPA，否则含 AH 的词全部被误判非法。
 */
const ARPABET_BASES: ReadonlySet<string> = new Set<string>([...ARPABET_VOWELS, ...Object.keys(ARPABET_IPA)]);

/** 解析后的音素：基础形式 + 重音（0 = 无重音数字或缺省） */
interface ArpabetPhoneme {
  base: string;
  stress: 0 | 1 | 2;
}

/**
 * 解析 ARPAbet 串为音素序列。严格模式：
 * 输入先 strip 再按单空格切分；token 须为 1~3 个大写字母 + 可选重音 0/1/2，
 * 且基础形式须在 39 音素表内，否则抛 Error。
 * （单字母辅音 B/D/F/G/K/L/M/N/P/R/S/T/V/W/Y/Z 是合法 ARPAbet，故字母数下限为 1。）
 */
function parseArpabet(arpabet: string): ArpabetPhoneme[] {
  const trimmed = arpabet.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/).map((token) => {
    const m = /^([A-Z]{1,3})([012])?$/.exec(token);
    const base = m?.[1];
    if (!m || !base || !ARPABET_BASES.has(base)) {
      throw new Error(`arpabetToIpa: invalid phoneme "${token}"`);
    }
    // 注意：正则捕获组是字符串，必须显式转数字；否则 stress === 0 / === 1 全部为 false，
    // 重音标记不落、AH0 会被当成非零重音渲染为 ʌ（历史缺陷，勿退回字符串比较）。
    const stress = m[2] ? Number(m[2]) : 0;
    return { base, stress: stress as ArpabetPhoneme['stress'] };
  });
}

/** 音素 → IPA（AH0→ə；AH1/AH2→ʌ；其余音素不因重音变形） */
function phonemeToIpa(p: ArpabetPhoneme): string {
  if (p.base === 'AH') return p.stress === 0 ? 'ə' : 'ʌ';
  return ARPABET_IPA[p.base];
}

/** 去掉 token 末尾的重音数字（"AE1" → "AE"；无数字原样返回） */
function stripStressDigit(token: string): string {
  return token.replace(/[012]$/, '');
}

/**
 * 音素分类（ssml / 测试共用）：ARPAbet 元音集合判断。
 * 入参可为带重音数字形式（"AE1"）或基础形式（"AE"）。
 */
export function isArpabetVowel(phoneme: string): boolean {
  return ARPABET_VOWELS.has(stripStressDigit(phoneme));
}

/**
 * 去重音数字（P0-7 ph 兼容开关用）："AH0 K AE1 D AH0 M IY0" → "AH K AE D AH M IY"。
 * 空串/空白 → ''。
 */
export function stripArpabetStress(arpabet: string): string {
  const trimmed = arpabet.trim();
  if (!trimmed) return '';
  return trimmed
    .split(/\s+/)
    .map(stripStressDigit)
    .join(' ');
}

/**
 * 按音节切分 ARPAbet（P1-2 用；与 IPA 音节点同一套最大首辅音边界规则）：
 * "AH0 K AE1 D AH0 M IY0" → ["AH0", "K AE1", "D AH0", "M IY0"]。
 * 单音节词返回单元素数组；空串返回 []。
 */
export function splitArpabetSyllables(arpabet: string): string[] {
  const phonemes = parseArpabet(arpabet);
  if (phonemes.length === 0) return [];
  const nuclei = phonemes.map((p, i) => (isArpabetVowel(p.base) ? i : -1)).filter((i) => i >= 0);
  const tokens = arpabet.trim().split(/\s+/);
  // 音节起点：每个音节核的起首辅音簇最左侧 = 上一个音节核之后的第一项（最大首辅音）
  const starts = nuclei.map((_, k) => (k === 0 ? 0 : nuclei[k - 1] + 1));
  const out: string[] = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : tokens.length;
    out.push(tokens.slice(from, to).join(' '));
  }
  return out;
}

/**
 * ARPAbet → IPA（包斜杠）。严格模式：非法音素/重音数字抛 Error；空串或空白返回 ''。
 * 输入：CMUdict 音素串，空格分隔，音素 = 1~3 大写字母 + 可选重音 0/1/2。
 */
export function arpabetToIpa(arpabet: string): string {
  const phonemes = parseArpabet(arpabet);
  if (phonemes.length === 0) return '';
  const nuclei = phonemes.map((p, i) => (isArpabetVowel(p.base) ? i : -1)).filter((i) => i >= 0);
  // 音节起点：每个音节核的起首辅音簇最左侧 = 上一个音节核之后的第一项（最大首辅音）
  const starts = nuclei.map((_, k) => (k === 0 ? 0 : nuclei[k - 1] + 1));
  // token i 所属音节 = 严格小于 i 的音节核个数
  const syllableOf = (i: number): number => {
    let k = 0;
    while (k < nuclei.length && nuclei[k] < i) k++;
    return k;
  };
  const parts: string[] = [];
  phonemes.forEach((p, i) => {
    const k = syllableOf(i);
    if (k > 0 && i === starts[k]) {
      // 音节点：每个音节（除首音节）起首最左侧；与重音标记同位置时「先点后标记」
      parts.push('.');
    }
    if (i === starts[k]) {
      const stress = phonemes[nuclei[k]].stress;
      if (stress === 1) parts.push('ˈ');
      else if (stress === 2) parts.push('ˌ');
    }
    parts.push(phonemeToIpa(p));
  });
  return `/${parts.join('')}/`;
}

// ===== IPA → ARPAbet（arpabetToIpa 的逆向；用户 2026-10-24：音标数据错了要能就地改）=====
//
// 用途：长按音标改正后，**同步派生 ARPAbet**。为什么必须派生：DashScope 主轨按
// ARPAbet（<phoneme alphabet="cmu">）合成，Azure 轨才用 IPA；只改 IPA 不改 ARPAbet，
// 显示修好了、音频还是旧的那一版（fine 三个义项正是「IPA 错 + ARPAbet 也错」）。
//
// 与正向规则逐条对应：
//  1. 去斜杠/空白；长音符 ː 与排版符（- |）丢弃（ARPAbet 无长度位）；
//  2. 按 '.' 切音节；每音节内 ˈ→主重音(1)、ˌ→次重音(2)，挂在**该音节首个元音**上
//     （正向：标记插在音节起首簇最左侧 ⇒ 逆向即「元音前挂着的标记」）；
//  3. 音素逆向映射，双字符优先；ʌ→AH1、ə→AH0（自带默认重音位，显式重音符可改写）；
//     其余元音**必带重音位**（0/1/2，CMUdict 惯例——不带数字会让 pronunciationKey
//     与同词其它义项对不上，多读音分组会假裂）；
//  4. 兼容 ECDICT 英式拼写（ɒ→AO、əʊ→OW、ɜ→ER、e→EH、a→AE、ɫ→L）；
//  5. 无法识别的字符 → throw Error（调用方拦截提示，坏 IPA 不许落库）。
//
// ⚠ 已知有损（人工修正场景可接受）：AH2→ʌ→AH1（次重音 schwa 化塌缩）；
//    重音符不在音节起首时尽力而为；用户 IPA 省略音节点时按单音节处理。
//    空串/纯斜杠/纯空白 → ''。

/** IPA → ARPAbet 音素表（查找时双字符键优先） */
const IPA_TO_ARPABET: Record<string, string> = {
  // 双字符：正向的 AW/AY/EY/OW/OY/CH/JH/ER 输出 + ECDICT 英式变体
  aʊ: 'AW', aɪ: 'AY', eɪ: 'EY', oʊ: 'OW', ɔɪ: 'OY', əʊ: 'OW',
  tʃ: 'CH', dʒ: 'JH', ɜr: 'ER', ɜː: 'ER',
  // 元音（AH 两个特殊值自带重音位）
  ɑ: 'AA', æ: 'AE', ɔ: 'AO', ɒ: 'AO', ɛ: 'EH', e: 'EH',
  ɪ: 'IH', i: 'IY', ʊ: 'UH', u: 'UW', ə: 'AH0', ʌ: 'AH1', a: 'AE',
  // 辅音
  b: 'B', d: 'D', ð: 'DH', f: 'F', ɡ: 'G', g: 'G', h: 'HH', j: 'Y',
  k: 'K', l: 'L', ɫ: 'L', m: 'M', n: 'N', ŋ: 'NG', p: 'P',
  r: 'R', ɹ: 'R', ɾ: 'T', s: 'S', ʃ: 'SH', t: 'T', θ: 'TH',
  v: 'V', w: 'W', z: 'Z', ʒ: 'ZH',
  // ER 的单字符形态（正向只输出 ɜr；用户单独打 ɜ 时按 ER 收）
  ɜ: 'ER',
};

/** 音节内重音挂载状态：ˈ/ˌ 只作用于本音节内首个元音，跨音节不继承 */
function emitArpabetToken(tokens: string[], base: string, pending: 0 | 1 | 2): 0 | 1 | 2 {
  const ah = /^AH([012])$/.exec(base);
  if (ah) {
    // ə/ʌ 的默认重音位（AH0/AH1）；显式 ˈ/ˌ 优先改写
    tokens.push(pending !== 0 ? `AH${pending}` : base);
    return 0;
  }
  if (ARPABET_VOWELS.has(base)) {
    tokens.push(`${base}${pending}`); // 元音必带重音位（CMUdict 惯例）
    return 0;
  }
  tokens.push(base);
  return pending; // 辅音不吃重音：等后面的元音
}

/**
 * IPA → ARPAbet（arpabetToIpa 的逆向，人工修正音标的写路径）。
 * 输入：ECDICT 风格 IPA（可带/不带斜杠与音节点）；输出：CMUdict 风格 ARPAbet。
 * 无法识别的字符抛 Error（消息里带出问题字符，界面直接展示给用户）。
 */
export function ipaToArpabet(ipa: string): string {
  const src = stripIpaSlashes(ipa).replace(/[ː\s\-|]/g, '');
  if (!src) return '';
  const tokens: string[] = [];
  for (const syl of src.split('.')) {
    let pending: 0 | 1 | 2 = 0;
    for (let i = 0; i < syl.length; ) {
      const ch = syl[i];
      if (ch === 'ˈ') {
        pending = 1;
        i += 1;
        continue;
      }
      if (ch === 'ˌ') {
        pending = 2;
        i += 1;
        continue;
      }
      const two = IPA_TO_ARPABET[syl.slice(i, i + 2)];
      if (two !== undefined) {
        pending = emitArpabetToken(tokens, two, pending);
        i += 2;
        continue;
      }
      const one = IPA_TO_ARPABET[ch];
      if (one !== undefined) {
        pending = emitArpabetToken(tokens, one, pending);
        i += 1;
        continue;
      }
      throw new Error(`ipaToArpabet: unsupported character "${ch}"`);
    }
  }
  return tokens.join(' ');
}
