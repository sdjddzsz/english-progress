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
  return normalizeSenses(word).map((sense) => ({ sense, label: senseLabel(sense) }));
}
