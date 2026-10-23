/**
 * exampleRepo.ts —— 用户例句读写（用户 2026-10-22：考查页长按任一释义「生成例句」）。
 *
 * 与 word_notes 同构：owner_id DEFAULT auth.uid() + RLS own 四策略；一词多例句
 * （每次生成追加一条，不覆盖），归属粒度 = senseId（例句是针对某个义项生成的）。
 *
 * 写路径走直写（与笔记同：低频、用户主动触发，失败明面报错，不入离线队列——
 * 例句丢了点一下就能重新生成，不值得为它引入补传语义）。
 */
import type { WordExample } from '../../types/domain';
import { getDb } from '../cloud';
import type { CloudDatabaseLike } from '../repository';
import { Repository } from '../repository';

export interface ExampleRepo {
  readonly examples: Repository<WordExample>;
  /** 某词的全部例句（按生成时间升序；同毫秒补 id 字典序做次序兜底） */
  listExamplesForWord(userId: string, wordId: string): Promise<WordExample[]>;
  /** 新增一条例句（insert 自动生成 id；每次调用 = 追加一条，绝不覆盖） */
  addExample(args: {
    userId: string;
    wordId: string;
    senseId: string;
    /** 子义项文本（逗号拆开的单条意思；用户 2026-10-23） */
    senseZh?: string;
    lemma: string;
    en: string;
    zh: string;
    source?: string;
  }): Promise<WordExample>;
  /** 删除一条（按 id；RLS 保证只能删自己的） */
  removeExample(id: string): Promise<boolean>;
}

export function createExampleRepo(db: CloudDatabaseLike = getDb()): ExampleRepo {
  const examples = new Repository<WordExample>(db, 'word_examples');
  const nowIso = (): string => new Date().toISOString();

  return {
    examples,
    listExamplesForWord: async (userId, wordId) => {
      const rows = await examples.listAll(
        [
          { column: 'userId', op: 'eq', value: userId },
          { column: 'wordId', op: 'eq', value: wordId },
        ],
        { orderBy: 'createdAt', ascending: true },
      );
      // 同一毫秒连续生成时 createdAt 相同 ⇒ 补 id 升序做稳定次序（同 noteRepo.listNotes 的思路）
      return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },
    addExample: async ({ userId, wordId, senseId, senseZh, lemma, en, zh, source }) => {
      const now = nowIso();
      return examples.insert({
        userId,
        wordId,
        senseId,
        ...(senseZh ? { senseZh } : {}),
        lemma,
        en: en.trim(),
        zh: zh.trim(),
        source: source ?? 'ai',
        createdAt: now,
        updatedAt: now,
      });
    },
    removeExample: (id) => examples.remove(id),
  };
}
