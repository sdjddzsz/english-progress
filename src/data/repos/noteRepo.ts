/**
 * noteRepo.ts —— 单词笔记读写（用户 2026-10-17：题旁笔记按钮 + 专门页面查看）。
 *
 * 确定性 id = `{userId}_{wordId}`：一词一记，重复保存 = 覆盖（幂等，同 word_bookmarks 思路）。
 * 云端表 word_notes：owner_id DEFAULT auth.uid() + RLS own 四策略（与 word_bookmarks 同构）。
 */
import type { WordNote } from '../../types/domain';
import { getDb } from '../cloud';
import type { CloudDatabaseLike } from '../repository';
import { Repository } from '../repository';

export interface NoteRepo {
  readonly notes: Repository<WordNote>;
  /** 一词一记的确定性 id */
  noteId(userId: string, wordId: string): string;
  /** 读某词的笔记（没有返回 null） */
  getNote(userId: string, wordId: string): Promise<WordNote | null>;
  /** 保存（存在即覆盖） */
  saveNote(args: {
    userId: string;
    wordId: string;
    lemma: string;
    content: string;
    source: string;
    senseIndex?: number;
  }): Promise<WordNote>;
  /** 删除 */
  removeNote(userId: string, wordId: string): Promise<boolean>;
  /** 该用户全部笔记（updatedAt 降序，笔记页用） */
  listNotes(userId: string): Promise<WordNote[]>;
}

export function createNoteRepo(db: CloudDatabaseLike = getDb()): NoteRepo {
  const notes = new Repository<WordNote>(db, 'word_notes');
  const noteId = (userId: string, wordId: string): string => `${userId}_${wordId}`;

  const nowIso = (): string => new Date().toISOString();

  return {
    notes,
    noteId,
    getNote: async (userId, wordId) => notes.getById(noteId(userId, wordId)),
    saveNote: async ({ userId, wordId, lemma, content, source, senseIndex }) => {
      const id = noteId(userId, wordId);
      const existing = await notes.getById(id);
      const doc: WordNote = {
        id,
        userId,
        wordId,
        lemma,
        content: content.trim(),
        source,
        ...(senseIndex != null ? { senseIndex } : {}),
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      await notes.upsertMany([doc as WordNote & Record<string, unknown>]);
      return doc;
    },
    removeNote: (userId, wordId) => notes.remove(noteId(userId, wordId)),
    // 同一毫秒内连续保存的笔记 updatedAt 相同 ⇒ 补 createdAt 降序做次序兜底
    listNotes: async (userId) => {
      const rows = await notes.listAll(
        [{ column: 'userId', op: 'eq', value: userId }],
        { orderBy: 'updatedAt', ascending: false },
      );
      return rows.sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt),
      );
    },
  };
}
