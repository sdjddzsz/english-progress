/**
 * collections.ts —— 25 集合名与文档类型映射（架构文档 §2.1）。
 * 集合名 snake_case 复数（共享知识 #3）；TS 文档类型见 src/types/domain.ts。
 */
import type { CollectionDocMap, CollectionName } from '../types/domain';

export { COLLECTIONS } from '../types/domain';
export type { CollectionName } from '../types/domain';

/** 集合名 → 领域类型名（便于工具/文档生成与 code review 核对） */
export const COLLECTION_DOC_TYPES: Record<CollectionName, keyof CollectionDocMap> = {
  users: 'users',
  books: 'books',
  words: 'words',
  book_words: 'book_words',
  study_plans: 'study_plans',
  plan_rounds: 'plan_rounds',
  hits: 'hits',
  sessions: 'sessions',
  feedbacks: 'feedbacks',
  session_summaries: 'session_summaries',
  confusion_pairs: 'confusion_pairs',
  issues: 'issues',
  pronunciation_logs: 'pronunciation_logs',
  tts_provider_configs: 'tts_provider_configs',
  ai_provider_configs: 'ai_provider_configs',
  training_items: 'training_items',
  training_records: 'training_records',
  tier_snapshots: 'tier_snapshots',
  ability_snapshots: 'ability_snapshots',
  mock_exam_records: 'mock_exam_records',
  mock_unlock_rules: 'mock_unlock_rules',
  word_bookmarks: 'word_bookmarks',
  word_notes: 'word_notes',
  word_examples: 'word_examples',
  ai_proposals: 'ai_proposals',
  plan_versions: 'plan_versions',
  tool_call_logs: 'tool_call_logs',
};

/**
 * hits 集合的确定性 ID（架构文档 §2.1 / 共享知识 #5）：
 * {plan_id}_{word_id}_{round_no}_{scheduled_date}
 * 天然幂等、防跨端重复（多端并发写用 last-write-win）。
 */
export function hitDeterministicId(planId: string, wordId: string, roundNo: number, scheduledDate: string): string {
  return `${planId}_${wordId}_${roundNo}_${scheduledDate}`;
}
