/**
 * question.ts —— 单题构建（用户 2026-10-15：出题/回顾恢复逻辑抽成纯函数，可单测）。
 *
 * QuizPage 的出题 effect 只做 setState 胶水，本文件承载语义：
 *   - 未答过的题 → 选义项 → 正确项（带 lemma）→ buildOptions → { options, correctKey }
 *   - 已答过的题 → 返回 null，调用方走「原样恢复」分支（上一题回顾用）
 *
 * 纯函数、零 IO、零 React 依赖（senseIndex 由调用方预先随机定好）。
 */
import type { BookWord, Word } from '../../types/domain';
import { displaySenses } from '../senses';
import { buildOptions, type DistractorCandidate } from './distractors';

/** QuizPage 的 QuizItem 中与本模块相关的字段（回顾缓存由调用方持有） */
export interface QuestionInput {
  bookWord: BookWord;
  word: Word;
  senseIndex: number;
  /** 已生成过选项 = 已答过（回顾恢复分支） */
  options?: DistractorCandidate[];
  correctKey?: string;
}

export interface BuiltQuestion {
  options: DistractorCandidate[];
  correctKey: string;
}

/** 已答过的题返回 null（调用方恢复原状，不重摇选项、不重判） */
export function buildQuestion(item: QuestionInput, pool: DistractorCandidate[]): BuiltQuestion | null {
  if (item.options && item.correctKey) return null;
  const sense = displaySenses(item.word)[item.senseIndex];
  if (!sense) return null;
  const correct: DistractorCandidate = {
    zh: sense.zh,
    pos: sense.pos,
    lemma: item.word.lemma,
    order: item.bookWord.listNo * 1000 + item.bookWord.orderInList,
    key: `${item.bookWord.wordId}#${item.senseIndex}`,
  };
  return { options: buildOptions(correct, pool), correctKey: correct.key };
}
