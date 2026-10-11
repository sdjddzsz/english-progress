/**
 * ipaMap.ts —— IPA（ECDICT 通用 IPA）→ Azure 语音 IPA 音素集差异映射（独立文件，可测）。
 * Azure `<phoneme alphabet="ipa">` 接受 IPA，但个别 Unicode 字符在其音素集之外，
 * 需映射为 Azure 支持的等价音素；不认识的字符原样保留（由 Azure 报错→兜底轨兜住）。
 */

/** 单字符/双字符差异映射（覆盖 ECDICT 音标常见 divergent 字符） */
export const IPA_CHAR_MAP: Record<string, string> = {
  'ɡ': 'g', // U+0261 script g → ASCII g（最常见差异）
  'ɫ': 'l', // 暗 l
  'ɹ': 'r', // 齿龈近音（Azure 英式集用 r）
  'ʀ': 'r',
  'ʁ': 'r',
  'ʧ': 'tʃ', // U+02A7 → 双字符 affricate
  'ʤ': 'dʒ', // U+02A4
  'ɾ': 't', //闪音
  'ɽ': 'r',
  'ɺ': 'l',
  'ᵻ': 'ɪ', // 中央化 ɪ
  'ᵿ': 'ʊ',
  'ɵ': 'ə',
  'ȳ': 'iː',
  'ɜ': 'ɜː', // ECDICT 常省略长音符，Azure 需 ɜː
  'ɐ': 'ə',
};

/** 去掉 /…/ 斜杠与空白 */
export function stripIpaSlashes(ipa: string): string {
  return ipa.replace(/^\/+|\/+$/g, '').trim();
}

/** 逐字符映射（双字符键优先匹配） */
export function mapIpaToAzure(ipa: string): string {
  const src = stripIpaSlashes(ipa);
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (IPA_CHAR_MAP[two] !== undefined && two === 'ʧ' || two === 'ʤ') {
      out += IPA_CHAR_MAP[two];
      i += 2;
      continue;
    }
    const one = src[i];
    out += IPA_CHAR_MAP[one] ?? one;
    i += 1;
  }
  return out;
}

/**
 * 按音节切分 IPA（'.' 分隔；重音符 ˈ/ˌ 归属其后音节）。
 * 例：'/əˈkɒm.ə.deɪt/' → ['əˈkɒm', 'ə', 'deɪt']
 */
export function splitSyllables(ipa: string): string[] {
  const src = stripIpaSlashes(ipa);
  if (!src) return [];
  return src
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 例句 IPA 按词切分（word_by_word 模式备用；词级 IPA 由分词语料提供，P1 接入） */
export function ipaToWordTokens(ipa: string): string[] {
  return stripIpaSlashes(ipa)
    .split(/\s+/)
    .filter((s) => s.length > 0);
}
