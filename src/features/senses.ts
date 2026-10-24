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

/**
 * 判定身份（用户 2026-10-15 重申定案）：**同 lemma + 同读音 = 同一个单词**——
 * 哪怕词性不同（appointment 的 n.[经]任命 与 n.约会 同读音，就是同一个单词，
 * 判定进度共享，绝不互为干扰项）；**不同读音对应不同词性才算不同单词**
 * （record 的 /ˈrekəd/ 与 /rɪˈkɔːd/ 是两个判定单位）。
 */
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

/**
 * 把一个义项的中文释义按**逗号/分号/顿号**拆成子义项（用户 2026-10-23：
 * 同一词性下常写「放弃，抛弃」多条意思，例句要能按单条意思分别生成）。
 * 例：「放弃，抛弃；离弃」→ ['放弃', '抛弃', '离弃']；拆不出多条时返回空数组（调用方按整条处理）。
 */
export function splitSenseZh(zh: string): string[] {
  return zh
    .split(/[，,；;、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ===== 用户长按编辑/删除/新增义项（用户 2026-10-18：有些词的释义极其刁钻，要能改/删；
// 2026-10-19：词书漏义项要能补）=====
// 纯函数：改哪个字段、删第几个、加一条、词级字段（senses 扁平串 / pos）怎么同步，都在这一个文件里定死，
// 前端弹窗与测试共用；云端写入走 wordRepo.updateWordSenses（整行 upsert，lemma 冲突即更新）。

/** 词级字段随义项列表同步：扁平 senses=各义项 zh、pos=首义项词性 */
function syncWordSenses(word: Word, detail: WordSense[]): Word {
  return {
    ...word,
    sensesDetail: detail,
    senses: detail.map((s) => s.zh),
    ...(detail[0] ? { pos: detail[0].pos } : {}),
  };
}

/** 编辑第 senseIndex 个义项的 词性/释义；不改读音字段（读音即判定身份，不能顺手改） */
export function applySenseEdit(
  word: Word,
  senseIndex: number,
  patch: { pos?: string; zh?: string },
): Word {
  const detail = normalizeSenses(word).map((s, i) =>
    i === senseIndex
      ? {
          ...s,
          ...(patch.pos !== undefined ? { pos: patch.pos } : {}),
          ...(patch.zh !== undefined ? { zh: patch.zh } : {}),
        }
      : s,
  );
  return syncWordSenses(word, detail);
}

/**
 * 在末尾新增一个义项（用户 2026-10-19：有些词书漏了义项，要能补）。
 * 读音继承：新义项的 arpabet/ipa/pronunciationKey 取词级读音（无 sensesDetail 时取
 * 首个义项的）—— 用户补的释义绝大多数就是该词本音的那个意思，留空会让
 * normalizeSenses 判定成 NO_PRONUNCIATION 的另一个"词"、听音选词直接播不出。
 * senseId 唯一化：取 `lemma#序号`，撞已有 id 就向后顺延（手写数据可能有非常规 id）。
 */
export function applySenseAdd(
  word: Word,
  patch: { pos?: string; zh?: string },
): Word {
  const detail = normalizeSenses(word).map((s) => ({ ...s }));
  const used = new Set(detail.map((s) => s.senseId));
  let n = detail.length;
  while (used.has(`${word.lemma}#${n}`)) n += 1;
  const base = detail[0];
  const added: WordSense = {
    senseId: `${word.lemma}#${n}`,
    lemma: word.lemma,
    pos: patch.pos?.trim() ?? '',
    zh: patch.zh?.trim() ?? '',
    pronunciationKey: base ? base.pronunciationKey : pronunciationKeyOf(word.arpabet ?? ''),
    arpabet: base ? base.arpabet : (word.arpabet ?? ''),
    ipa: base ? base.ipa : word.ipa,
  };
  return syncWordSenses(word, [...detail, added]);
}

/**
 * 删除第 senseIndex 个义项。**只剩一个义项时返回 null**（拒绝删除）：
 * 词不能没有释义，否则 normalizeSenses 降级出的单义项 zh 为空，考据面板全空。
 */
export function applySenseDelete(word: Word, senseIndex: number): Word | null {
  const detail = normalizeSenses(word);
  if (detail.length <= 1) return null;
  return syncWordSenses(
    word,
    detail.filter((_, i) => i !== senseIndex),
  );
}

/**
 * 编辑第 senseIndex 个义项的**读音**（用户 2026-10-24：fine 三个义项的音标数据是错的，
 * 要能就地修；配套 UI = 长按音标弹编辑窗）。
 *
 * 与 applySenseEdit 的分工：那个只改词性/释义（读音即判定身份，绝不顺手改）；
 * 这个专职改读音——**身份随之更新**。这是用户明知的修正操作（数据错了），
 * 不是浏览时误触：弹窗里有明文警告，且 pronunciationKey 的变化在预览里可见。
 *
 * 同步规则：
 *  - pronunciationKey 由新 arpabet 重算（该义项是否还和同词其它义项同档，取决于新值本身；
 *    fine 修正后 6 个义项全部并回同一档，多读音标识消失——这正是修正想要的结果）；
 *  - senseId 不变（lemma#序号）⇒ 已记录的学习进度/轮次/命中都挂 senseId，不受影响；
 *  - 改第 0 个义项时**同步词级 ipa/arpabet**：词级读音 = 首义项读音的兼容口径
 *    （domain.ts 注释、sampling.ts 的 `first.ipa || w.ipa`、normalizeSenses 降级都依赖它），
 *    首义项修好了词级还挂旧值，列表页（词表/生词本/查词）会继续显示错的。
 */
export function applySensePronEdit(
  word: Word,
  senseIndex: number,
  patch: { ipa: string; arpabet: string },
): Word {
  const detail = normalizeSenses(word).map((s, i) =>
    i === senseIndex
      ? {
          ...s,
          ipa: patch.ipa,
          arpabet: patch.arpabet,
          pronunciationKey: pronunciationKeyOf(patch.arpabet),
        }
      : s,
  );
  const next = syncWordSenses(word, detail);
  // 词级读音跟随首义项（兼容口径）：首义项读音变了，词级展示/兜底合成必须跟着变
  if (senseIndex === 0 && detail[0]) {
    return { ...next, ipa: detail[0].ipa, arpabet: detail[0].arpabet };
  }
  return next;
}

/**
 * 编辑**词级**读音（词卡顶部 / 无义项数据的老词）。不动 sensesDetail——
 * 义项级读音是另一份数据，要改请走 applySensePronEdit（弹窗里会提示这个分工）。
 */
export function applyWordPronEdit(word: Word, patch: { ipa: string; arpabet: string }): Word {
  return { ...word, ipa: patch.ipa, arpabet: patch.arpabet };
}

/**
 * 删除/编辑义项后，把题目锚定的 senseIndex 收回到有效范围（用户 2026-10-18）。
 * 背景：删掉正在考的那个义项（或它前面的义项）后 senseIndex 越界 ⇒ 主卡片渲染条件
 * `senseOf` 为空 ⇒ 整块题卡消失，用户以为「题页没了 / 单词被连删」——实际词还在
 * （AI 框仍带该词上下文可证）。语义：删的正是当前项 ⇒ 顺移到下一个；删的是前面的 ⇒ 目标前移。
 */
export function clampSenseIndex(word: Word, senseIndex: number): number {
  const n = normalizeSenses(word).length;
  if (n === 0) return 0;
  return Math.min(Math.max(senseIndex, 0), n - 1);
}
