/**
 * distractors.ts —— 考查干扰项生成（用户 2026-10-14：**干扰项不要太随机，要与正确选项相似**）。
 *
 * 相似度打分（分数高者优先，不足再从剩余随机补齐）：
 *   +2  词性相同（n. 干扰 n.，v. 干扰 v.）—— 最能造成"形近义混"的干扰
 *   +1  中文释义长度与正确答案差 ≤2 字（视觉/语感长度接近）
 *   +1  词频带相邻（listNo 差 ≤ 300，即词书里排在一起的常用度段）—— 同段词主题常相近
 *   +1  都含中文顿号/逗号结构（释义结构相似：多义词 vs 多义词）
 *
 * 纯函数、零 IO、零 React 依赖。
 */

export interface DistractorCandidate {
  /** 释义原文（如 "珍珠, 珠灰色"） */
  zh: string;
  /** 词性原文（如 "n."）；空串 = 未知 */
  pos: string;
  /** 该释义所属词形（用户 2026-10-15：作答后每个选项都要能看出是哪个词的义项） */
  lemma: string;
  /** 词书序（listNo*1000+orderInList 之类的序，用于频带相近判断）；未知传 0 */
  order: number;
  /** 选项下不去重用的标识（senseId 或 wordId#idx） */
  key: string;
}

export interface DistractorProblem {
  correct: DistractorCandidate;
  distractors: DistractorCandidate[];
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 释义结构相似：都含顿号/逗号 ⇒ 都是多义词，语感接近 */
function similarStructure(zhA: string, zhB: string): boolean {
  const sep = (s: string): number => (s.includes(',') || s.includes('、') || s.includes('；') ? 1 : 0);
  return sep(zhA) === sep(zhB);
}

/** 与正确选项的相似度分（越大越相似） */
function closenessRank(correct: DistractorCandidate, c: DistractorCandidate): number {
  let rank = 0;
  if (correct.pos && c.pos && c.pos === correct.pos) rank += 2;
  if (Math.abs(c.zh.length - correct.zh.length) <= 2) rank += 1;
  if (correct.order > 0 && c.order > 0 && Math.abs(c.order - correct.order) <= 300) rank += 1;
  if (similarStructure(correct.zh, c.zh)) rank += 1;
  return rank;
}

/**
 * 从候选池里挑 n 个干扰项：**相似优先，随机补齐**。
 * - 正确项自身与**同词的其它义项**不进干扰项（用户 2026-10-15 定案：同词同读音哪怕不同词性
 *   也是同一个单词，判定单位是词——同词义项互为干扰会造出"同一个词自己考自己"的无解题）；
 * - 打分并列时随机取（避免每次考同题都出同一组干扰）
 */
export function pickDistractors(
  correct: DistractorCandidate,
  pool: DistractorCandidate[],
  n = 3,
): DistractorCandidate[] {
  const eligible = pool.filter(
    (c) => c.key !== correct.key && c.zh && c.zh !== correct.zh && c.lemma !== correct.lemma,
  );
  const ranked = shuffle(eligible)
    .map((c) => ({ c, rank: closenessRank(correct, c) }))
    .sort((a, b) => b.rank - a.rank);
  const out = ranked.slice(0, n).map((s) => s.c);
  // 池子太小补不满就放宽（已 shuffle，剩余任意补）
  if (out.length < n) {
    const chosen = new Set(out.map((c) => c.key));
    for (const c of eligible) {
      if (out.length >= n) break;
      if (!chosen.has(c.key)) out.push(c);
    }
  }
  return out;
}

/** 正确项 + 干扰项 → 打乱后的四选项（避免正确项总在同一位置） */
export function buildOptions(
  correct: DistractorCandidate,
  pool: DistractorCandidate[],
): DistractorCandidate[] {
  return shuffle([correct, ...pickDistractors(correct, pool, 3)]);
}

/**
 * 选项附注文案：判定后（showState）每个选项都带出**所属词形**——用户 2026-10-15：
 * 选错也要一眼看出干扰项是哪个词的义项，不然错了不知道错在哪。
 * 未判定时不显示（避免提前泄题）。
 */
export function optionSuffix(o: DistractorCandidate, showState: boolean): string {
  return showState && o.lemma ? `（${o.lemma}）` : '';
}
