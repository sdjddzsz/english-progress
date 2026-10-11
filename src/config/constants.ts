/**
 * 全局常量 —— 默认参数单一来源（架构文档第七部分 #8）。
 * 所有默认值只在本文件出现一次；调度器/仓库/页面一律从这里取。
 */
import type { PlanMode, PlanParams, Tier } from '../scheduler/types';
import type { TTSProviderName, TTSConfigStatus } from '../types/domain';

// ===== 日期锚点 =====

/** 词书轮次截止日（硬约束：展期不得突破） */
export const DEFAULT_DEADLINE_DATE = '2026-12-05';
/** 冲刺周起点（12-05 ~ 12-12 不排轮次） */
export const DEFAULT_SPRINT_START_DATE = '2026-12-05';
/** 六级考试日 */
export const EXAM_DATE = '2026-12-12';

// ===== 调度默认参数 =====

/** 单次 hit 平均耗时（秒），首周用真实 reaction_ms 校准 */
export const DEFAULT_AVG_HIT_SEC = 12;
/** 每日分钟预算（校验基准，可调区间 30–120） */
export const DEFAULT_DAILY_BUDGET_MIN = 60;
export const DAILY_BUDGET_MIN_RANGE: readonly [number, number] = [30, 120];
/** 维持模式判定线（≈实习期 21 分/天，低于此值任何档位均不通过 → 维持模式） */
export const MAINTENANCE_MODE_BUDGET_MIN = 25;
/** 临界判定：与预算差 ±5% 内显示黄色警告（PRD §4.4.6） */
export const CRITICAL_MARGIN_RATIO = 0.05;
/** List 默认大小（50 词/List） */
export const DEFAULT_LIST_SIZE = 50;
/** 轮间隔下限系数：gapMin = 轮窗口 × 0.6 */
export const GAP_MIN_WINDOW_FACTOR = 0.6;

/** 推荐档层内轮次（Q2 拍板：T1:2 / T2:2 / T3:3 / T4:3） */
export const RECOMMENDED_TIER_ROUNDS: Record<Tier, number> = { 1: 2, 2: 2, 3: 3, 4: 3 };
/** 保底档层内轮次（全层 2） */
export const FALLBACK_TIER_ROUNDS: Record<Tier, number> = { 1: 2, 2: 2, 3: 2, 4: 2 };
/** 逐层听觉占比默认值（视觉为主分层、听觉为辅） */
export const DEFAULT_MODAL_RATIO: Record<Tier, number> = { 1: 0.7, 2: 0.5, 3: 0.3, 4: 0.2 };
/** 掌握度降频默认开启（Q3，硬约束 #3） */
export const DEFAULT_MASTERY_DECAY_ENABLED = true;

/** 摸底前假设层分布（摸底后自动更新），用于示例/预演 */
export const ASSUMED_TIER_DISTRIBUTION: Record<Tier, number> = { 1: 0.25, 2: 0.35, 3: 0.25, 4: 0.15 };

/** 默认计划参数（桌面端/测试构造 PlanParams 的单一来源） */
export function defaultPlanParams(planMode: PlanMode = 'recommended', over: Partial<PlanParams> = {}): PlanParams {
  return {
    tierRounds: planMode === 'recommended' ? { ...RECOMMENDED_TIER_ROUNDS } : { ...FALLBACK_TIER_ROUNDS },
    planMode,
    startDate: '2026-10-11',
    deadlineDate: DEFAULT_DEADLINE_DATE,
    sprintStartDate: DEFAULT_SPRINT_START_DATE,
    dailyBudgetMin: DEFAULT_DAILY_BUDGET_MIN,
    avgHitSec: DEFAULT_AVG_HIT_SEC,
    gapMinDays: 0, // 由调度器按 轮窗口 × GAP_MIN_WINDOW_FACTOR 计算，显式传值时覆盖
    modalRatio: { ...DEFAULT_MODAL_RATIO },
    masteryDecayEnabled: DEFAULT_MASTERY_DECAY_ENABLED,
    listSize: DEFAULT_LIST_SIZE,
    ...over,
  };
}

// ===== 稳固判定（PRD §4.4.4，驱动降频与冻结）=====

/** 秒认连续 ≥ 2 次 */
export const STEADY_MIN_INSTANT_COUNT = 2;
/** 且在听觉模态 hit 中被正确识别 ≥ 1 次 */
export const STEADY_MIN_AUDIO_RECOGNIZED = 1;

// ===== 欠账（PRD §4.4.4）=====

/** 阈值：|overdue| > 2 × dailyHits 强制重排 */
export const OVERDUE_THRESHOLD_MULTIPLIER = 2;
/** 连续 3 天未学且欠账 > 0 → 强制重排 */
export const OVERDUE_IDLE_DAYS_TRIGGER = 3;

// ===== 摸底分层 =====

/** 摸底抽样上限 */
export const PLACEMENT_MAX_WORDS = 300;
/** 前两周自动校准：批量变动 >10% 需用户确认 */
export const TIER_RECALIBRATION_CONFIRM_RATIO = 0.1;

// ===== 反馈交互 =====

export const MAX_L2_TAGS = 3;
export const NOTE_MAX_LENGTH = 60;
/** 听词联想：犹豫超 3 秒自动判"不会" */
export const AUDIO_RECALL_TIMEOUT_MS = 3000;
/** 见中文联想英文：默认每日 15 词，可关 */
export const CN_TO_EN_DAILY_WORDS = 15;

// ===== TTS =====

export const DEFAULT_TTS_PROVIDER: TTSProviderName = 'azure';
/** 硬约束 #7：云 TTS 供应商待用户确认前，配置状态默认 pending_user_setup */
export const DEFAULT_TTS_STATUS: TTSConfigStatus = 'pending_user_setup';
/** 主轨请求超时（3 秒）后回退 espeak 兜底轨 */
export const TTS_REQUEST_TIMEOUT_MS = 3000;
/** 音频缓存 LRU 预算（T05 实现，此处仅定常量） */
export const AUDIO_CACHE_BUDGET_BYTES = 50 * 1024 * 1024;

// ===== 同步 =====

/** 跨端可见轮询间隔（S30：会话结束 5 秒内跨端可见） */
export const CROSS_DEVICE_SYNC_POLL_MS = 5000;

// ===== 反自测禁用词表（硬约束 #1；前台组件与三类类型中禁止出现）=====

export const FORBIDDEN_SELF_TEST_TERMS = [
  'score',
  'accuracy',
  'rating',
  '正确率',
  '得分',
  '评级',
  '掌握度百分比',
  '连续天数',
  '徽章',
] as const;

/**
 * 前台禁用术语核对说明（code review 用）：
 * 1. src/types/domain.ts 的 Feedback / TrainingRecord / AbilitySnapshot 物理无 score/accuracy/rating 字段；
 * 2. 模考 diag_report 仅 DiagReportView（后台路由 /dashboard 下）渲染；
 * 3. 前台（Today/背单词/训练）组件树中不得出现上表任何词。
 */
