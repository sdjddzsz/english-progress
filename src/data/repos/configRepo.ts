/**
 * configRepo.ts —— tts/ai 配置 + snapshots + mock + AI 提案/版本/审计 相关集合读写。
 * 硬约束 #7：初始化用户时写入默认 TTSProviderConfig，status = 'pending_user_setup'。
 */
import type {
  AbilitySnapshot,
  AIProviderConfig,
  AIProposal,
  MockExamRecord,
  MockUnlockRule,
  ProposalStatus,
  RiskLevel,
  TTSProviderConfig,
  TTSProviderName,
  TTSConfigStatus,
  TierSnapshot,
  ToolCallLog,
} from '../../types/domain';
import {
  DASHSCOPE_DEFAULT_ENDPOINT,
  DASHSCOPE_DEFAULT_MODEL,
  DASHSCOPE_DEFAULT_VOICE,
  DEFAULT_TTS_PROVIDER,
  DEFAULT_TTS_STATUS,
} from '../../config/constants';
import { getDb } from '../cloud';
import { Repository, type CloudDatabaseLike } from '../repository';

export interface ConfigRepo {
  readonly ttsConfigs: Repository<TTSProviderConfig>;
  readonly aiConfigs: Repository<AIProviderConfig>;
  readonly tierSnapshots: Repository<TierSnapshot>;
  readonly abilitySnapshots: Repository<AbilitySnapshot>;
  readonly mockRecords: Repository<MockExamRecord>;
  readonly mockRules: Repository<MockUnlockRule>;
  readonly proposals: Repository<AIProposal>;
  readonly toolCallLogs: Repository<ToolCallLog>;

  /** 硬约束 #7：初始化默认 TTS 配置（pending_user_setup）。已存在则原样返回 */
  initDefaultTTSConfig(userId: string): Promise<TTSProviderConfig>;
  getTTSConfig(userId: string): Promise<TTSProviderConfig | null>;
  updateTTSConfig(id: string, patch: Partial<TTSProviderConfig>): Promise<TTSProviderConfig | null>;

  getAIConfig(userId: string): Promise<AIProviderConfig | null>;
  upsertAIConfig(config: Omit<AIProviderConfig, 'id'> & { id?: string }): Promise<AIProviderConfig>;

  saveTierSnapshot(snapshot: Omit<TierSnapshot, 'id'> & { id?: string }): Promise<TierSnapshot>;
  saveAbilitySnapshot(snapshot: Omit<AbilitySnapshot, 'id'> & { id?: string }): Promise<AbilitySnapshot>;
  listAbilitySnapshots(userId: string): Promise<AbilitySnapshot[]>;

  saveMockRecord(record: Omit<MockExamRecord, 'id'> & { id?: string }): Promise<MockExamRecord>;
  saveMockRule(rule: Omit<MockUnlockRule, 'id'> & { id?: string }): Promise<MockUnlockRule>;
  updateMockRuleStatus(id: string, status: MockUnlockRule['status'], approvedAt?: string): Promise<MockUnlockRule | null>;
  getActiveMockRule(userId: string): Promise<MockUnlockRule | null>;

  createProposal(proposal: {
    planId: string;
    proposer: AIProposal['proposer'];
    changes: Record<string, unknown>;
    reason: string;
    riskLevel: RiskLevel;
  }): Promise<AIProposal>;
  decideProposal(id: string, status: Extract<ProposalStatus, 'approved' | 'rejected'>): Promise<AIProposal | null>;
  listPendingProposals(planId: string): Promise<AIProposal[]>;

  logToolCall(entry: Omit<ToolCallLog, 'id' | 'createdAt'>): Promise<ToolCallLog>;
}

export function createConfigRepo(db: CloudDatabaseLike = getDb()): ConfigRepo {
  const ttsConfigs = new Repository<TTSProviderConfig>(db, 'tts_provider_configs');
  const aiConfigs = new Repository<AIProviderConfig>(db, 'ai_provider_configs');
  const tierSnapshots = new Repository<TierSnapshot>(db, 'tier_snapshots');
  const abilitySnapshots = new Repository<AbilitySnapshot>(db, 'ability_snapshots');
  const mockRecords = new Repository<MockExamRecord>(db, 'mock_exam_records');
  const mockRules = new Repository<MockUnlockRule>(db, 'mock_unlock_rules');
  const proposals = new Repository<AIProposal>(db, 'ai_proposals');
  const toolCallLogs = new Repository<ToolCallLog>(db, 'tool_call_logs');

  return {
    ttsConfigs,
    aiConfigs,
    tierSnapshots,
    abilitySnapshots,
    mockRecords,
    mockRules,
    proposals,
    toolCallLogs,

    initDefaultTTSConfig: async (userId) => {
      const existing = await ttsConfigs.list([{ column: 'userId', op: 'eq', value: userId }], { limit: 1 });
      if (existing[0]) return existing[0];
      // DashScope 主轨默认值只从 constants.ts 取（单一来源）；status 仍 pending_user_setup（硬约束 #7）
      return ttsConfigs.insert({
        userId,
        provider: DEFAULT_TTS_PROVIDER as TTSProviderName,
        endpoint: DASHSCOPE_DEFAULT_ENDPOINT,
        voice: DASHSCOPE_DEFAULT_VOICE,
        model: DASHSCOPE_DEFAULT_MODEL,
        ssmlPhonemeEnabled: true,
        status: DEFAULT_TTS_STATUS as TTSConfigStatus, // pending_user_setup（硬约束 #7）
        fallbackEngine: 'ipa_espeak',
      });
    },
    getTTSConfig: async (userId) => {
      const rows = await ttsConfigs.list([{ column: 'userId', op: 'eq', value: userId }], { limit: 1 });
      return rows[0] ?? null;
    },
    updateTTSConfig: (id, patch) => ttsConfigs.update(id, patch),

    getAIConfig: async (userId) => {
      const rows = await aiConfigs.list([{ column: 'userId', op: 'eq', value: userId }], { limit: 1 });
      return rows[0] ?? null;
    },
    upsertAIConfig: (config) => aiConfigs.insert(config),

    saveTierSnapshot: (snapshot) => tierSnapshots.insert(snapshot),
    saveAbilitySnapshot: (snapshot) => abilitySnapshots.insert(snapshot),
    listAbilitySnapshots: (userId) =>
      abilitySnapshots.list([{ column: 'userId', op: 'eq', value: userId }], { orderBy: 'weekStart', ascending: false }),

    saveMockRecord: (record) => mockRecords.insert(record),
    saveMockRule: (rule) => mockRules.insert(rule),
    updateMockRuleStatus: (id, status, approvedAt) =>
      mockRules.update(id, approvedAt ? { status, approvedAt } : { status }),
    getActiveMockRule: async (userId) => {
      const rows = await mockRules.list(
        [
          { column: 'userId', op: 'eq', value: userId },
          { column: 'status', op: 'in', values: ['approved', 'active'] },
        ],
        { orderBy: 'createdAt', ascending: false, limit: 1 },
      );
      return rows[0] ?? null;
    },

    createProposal: (p) =>
      proposals.insert({
        planId: p.planId,
        proposer: p.proposer,
        changes: p.changes,
        reason: p.reason, // 硬约束 #6：无 reason 的提案在 AI 层即被拒绝（T03 schema 校验）
        riskLevel: p.riskLevel,
        status: 'pending',
        createdAt: new Date().toISOString(),
      }),
    decideProposal: (id, status) => proposals.update(id, { status, decidedAt: new Date().toISOString() }),
    listPendingProposals: (planId) =>
      proposals.list(
        [
          { column: 'planId', op: 'eq', value: planId },
          { column: 'status', op: 'eq', value: 'pending' },
        ],
        { orderBy: 'createdAt', ascending: false },
      ),

    logToolCall: (entry) => toolCallLogs.insert({ ...entry, createdAt: new Date().toISOString() }),
  };
}
