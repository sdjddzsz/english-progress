/**
 * senses.ts —— 义项级判定工具（用户 2026-10-13 要求：不同读音对应不同意思 ⇒ 当成不同的单词判定）。
 *
 * 核心语义：**判定单位不是 lemma，而是 senseId（= lemma#序号 + 专属读音）**。
 * 举例：`record` 名词义项 /ˈrekəd/「记录」与动词义项 /rɪˈkɔːd/「录制」是**两个独立判定单位**：
 *  - 听音选词时播 /rɪˈkɔːd/ 只能接受选「录制」这一义项，选「记录」判错；
 *  - 掌握程度 / 轮次 / 命中记录都挂各自的 senseId，互不串。
 *
 * 纯函数、零 IO、零 React 依赖（构建期脚本与前端共用同一份实现）。
 */
import type { Word, WordSense } from '../types/domain';

/** 单词级兼容视图取哪个义项的读音：取第一个（列表展示/兜底合成用） */
export function primarySense(senses: WordSense[]): WordSense | null {
  return senses[0] ?? null;
}

/**
 * 旧数据降级：词没有 sensesDetail（历史行 / 手写导入）⇒ 造一个单词级单义项。
 * 这样上层永远只需要处理 sensesDetail 一条路径，不必到处判空。
 *
 * ⚠ 关键不变量：降级义项的 pronunciationKey 用**该词自身的读音**而不是空串 ——
 *   否则同一个词在「有义项」和「无义项」两种数据形态下会算出不同的 pronunciationKey，
 *   同一份学习记录会被判成两个不同的词项（用户原话：只要不同读音才算不同词）。
 */
export function normalizeSenses(word: Word): WordSense[] {
  if (word.sensesDetail && word.sensesDetail.length > 0) return word.sensesDetail;
  const arpabet = word.arpabet ?? '';
  return [
    {
      senseId: `${word.lemma}#0`,
      lemma: word.lemma,
      pos: word.pos ?? '',
      zh: word.senses[0] ?? '',
      pronunciationKey: pronunciationKeyOf(arpabet),
      arpabet,
      ipa: word.ipa,
    },
  ];
}

/** 读音标识：直接用 arpabet 归一化后的串（无读音时退化为 POS，保证 key 稳定非空） */
export function pronunciationKeyOf(arpabet: string): string {
  const t = arpabet.trim().replace(/\s+/g, ' ');
  return t === '' ? 'NO_PRONUNCIATION' : t;
}

/** 判定身份：**同 lemma + 同读音 = 同一个判定单位**；读音不同 ⇒ 不同单位 */
export function isSameWordUnit(a: WordSense, b: WordSense): boolean {
  return a.lemma === b.lemma && pronunciationKeyOf(a.arpabet) === pronunciationKeyOf(b.arpabet);
}

/** 该词是否有多读音（多读音词必须在 UI 上明确标识出来，否则用户无法预期答案） */
export function hasMultiplePronunciations(word: Word): boolean {
  const keys = new Set(normalizeSenses(word).map((s) => pronunciationKeyOf(s.arpabet)));
  return keys.size > 1;
}

/**
 * 展示用读音标签：`/ˈrekəd/ · 名词义` 这种形式。
 * 用户要求「不同词性或词义有时对应不同读音，要明确标识出来」—— 靠这个标签在词卡上直接标出来。
 */
export function senseLabel(sense: WordSense): string {
  const ipa = sense.ipa ? `/${sense.ipa.replace(/^\/|\/$/g, '')}/` : '';
  const pos = sense.pos ? sense.pos.replace(/\.$/, '') : '';
  return [ipa, pos].filter(Boolean).join(' · ') || sense.lemma;
}

/** 词卡的完整义项清单（含读音），用于「多读音明确标识」 */
export function describeSenses(word: Word): { sense: WordSense; label: string }[] {
  return displaySenses(word).map((sense) => ({ sense, label: senseLabel(sense) }));
}

// ===== 词性展示兜底（用户 2026-10-15：词性标记始终都有）=====

/**
 * ECDICT 行首领域括注（[法]/[计]/[医]/[经]…）曾被旧解析误存进 pos，把真词性顶掉了。
 * 判定特征：行首方括号且**不以「.」结尾**——真词性括注形如 [adj.]，领域标记如 [经]。
 */
export function isDomainTag(pos: string): boolean {
  return /^\[[^\].]+\]$/.test(pos);
}

/** 旧数据 zh 内嵌词性前缀（"interj. 再会" / "pl. 裤子" / "aux. 将"）——提取进 pos */
const EMBEDDED_POS_RE = /^(interj|pl|aux)\.\s*/;

/**
 * 展示用义项列表：
 *  1. zh 内嵌 "interj./pl./aux." 前缀的提取到 pos（旧数据 31 条）；
 *  2. 领域标记从 pos 撤下、保留在释义前面；词性向**最近的先行真词性义项**借
 *     （ECDICT 行序保证领域行紧跟其词性行，实测 3216/3240 可向前借到，其余向后借，
 *     仅 24 个全词无词性——专名类，保持空）。
 * 不动判定字段：数组顺序、senseId、arpabet、pronunciationKey 与 normalizeSenses 完全一致，
 * 所以 QuizPage 按 senseIndex 取义项/拼读音 key 的逻辑不受影响。
 */
export function displaySenses(word: Word): WordSense[] {
  const senses = normalizeSenses(word).map((s) => {
    if (!s.pos) {
      const m = EMBEDDED_POS_RE.exec(s.zh);
      if (m) return { ...s, pos: `${m[1]}.`, zh: s.zh.slice(m[0].length) };
    }
    return s;
  });
  const isReal = (s: WordSense): boolean => Boolean(s.pos) && !isDomainTag(s.pos);
  const out = senses.slice();
  // 第一遍：向前借（覆盖绝大多数）
  let lastReal = '';
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (isReal(s)) {
      lastReal = s.pos;
    } else if (isDomainTag(s.pos) && lastReal) {
      out[i] = { ...s, pos: lastReal, zh: `${s.pos} ${s.zh}` };
    }
  }
  // 第二遍：向后借（词开头的领域标记，前面没有真词性）
  let nextReal = '';
  for (let i = out.length - 1; i >= 0; i--) {
    const s = out[i];
    if (isReal(s)) {
      nextReal = s.pos;
    } else if (isDomainTag(s.pos) && nextReal) {
      out[i] = { ...s, pos: nextReal, zh: `${s.pos} ${s.zh}` };
    }
  }
  return out;
}
