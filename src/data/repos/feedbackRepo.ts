/**
 * feedbackRepo.ts —— feedbacks / sessions / session_summaries / confusion_pairs /
 * issues / pronunciation_logs 读写 + 稳固信号聚合（isSteadySignal 的输入）。
 * 反自测边界：本仓库只落库与聚合，前台零指标展示由页面层负责。
 */
import type {
  ConfusionPair,
  Device,
  Feedback,
  Issue,
  IssueStatus,
  IssueType,
  L1State,
  L2Tag,
  L3Action,
  Modality,
  PronunciationLog,
  SessionSummary,
  StudySession,
  Tier,
  TTSEngine,
} from '../../types/domain';
import { getDb } from '../cloud';
import { Repository, type CloudDatabaseLike, type Filter } from '../repository';
import { isSteadySignal } from '../../scheduler/mastery';
import type { WordSteadiness } from '../../scheduler/types';
import { runOrQueue } from '../queue';

export interface CreateFeedbackInput {
  hitId: string;
  sessionId: string;
  wordId: string;
  userId: string;
  l1State: L1State;
  reactionMs: number;
  l2Tags?: L2Tag[];
  confusionWordId?: string;
  l3Actions?: L3Action[];
  note?: string;
  modality: Modality;
  roundNo: number;
  tier: Tier;
  device: Device;
}

export interface FeedbackRepo {
  readonly feedbacks: Repository<Feedback>;
  readonly sessions: Repository<StudySession>;
  readonly summaries: Repository<SessionSummary>;
  readonly confusionPairs: Repository<ConfusionPair>;
  readonly issues: Repository<Issue>;
  readonly pronunciationLogs: Repository<PronunciationLog>;

  /** 每 hit 一条（hit_id unique；离线时入队补传） */
  createFeedback(input: CreateFeedbackInput): Promise<'ran' | 'queued'>;
  listFeedbacksBySession(sessionId: string): Promise<Feedback[]>;
  listFeedbacksRange(fromIso: string, toIso: string): Promise<Feedback[]>;

  startSession(input: Omit<StudySession, 'id'> & { id?: string }): Promise<StudySession>;
  endSession(sessionId: string, endedAt: string, hitCount: number): Promise<StudySession | null>;

  saveSessionSummary(summary: Omit<SessionSummary, 'id'> & { id?: string }): Promise<SessionSummary>;

  upsertConfusionPair(userId: string, wordA: string, wordB: string): Promise<void>;
  listTopConfusionPairs(userId: string, limit?: number): Promise<ConfusionPair[]>;

  createIssue(wordId: string, userId: string, type: IssueType, note?: string): Promise<Issue>;
  resolveIssue(issueId: string): Promise<Issue | null>;
  listIssues(userId: string, status?: IssueStatus): Promise<Issue[]>;

  logPronunciation(input: Omit<PronunciationLog, 'id' | 'createdAt'>): Promise<void>;

  /** 稳固信号聚合：按 wordId 分组套用 isSteadySignal（PRD §4.4.4 判定） */
  aggregateSteadiness(feedbacks: Feedback[]): WordSteadiness[];
}

export function createFeedbackRepo(db: CloudDatabaseLike = getDb()): FeedbackRepo {
  const feedbacks = new Repository<Feedback>(db, 'feedbacks');
  const sessions = new Repository<StudySession>(db, 'sessions');
  const summaries = new Repository<SessionSummary>(db, 'session_summaries');
  const confusionPairs = new Repository<ConfusionPair>(db, 'confusion_pairs');
  const issues = new Repository<Issue>(db, 'issues');
  const pronunciationLogs = new Repository<PronunciationLog>(db, 'pronunciation_logs');

  return {
    feedbacks,
    sessions,
    summaries,
    confusionPairs,
    issues,
    pronunciationLogs,

    createFeedback: (input) =>
      runOrQueue('feedback.create', input as unknown as Record<string, unknown>, async () => {
        await feedbacks.insert(input as unknown as Omit<Feedback, 'id'> & { id?: string });
      }),

    listFeedbacksBySession: (sessionId) =>
      feedbacks.list([{ column: 'sessionId', op: 'eq', value: sessionId }], { orderBy: 'createdAt' }),
    listFeedbacksRange: (fromIso, toIso) =>
      feedbacks.list([
        { column: 'createdAt', op: 'gte', value: fromIso },
        { column: 'createdAt', op: 'lte', value: toIso },
      ]),

    startSession: (input) => sessions.insert(input),
    endSession: (sessionId, endedAt, hitCount) =>
      sessions.update(sessionId, { endedAt, hitCount } as Partial<StudySession>),

    saveSessionSummary: (summary) => summaries.insert(summary),

    upsertConfusionPair: async (userId, wordA, wordB) => {
      // 混淆对无序化（a,b 与 b,a 同一对）
      const [a, b] = [wordA, wordB].sort();
      const existing = await confusionPairs.list(
        [
          { column: 'userId', op: 'eq', value: userId },
          { column: 'wordA', op: 'eq', value: a },
          { column: 'wordB', op: 'eq', value: b },
        ],
        { limit: 1 },
      );
      if (existing[0]) {
        await confusionPairs.update(existing[0].id, {
          count: existing[0].count + 1,
          lastAt: new Date().toISOString(),
        } as Partial<ConfusionPair>);
      } else {
        await confusionPairs.insert({ userId, wordA: a, wordB: b, count: 1, lastAt: new Date().toISOString() });
      }
    },
    listTopConfusionPairs: (userId, limit = 10) =>
      confusionPairs.list([{ column: 'userId', op: 'eq', value: userId }], {
        orderBy: 'count',
        ascending: false,
        limit,
      }),

    createIssue: (wordId, userId, type, note) =>
      issues.insert({
        userId,
        wordId,
        type,
        ...(note ? { note } : {}),
        status: 'open',
        createdAt: new Date().toISOString(),
      }),
    resolveIssue: (issueId) =>
      issues.update(issueId, { status: 'resolved', resolvedAt: new Date().toISOString() } as Partial<Issue>),
    listIssues: (userId, status) => {
      const filters: Filter[] = [{ column: 'userId', op: 'eq', value: userId }];
      if (status) filters.push({ column: 'status', op: 'eq', value: status });
      return issues.list(filters, { orderBy: 'createdAt', ascending: false });
    },

    logPronunciation: async (input) => {
      await pronunciationLogs.insert({ ...input, createdAt: new Date().toISOString() });
    },

    aggregateSteadiness: (rows) => {
      const byWord = new Map<string, Feedback[]>();
      for (const f of rows) {
        const list = byWord.get(f.wordId) ?? [];
        list.push(f);
        byWord.set(f.wordId, list);
      }
      const out: WordSteadiness[] = [];
      for (const [wordId, list] of byWord) {
        const steady = isSteadySignal(
          list.map((f) => ({
            l1: f.l1State,
            reactionMs: f.reactionMs,
            l2Tags: f.l2Tags as string[],
            modality: f.modality,
          })),
        );
        out.push({ wordId, steady, tier: list[0]?.tier });
      }
      return out;
    },
  };
}

export type { L1State, L2Tag, L3Action, Modality, Tier, Device, TTSEngine };
