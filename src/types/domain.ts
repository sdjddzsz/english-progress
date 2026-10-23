/**
 * 领域类型与枚举 —— 数据模型 24 集合（架构文档第二部分 / PRD 第六章）。
 *
 * ⚠ 反自测物理锁死（PRD §6.3 硬约束 #1）：
 *   Feedback / TrainingRecord / AbilitySnapshot 三个类型中
 *   【物理上不存在】 score / accuracy / rating 字段。
 *   code review 时以 src/config/constants.ts 的 FORBIDDEN_SELF_TEST_TERMS 核对。
 *
 * 字段命名约定：TS 侧统一 camelCase；云数据库集合名 snake_case（见 COLLECTIONS）。
 */

// ===== 基础枚举 =====

export type Tier = 1 | 2 | 3 | 4; // T1 已掌握 / T2 熟词 / T3 半熟 / T4 生词
export type Modality = 'visual' | 'audio';
export type PlanMode = 'recommended' | 'fallback'; // Q2：推荐/保底双档
export type HitStatus = 'pending' | 'done' | 'overdue' | 'deferred'; // 硬约束 #2：overdue 与 deferred 是一等公民
export type BookSource = 'builtin' | 'import' | 'manual';
export type BookStatus = 'active' | 'finished' | 'archived';
export type WordStatus = 'normal' | 'deferred' | 'mastered' | 'steady';
export type PlanStatus = 'draft' | 'active' | 'maintenance' | 'finished'; // maintenance = 实习期维持模式
export type RoundStatus = 'pending' | 'in_progress' | 'done';
export type Device = 'mobile' | 'desktop';

// ===== 反馈标签体系（PRD §4.6）=====

/** L1 认知状态（必选单选）：😀秒认 / 😐认得 / 😵见过想不起 / ❌不认识 */
export type L1State = 'instant' | 'recognized' | 'familiar_but_forgotten' | 'unknown';

export type L2Category = 'meaning' | 'form' | 'pronunciation' | 'usage' | 'context' | 'material';

/** L2 问题定位（可选多选 ≤3），标签原文与 PRD §4.6 一致 */
export type L2Tag =
  | '词义记不住'
  | '中文释义太抽象易混'
  | '多义项分不清'
  | '拼写词形记不住'
  | '形近词混淆'
  | '词根词缀不熟'
  | '发音读不准'
  | '重音位置记不住'
  | '听不出这个词'
  | '词性判断错'
  | '搭配介词不会用'
  | '知道意思但造句造不出'
  | '例句看不懂'
  | '阅读里没反应过来'
  | '听力里没反应过来'
  | '释义有误'
  | '例句不当'
  | '音标有误';

/** L3 处置动作（可选，直接改变调度） */
export type L3Action =
  | 'extra_practice' // 加练：本轮再多出现 1 次
  | 'postpone' // 暂缓：本轮不再出现，移到末轮复查
  | 'skip_round' // 跳过本轮：标 deferred，末轮出现一次
  | 'star' // 重点收藏
  | 'pronunciation_doubt' // 发音存疑 → Issue
  | 'pronunciation_error' // 发音错误 → Issue
  | 'content_doubt'; // 释义/例句存疑 → Issue

// ===== TTS / AI / 训练 枚举 =====

/**
 * neural_tts = 云端神经语音（需密钥）；ipa_espeak = 离线 WASM 兜底；
 * web_speech = 浏览器内置 speechSynthesis（零网络零依赖，最后的兜底）。
 */
export type TTSEngine = 'neural_tts' | 'ipa_espeak' | 'web_speech';
export type TTSProviderName = 'azure' | 'openai_compatible' | 'dashscope';
export type TTSConfigStatus = 'pending_user_setup' | 'active' | 'error'; // 硬约束 #7：默认 pending_user_setup
export type AIProviderType = 'workbuddy' | 'openai_compatible';
export type TrainingItemType = 'listen_recall' | 'cn_to_en' | 'listening' | 'reading' | 'speaking' | 'writing';
export type TrainingSource = 'exam' | 'ai' | 'tts' | 'user';
export type IssueType = 'pronunciation' | 'definition' | 'example' | 'ipa';
export type IssueStatus = 'open' | 'resolved';
export type SessionType = 'vocab_visual' | 'vocab_audio' | 'cn_to_en' | 'integrated' | 'mock_exam';

// ===== AI 授权与版本化 =====

export type RiskLevel = 'auto' | 'confirm' | 'require';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';
export type ChangedBy = 'user' | 'ai' | 'system';
export type MockRuleStatus = 'draft' | 'approved' | 'active' | 'revoked';

// ===== 能力画像词级状态（PRD §4.8.2，无总分）=====

export type WordTierState = 'untouched' | 'rusty' | 'familiar' | 'steady' | 'integrated';

// ===== 24 集合实体 =====

export interface User {
  id: string;
  email?: string;
  phone?: string;
  timezone: string;
  /** 非计划参数偏好（通知等） */
  settings: Record<string, unknown>;
  createdAt: string;
}

export interface Book {
  id: string;
  userId: string;
  name: string;
  source: BookSource;
  wordCount: number;
  tierCount: number;
  listSize: number;
  status: BookStatus;
  createdAt: string;
}

/**
 * 词义项（sense）—— 一个 lemma 下的**单个词性 + 释义 + 专属读音**。
 *
 * ⚠ 为什么必须有这一层（用户 2026-10-13 明确要求）：
 *   同一个拼写在不同词性下读音不同且词义不同（record 名词 /ˈrekəd/ 记录 vs 动词 /rɪˈkɔːd/ 录制；
 *   refuse /ˈrefjuːs/ 废物 vs /rɪˈfjuːz/ 拒绝；live /laɪv/ 活的 vs /lɪv/ 生活）。
 *   过去只有 `senses: string[]`（一坨字符串）+ 单词级 `ipa/arpabet`（一个读音）⇒
 *   这类词**无法表达「同一个词的另一读音对应另一批意思」**，
 *   听音选词时也会把两个不同的词当成同一个词去判分（用户原话：不同读音就当不同的单词判定）。
 *
 * 设计约束：
 *  - senseId 是**稳定可排序**的（`lemma#k`，k 为该 lemma 内的义项序号），云端主键即用它；
 *  - `pronunciationKey` 标识「这个义项用的是哪一档读音」：同 lemma 下不同读音 ⇒ 不同 key；
 *    判定粒度（掌握程度、轮次、命中记录）都挂在 senseId 上，不是挂在 lemma 上。
 *  - `arpabet` 为空表示该义项未绑定读音（CMUdict 只有一档读音时全部义项共用同一档）。
 */
export interface WordSense {
  /** `lemma#序号`，云端主键；**判定与调度的最小单位** */
  senseId: string;
  lemma: string;
  /** 词性标记原文（ECDICT 原文：n. / vt. / a. / [计] …）；无则空串 */
  pos: string;
  /** 该义项的中文释义（ECDICT 原文） */
  zh: string;
  /** 该义项的专属读音标识：同 lemma 不同读音 ⇒ 不同 key（判定「是不是同一个词」的依据） */
  pronunciationKey: string;
  /** 该义项专属 ARPAbet（CMUdict 原值）；未绑定读音时为空 */
  arpabet: string;
  /** 该义项专属 IPA（由 arpabet 派生）；未绑定时为空 */
  ipa: string;
}

/** 词本体（ECDICT 裁剪或导入） */
export interface Word {
  id: string;
  lemma: string;
  /**
   * 单词级 IPA = **首个义项**的读音（兼容旧调用方 / 列表展示）；
   * 多读音词请读 `senses[i].ipa`，不要只读这里。
   */
  ipa: string;
  /**
   * CMUdict ARPAbet 发音真源（命中才有；无该字段 = CMUdict 未命中，P0-9 降级纯文本合成）。
   * DashScope <phoneme alphabet="cmu"> 零转换直用；展示 IPA 由 arpabetToIpa 派生。
   * 同样 = 首个义项读音；多读音词请读 `senses[i].arpabet`。
   */
  arpabet?: string;
  pos?: string;
  /** 扁平释义（= 全部义项的 zh 拼接）；⚠ 不含读音信息，多读音词必须走 `senses` */
  senses: string[];
  /**
   * 义项列表（词性 + 释义 + 专属读音）。**判定与展示的唯一权威来源**。
   * 空数组时降级为「单词级单义项」（旧数据兼容路径，见 normalizeSenses）。
   */
  sensesDetail?: WordSense[];
  examples: { en: string; zh: string }[];
  /**
   * 词形变化（ECDICT `exchange` 解析结果）。
   * 键：p=过去式 / d=过去分词 / i=现在分词 / 3=三单 / r=比较级 / t=最高级 / 0=原形 / s=复数 / 1=原型变化。
   * 值形如 `studied/d`（同一格多个变体用 `/` 分隔）。
   */
  exchange?: Record<string, string>;
  frequency: number;
  /** 'cet4' | 'cet6' | 'kaoyan' 等 */
  tags: string[];
}

/** 词书-词关联；难度层 tier 在此（Q1 决策） */
export interface BookWord {
  id: string;
  bookId: string;
  wordId: string;
  listNo: number;
  orderInList: number;
  tier: Tier;
  tierUpdatedAt: string;
  status: WordStatus;
  /** ★ 考查制（用户 2026-10-14）：连续判定「熟练」的次数；≥ QUIZ_GRADUATE_STREAK(5) 本轮出池 */
  streak: number;
  /** 连续「不熟/生词」次数；≥ QUIZ_SPECIAL_TRAINING_FAILS(3) 进入特种训练 */
  failStreak: number;
  /** 特种训练标记：无视间隔、每天必考，直到毕业 */
  specialTraining: boolean;
  /** 上次考查时间（按 tier 决定下次应考间隔） */
  lastQuizAt?: string;
  /** 每轮过关连续达标计数（用户 2026-10-14 建制，2026-10-15 改按轮：
   *  一轮内连对 N 次达到挡位线才放行；跨天重新起算） */
  quizDayStreak: number;
  /** 今天是否已过关（只对当天有效，隔夜失效；2026-10-15 起只在达到过关线时才写 true） */
  quizDayPassed: boolean;
  /**
   * ★ 学习阶段（用户 2026-10-15 四阶段制）：1=由词选义 2=由义选词 3=听音选词 4=听词拼写；
   * 0=阶段四毕业=彻底毕业（不再出现在任何阶段池里）。默认 1。
   */
  stage: 0 | 1 | 2 | 3 | 4;
  /** 当前阶段内连续「熟练」次数（阶段毕业判定用；晋级/降阶时清零；阶段四不使用） */
  stageStreak: number;
}

export interface StudyPlan {
  id: string;
  bookId: string;
  userId: string;
  /** 各层轮次：推荐档默认 {1:2,2:2,3:3,4:3}，保底档全 2 */
  tierRounds: Record<Tier, number>;
  planMode: PlanMode;
  startDate: string;
  /** 默认 2026-12-05，硬约束：展期不得突破 */
  deadlineDate: string;
  /** 默认 2026-12-05；冲刺周 12-05~12-12 不排轮次 */
  sprintStartDate: string;
  /** 默认 60（可调 30–120） */
  dailyBudgetMin: number;
  /** 默认 12，首周真实数据校准 */
  avgHitSec: number;
  /** 轮间隔下限，默认 = 轮窗口 × 0.6 */
  gapMinDays: number;
  /** 逐层听觉占比，默认 {1:0.7,2:0.5,3:0.3,4:0.2} */
  modalRatio: Record<Tier, number>;
  /** 掌握度降频，默认 true（Q3，硬约束 #3） */
  masteryDecayEnabled: boolean;
  /** 逐层逐轮天数（不等分手调），key 为 tier 数字字符串 */
  tierRoundDays?: Record<string, number[]>;
  version: number;
  status: PlanStatus;
  createdAt: string;
}

export interface PlanRound {
  id: string;
  planId: string;
  tier: Tier;
  roundNo: number;
  startDate: string;
  endDate: string;
  coverageTarget: number;
  coveredCount: number;
  status: RoundStatus;
}

/** 一次覆盖任务（含模态）。id 为确定性 ID：{planId}_{wordId}_{roundNo}_{scheduledDate} */
export interface Hit {
  id: string;
  planId: string;
  wordId: string;
  userId: string;
  tier: Tier;
  roundNo: number;
  listNo: number;
  scheduledDate: string;
  modality: Modality;
  status: HitStatus;
  completedAt?: string;
  /** 可解释性冗余（S3"为什么是这些词"直接取用） */
  explain: HitExplain;
}

export interface HitExplain {
  roundIdxInWindow: number;
  lastSeen?: { date: string; roundNo: number; modality: Modality };
}

export interface StudySession {
  id: string;
  userId: string;
  type: SessionType;
  startedAt: string;
  endedAt?: string;
  device: Device;
  hitCount: number;
}

/**
 * 反馈标记，每次 hit 一条（hit_id unique）。
 * ⚠ 硬约束 #1：无 score / accuracy / rating 字段（反自测物理锁死）。
 * reactionMs 为隐式评估输入，不展示前台。
 */
export interface Feedback {
  id: string;
  hitId: string;
  sessionId: string;
  wordId: string;
  userId: string;
  l1State: L1State;
  reactionMs: number;
  /** ≤3（MAX_L2_TAGS） */
  l2Tags: L2Tag[];
  confusionWordId?: string;
  l3Actions: L3Action[];
  /** ≤60 字，供 AI 读取 */
  note?: string;
  modality: Modality;
  roundNo: number;
  tier: Tier;
  device: Device;
  createdAt: string;
}

/** 会话摘要（PRD §4.6；架构文档补齐的集合） */
export interface SessionSummary {
  id: string;
  sessionId: string;
  hitCount: number;
  l1Distribution: Record<L1State, number>;
  l2Top: { tag: L2Tag; count: number }[];
  newConfusionPairs: number;
  newIssues: number;
  avgReactionMs: number;
  modalityDistribution: Record<Modality, number>;
  createdAt: string;
}

export interface ConfusionPair {
  id: string;
  userId: string;
  wordA: string;
  wordB: string;
  count: number;
  lastAt: string;
}

export interface Issue {
  id: string;
  userId: string;
  wordId: string;
  type: IssueType;
  note?: string;
  status: IssueStatus;
  createdAt: string;
  resolvedAt?: string;
}

/** 发音引擎成功/回退日志 */
export interface PronunciationLog {
  id: string;
  wordId: string;
  engine: TTSEngine;
  success: boolean;
  fallbackUsed: boolean;
  error?: string;
  /** P1-5：本次合成字符数（DashScope usage.characters 口径，成本卡精确聚合用） */
  chars?: number;
  /** P0-9：音素来源。cmu=dashscope phoneme 注入；ipa=azure phoneme；text=纯文本降级 */
  phonemeSource?: 'cmu' | 'ipa' | 'text';
  /** 2026-10-14：云音频库本次缺词（该音色此前没录过）→ 现场合成；合成成功会回传云端 */
  cloudMiss?: boolean;
  /** 2026-10-18：本次为用户主动「重新合成」（regenerate），区别于正常出题合成 */
  regenerate?: boolean;
  createdAt: string;
}

/**
 * TTS 插拔配置。key 存云端配置文档（本系统已声明的例外，见架构文档 §8 #2），
 * 运行时取入内存，不入 localStorage / 代码。api_key_ref 指向配置文档内的密钥字段。
 * 硬约束 #7：status 默认 'pending_user_setup'。
 */
export interface TTSProviderConfig {
  id: string;
  userId: string;
  provider: TTSProviderName;
  endpoint?: string;
  apiKeyRef?: string;
  /**
   * apiKeyRef 指向的密钥字段本体（默认 'runtimeApiKey'）。
   * 用户在设置页勾选"跨刷新保留"时才落库（RLS owner-only）；未勾选时该字段保持为空，
   * 密钥只在会话内存里（刷新即失）。架构 §8 #2 声明的唯一例外。
   */
  runtimeApiKey?: string;
  voice?: string;
  /** 模型名（dashscope：cosyvoice-v2 等；openai_compatible：tts-1 等）。默认取 constants.ts DashScope 常量 */
  model?: string;
  ssmlPhonemeEnabled: boolean;
  status: TTSConfigStatus;
  fallbackEngine: 'ipa_espeak';
  lastTestAt?: string;
}

export interface AIProviderConfig {
  id: string;
  userId: string;
  providerType: AIProviderType;
  baseUrl?: string;
  model?: string;
  apiKeyRef?: string;
  isDefault: boolean;
  lastTestAt?: string;
}

export interface TrainingItem {
  id: string;
  type: TrainingItemType;
  source: TrainingSource;
  content: Record<string, unknown>;
  /** 目标词 100% 来自当前队列（四阶共同规则） */
  targetWords: string[];
  createdBy: ChangedBy;
}

/**
 * 训练记录。
 * ⚠ 硬约束 #1：无 score / accuracy / rating 字段（反自测物理锁死）。
 */
export interface TrainingRecord {
  id: string;
  sessionId: string;
  itemId: string;
  userId: string;
  /** 用户产出（口述转写/拼写/造句原文等） */
  userOutput: Record<string, unknown>;
  /** 本次训练命中的目标词 hit */
  wordHits: string[];
  createdAt: string;
}

/** 初始摸底与分层校准记录 */
export interface TierSnapshot {
  id: string;
  userId: string;
  sampledWordIds: string[];
  responses: Record<string, L1State>;
  computedTiers: Record<string, Tier>;
  calibratedAt: string;
}

/**
 * 后台隐式评估周度快照（P1-04）。
 * ⚠ 硬约束 #1：无总分/正确率/评级/预计考试分数字段（反自测物理锁死）。
 */
export interface AbilitySnapshot {
  id: string;
  userId: string;
  weekStart: string;
  /** 按词级状态计数 */
  wordStatesSummary: Record<WordTierState, number>;
  weakPoints: {
    forgetfulWords: string[];
    topConfusionPairs: { wordA: string; wordB: string; count: number }[];
    l2CategoryCounts: Record<L2Category, number>;
  };
  /** 视觉/听觉差距曲线数据（v1.0 核心） */
  modalityGap: {
    visualShare: number;
    audioShare: number;
    curve: { date: string; visual: number; audio: number }[];
  };
  /** 各层贯通率（诊断口径） */
  tierPassRates: Record<Tier, number>;
  createdAt: string;
}

/** 模考记录（diag_report 仅后台 DiagReportView 渲染，前台不可达） */
export interface MockExamRecord {
  id: string;
  userId: string;
  paperRef: string;
  takenAt: string;
  unlockRuleId?: string;
  diagReport: Record<string, unknown>;
  createdAt: string;
}

/** 模考解锁规则（AI 制定，用户批准；不预设固定分数线） */
export interface MockUnlockRule {
  id: string;
  userId: string;
  ruleJson: Record<string, unknown>;
  status: MockRuleStatus;
  createdBy: 'ai';
  reason: string;
  approvedAt?: string;
}

/**
 * 收藏 / 生词本条目（用户 2026-10-13：背单词软件的基础功能）。
 *
 * 为什么要独立集合而不是只打标记：收藏是**跨词书**的（用户收藏的词不属于任何一本词书也能存），
 * 且需要「收藏时间 / 来源 / 备注」这些元信息 —— book_words 上加一个布尔列都表达不了。
 * id = `{userId}_{wordId}`：天然幂等（重复收藏 = 覆盖），切/删都一条搞定。
 */
export interface WordBookmark {
  id: string;
  userId: string;
  wordId: string;
  /** 收藏时的 lemma 快照（词条被删也不影响生词本可读） */
  lemma: string;
  /** 来源上下文：来自哪次练习/哪本词书，便于回溯 */
  source: string;
  /** 用户自己写的备注（可选） */
  note?: string;
  createdAt: string;
}

/** 单词笔记（用户 2026-10-17：题旁笔记按钮 + 专门页面查看）。
 *  确定性 id = `{userId}_{wordId}`：一词一记，重复保存 = 覆盖（同 word_bookmarks 的幂等思路）。
 */
export interface WordNote {
  id: string;
  userId: string;
  wordId: string;
  /** 保存时的 lemma 快照（词条变动也不影响笔记可读） */
  lemma: string;
  /** 笔记正文（多行） */
  content: string;
  /** 来源：quiz:1 / stage-quiz:2 / manual …便于回溯 */
  source: string;
  /** 保存时考查的义项下标（可选） */
  senseIndex?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 用户例句（用户 2026-10-22：考查页长按任一释义「生成例句」，每次生成追加一条，可删）。
 * 归属粒度 = senseId（`lemma#序号`）——例句是针对某个义项生成的；
 * 朗读走 TTS 主轨（AI 发音），与单词发音同一编排链。
 */
export interface WordExample {
  id: string;
  userId: string;
  wordId: string;
  /** 归属义项（与 WordSense.senseId 同构） */
  senseId: string;
  /**
   * 归属**子义项**文本（用户 2026-10-23：一个义项里「放弃，抛弃」按逗号拆开，
   * 例句针对单条意思生成）。老数据无此列 ⇒ 展示时回落整条释义。
   */
  senseZh?: string;
  /** 生成时的 lemma 快照 */
  lemma: string;
  /** 英文例句 */
  en: string;
  /** 中文翻译 */
  zh: string;
  /** 来源：ai = 模型生成（预留 manual 手工） */
  source: string;
  createdAt: string;
  updatedAt: string;
}

/** AI 方案提案。硬约束 #6：reason 与 changes(diff) 必填，缺则拒绝落地 */
export interface AIProposal {
  id: string;
  planId: string;
  proposer: ChangedBy;
  changes: Record<string, unknown>;
  reason: string;
  riskLevel: RiskLevel;
  status: ProposalStatus;
  createdAt: string;
  decidedAt?: string;
}

/** 计划版本快照，用于回滚（回滚本身也记版本） */
export interface PlanVersion {
  id: string;
  planId: string;
  versionNo: number;
  snapshot: Record<string, unknown>;
  changedBy: ChangedBy;
  reason: string;
  diffSummary: string;
  createdAt: string;
}

/** AI 工具调用审计 */
export interface ToolCallLog {
  id: string;
  actor: ChangedBy;
  toolName: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  applied: boolean;
  proposalId?: string;
  createdAt: string;
}

// ===== 集合清单（25 个，云文档数据库 / PostgREST 表）=====

export const COLLECTIONS = [
  'users',
  'books',
  'words',
  'book_words',
  'study_plans',
  'plan_rounds',
  'hits',
  'sessions',
  'feedbacks',
  'session_summaries',
  'confusion_pairs',
  'issues',
  'pronunciation_logs',
  'tts_provider_configs',
  'ai_provider_configs',
  'training_items',
  'training_records',
  'tier_snapshots',
  'ability_snapshots',
  'mock_exam_records',
  'mock_unlock_rules',
  'word_bookmarks',
  'word_notes',
  'word_examples',
  'ai_proposals',
  'plan_versions',
  'tool_call_logs',
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

/** 集合名 → 文档类型映射 */
export interface CollectionDocMap {
  users: User;
  books: Book;
  words: Word;
  book_words: BookWord;
  study_plans: StudyPlan;
  plan_rounds: PlanRound;
  hits: Hit;
  sessions: StudySession;
  feedbacks: Feedback;
  session_summaries: SessionSummary;
  confusion_pairs: ConfusionPair;
  issues: Issue;
  pronunciation_logs: PronunciationLog;
  tts_provider_configs: TTSProviderConfig;
  ai_provider_configs: AIProviderConfig;
  training_items: TrainingItem;
  training_records: TrainingRecord;
  tier_snapshots: TierSnapshot;
  ability_snapshots: AbilitySnapshot;
  mock_exam_records: MockExamRecord;
  mock_unlock_rules: MockUnlockRule;
  word_bookmarks: WordBookmark;
  word_notes: WordNote;
  word_examples: WordExample;
  ai_proposals: AIProposal;
  plan_versions: PlanVersion;
  tool_call_logs: ToolCallLog;
}
