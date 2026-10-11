/**
 * MRCS 调度器类型定义（架构文档第四部分）。
 * 本目录全部为纯函数：零 React / 零 DOM / 零 IO；
 * 输入输出全为可序列化数据；同参数同输入必产生同输出（确定性）。
 */

export type Tier = 1 | 2 | 3 | 4;
export const TIERS: readonly Tier[] = [1, 2, 3, 4];

export type Modality = 'visual' | 'audio';
export type PlanMode = 'recommended' | 'fallback';
export type HitStatus = 'pending' | 'done' | 'overdue' | 'deferred';

/** 计划参数（与 domain.StudyPlan 的计划字段一一对应） */
export interface PlanParams {
  /** 各层轮次：推荐 {1:2,2:2,3:3,4:3} / 保底全 2 */
  tierRounds: Record<Tier, number>;
  planMode: PlanMode;
  startDate: string; // ISO date
  deadlineDate: string; // 默认 '2026-12-05'，硬约束
  sprintStartDate: string; // 默认 '2026-12-05'
  dailyBudgetMin: number; // 30–120，默认 60
  avgHitSec: number; // 默认 12，首周校准
  gapMinDays: number; // 默认 = 轮窗口 × 0.6（0 表示由 expand 按系数计算）
  modalRatio: Record<Tier, number>; // 逐层听觉占比，默认 {1:.7,2:.5,3:.3,4:.2}
  masteryDecayEnabled: boolean; // 默认 true（Q3）
  tierRoundDays?: Partial<Record<Tier, number[]>>; // 逐层逐轮不等分
  listSize: number; // 默认 50
}

/** 各层词量，如 {1:1750, 2:2450, 3:1750, 4:1050} */
export interface TierWordCounts {
  [t: number]: number;
}

/**
 * 稳固判定结果（PRD §4.4.4：秒认≥2 且 无L2标签 且 听觉识别≥1）。
 * tier 为可选附加：用于 validate 阶段按层折减 hits（expand 阶段按 wordId 匹配）。
 */
export interface WordSteadiness {
  wordId: string;
  steady: boolean;
  tier?: Tier;
}

/** 反馈信号（由 feedbackRepo 聚合后传入，稳固判定的输入） */
export interface FeedbackSignal {
  l1: 'instant' | 'recognized' | 'familiar_but_forgotten' | 'unknown';
  reactionMs: number;
  l2Tags: string[];
  modality: Modality;
}

// ===== validate.ts =====

export interface ValidationInput {
  params: PlanParams;
  tierCounts: TierWordCounts;
  steadyWords: WordSteadiness[];
}

export interface ValidationResult {
  pass: boolean;
  /** Σ(W_t×R_t)，降频开启按折减 */
  totalHits: number;
  /** ceil(totalHits / T) */
  dailyHits: number;
  /** dailyHits × avgHitSec / 60 */
  dailyMinutes: number;
  /** 与 budget 的余量比例，±5% 内为"临界"（critical=true，黄色警告） */
  marginRatio: number;
  /** 未通过但余量在 ±5% 内 → 临界（呈现黄色警告 + 三个降级选项） */
  critical: boolean;
  /** 计划窗口天数 T = deadline − start */
  windowDays: number;
}

/**
 * 降级路径（PRD §4.4.7）。resolveDegradePath 按顺序判定：
 * 推荐/保底通过 → 'fallback'（无需降级）；
 * 保底不通过但整层冻结 T1 后通过 → 'freeze_t1'；
 * 窗口非法（start ≥ deadline）→ 'exceed_deadline'；
 * 预算低于维持模式线 → 'maintenance_mode'；
 * 其余 → 'raise_budget'。
 */
export type DegradePath = 'fallback' | 'freeze_t1' | 'raise_budget' | 'exceed_deadline' | 'maintenance_mode';

// ===== expand.ts =====

/** 各层各轮起止日窗口 */
export interface PlanRoundWindow {
  tier: Tier;
  roundNo: number;
  startDate: string; // 含
  endDate: string; // 含
  days: number;
  wordCount: number;
  /** 物理下限 ceil(W_t / maxDailyHits) 天 */
  physicalFloorDays: number;
  /** 窗口天数 < 物理下限时为 true（需由 validate/人工干预解决） */
  floorViolated: boolean;
}

/** 单日队列条目的解释信息（S3"为什么是这些词"） */
export interface DayExplain {
  roundIdxInWindow: number;
  lastSeen?: { date: string; roundNo: number; modality: Modality };
}

export interface QueueEntry {
  wordId: string;
  tier: Tier;
  roundNo: number;
  listNo: number;
  modality: Modality;
  explain: DayExplain;
}

// ===== overdue.ts =====

/** 调度器视角的 hit 最小记录（与 domain.Hit 结构兼容） */
export interface HitRecord {
  id: string;
  planId: string;
  wordId: string;
  tier: Tier;
  roundNo: number;
  listNo: number;
  scheduledDate: string;
  modality: Modality;
  status: HitStatus;
}

export interface OverdueSummary {
  count: number;
  threshold: number; // 2 × dailyHits
  mustReschedule: boolean;
  idleDays: number; // 距上次学习的天数（无记录时为 0）
}

export type RescheduleStrategy = 'extend' | 'compress' | 'drop_round' | 'freeze';

/** 四策略影响预览（面板逐条展示：大白话 + 后果） */
export interface StrategyPreview {
  strategy: RescheduleStrategy;
  plainWords: string;
  newFinishDate: string;
  newDailyHits: number;
  validation: ValidationResult;
  affectedWordCount: number;
  /** 仅 extend 可能 true：新完成日突破 deadline */
  deadlineExceeded: boolean;
  /** 仅 compress 可能 true：近期日额度超过物理上限（PRD §4.4.4-B），需换策略或上调预算 */
  capacityExceeded?: boolean;
  /** capacityExceeded 为 true 时：raw 日额度 − maxDailyHits 的超出量 */
  capacityOverflow?: number;
}

export interface HitMutation {
  hitId: string;
  action: 'reschedule' | 'defer';
  newScheduledDate?: string;
  newStatus: HitStatus;
  reason: string;
}

export type StrategyOutcome =
  | {
      ok: true;
      newPlan: PlanParams;
      hitMutations: HitMutation[];
      newFinishDate: string;
      newDailyHits: number;
    }
  | { ok: false; error: 'DeadlineExceeded' | 'CapacityExceeded'; message: string };

// ===== preview.ts =====

export interface ImpactPreviewResult {
  totalHitsDelta: number;
  dailyMinutes: ValidationResult;
  newFinishDate: string;
  passChanged: boolean;
}
