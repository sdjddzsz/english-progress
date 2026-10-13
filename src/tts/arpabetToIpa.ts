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
 * 纯函数：零 import、零 IO / React / DOM 依赖（T2 验收③）。
 */

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
