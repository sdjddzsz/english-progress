/**
 * useAppStore.ts —— 全局应用状态（zustand）：
 * 登录态 / 词书 / 生效计划 / 今日队列（expandDayForWords 真实词表路径）。
 * 边界：云 SDK 只在 src/data 内被触碰；调度编排（展开当日、校验）全部收敛在此，
 * 页面与组件只读 store / hooks，不含调度逻辑（架构文档边界铁律）。
 */
import { create } from 'zustand';
import type { Book, Hit, StudyPlan, Tier, Word } from '../types/domain';
import {
  expandDayForWords,
  planFinishDate,
  validatePlan,
  type PlanParams,
  type TierWordCounts,
  type ValidationResult,
  type WordSteadiness,
} from '../scheduler';
import { hitDeterministicId } from '../data/collections';
import { consumeWorkBuddyCallback, getSessionInfo, isCloudConfigured } from '../data/cloud';
import { createWordRepo, type WordRepo } from '../data/repos/wordRepo';
import { createPlanRepo, type PlanRepo } from '../data/repos/planRepo';
import { createHitRepo, type HitRepo } from '../data/repos/hitRepo';
import { createFeedbackRepo, type FeedbackRepo } from '../data/repos/feedbackRepo';
import { createConfigRepo, type ConfigRepo } from '../data/repos/configRepo';
import { createTrainingRepo, type TrainingRepo } from '../data/repos/trainingRepo';
import { createNoteRepo, type NoteRepo } from '../data/repos/noteRepo';
import { decideProposal } from '../ai/authz';
import type { ToolContext } from '../ai/tools/readTools';

// ===== 仓库与工具上下文（懒初始化，云未配置时由调用方捕获错误）=====

export interface Repos {
  word: WordRepo;
  plan: PlanRepo;
  hit: HitRepo;
  feedback: FeedbackRepo;
  config: ConfigRepo;
  training: TrainingRepo;
  note: NoteRepo;
}

let cachedRepos: Repos | null = null;

/** 全局仓库单例（首次调用时初始化；云未配置会抛错，由 action 捕获后写入 error） */
export function getRepos(): Repos {
  if (!cachedRepos) {
    cachedRepos = {
      word: createWordRepo(),
      plan: createPlanRepo(),
      hit: createHitRepo(),
      feedback: createFeedbackRepo(),
      config: createConfigRepo(),
      training: createTrainingRepo(),
      note: createNoteRepo(),
    };
  }
  return cachedRepos;
}

/** 页面/AI 建议共用的工具上下文（actor 由调用方决定） */
export function getToolCtx(userId: string, planId?: string): ToolContext {
  return { userId, repos: getRepos(), actor: 'user', ...(planId ? { planId } : {}) };
}

// ===== 通用工具 =====

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** StudyPlan + 词书 List 大小 → 调度 PlanParams（与 ai/tools/readTools.planToParams 同构） */
function planToParams(plan: StudyPlan, listSize: number): PlanParams {
  return {
    tierRounds: plan.tierRounds,
    planMode: plan.planMode,
    startDate: plan.startDate,
    deadlineDate: plan.deadlineDate,
    sprintStartDate: plan.sprintStartDate,
    dailyBudgetMin: plan.dailyBudgetMin,
    avgHitSec: plan.avgHitSec,
    gapMinDays: plan.gapMinDays,
    modalRatio: plan.modalRatio,
    masteryDecayEnabled: plan.masteryDecayEnabled,
    tierRoundDays: plan.tierRoundDays as PlanParams['tierRoundDays'],
    listSize,
  };
}

// ===== 状态 =====


export interface AppState {
  userId: string | null;
  cloudReady: boolean;
  loading: boolean;
  error: string | null;
  /** 云已配置但未登录 → 渲染登录页（数据读写前必须有真实登录态） */
  needsLogin: boolean;

  books: Book[];
  activeBookId: string | null;
  activePlan: StudyPlan | null;
  planValidation: ValidationResult | null;
  planFinish: string | null;

  todayHits: Hit[];
  todayPendingCount: number;
  /** 今日队列词卡数据（wordId → Word） */
  wordMap: Record<string, Word>;


  /**
   * 是否已完成一次「首次」bootstrap（未配置云 / 未登录 / 成功 三个正常终止分支都置 true）。
   * 用途：AuthGate 只在首次启动显示整屏 spinner；路由切换时页面内重复调用的 bootstrap
   * 会被本标记短路，避免「loading → children 整棵卸载 → 重挂 → 再 bootstrap」的死循环。
   */
  bootstrapped: boolean;

  /**
   * 启动装配：OAuth 落地兑换 → 登录态判断 → 词书装载 → 运行时（TTS 密钥 / 每日校准）。
   * @param opts.force 显式重试（如设置页「重新检测」）；缺省时首次完成后不再重复执行。
   */
  bootstrap(opts?: { force?: boolean }): Promise<void>;
  setActiveBook(bookId: string): Promise<void>;
  refreshToday(today?: string): Promise<void>;
  completeHit(hitId: string): Promise<void>;
  /** AI 方案页：对提案批准/驳回 */
  decideProposalAction(proposalId: string, approve: boolean): Promise<{ ok: boolean; message: string }>;
}

export const useAppStore = create<AppState>()((set, get) => ({
  userId: null,
  cloudReady: false,
  loading: false,
  needsLogin: false,
  error: null,
  bootstrapped: false,

  books: [],
  activeBookId: null,
  activePlan: null,
  planValidation: null,
  planFinish: null,

  todayHits: [],
  todayPendingCount: 0,
  wordMap: {},


  bootstrap: async (opts) => {
    if (get().loading) return;
    // 首次已完成且未显式要求重试 → 直接短路。
    // ⚠ 关键：页面组件 mount 时都会调 bootstrap()（App 顶层已跑过一次），
    //   若这里继续 set({loading:true})，AuthGate 的整屏 spinner 会把刚挂载的
    //   路由页连底部导航一起卸载，重挂后又触发本函数 → 无限卸载/重挂死循环。
    if (get().bootstrapped && !opts?.force) return;
    set({ loading: true, error: null });
    try {
      if (!isCloudConfigured()) {
        // 中文注释：云服务未配置（.env 缺 publicConfig），渲染引导态而非静默降级。
        set({
          cloudReady: false,
          loading: false,
          bootstrapped: true,
          error:
            'WorkBuddy cloud is not configured. Fill in VITE_CLOUD_ENDPOINT / VITE_CLOUD_PUBLISHABLE_KEY in .env, then rebuild.',
        });
        return;
      }
      // OAuth 落地兑换必须跑在登录守卫之前：先换会话，再判断登录态
      await consumeWorkBuddyCallback();
      const session = await getSessionInfo();
      if (!session.signedIn || !session.userId) {
        // ⚠ 未登录时绝不再用伪造的本地假身份往下走：
        //   SDK 以 anon role 发请求，所有 owner-only 写操作都会被 RLS 挡下
        //   （表现：词书初始化报 42501 new row violates row-level security policy）。
        set({ cloudReady: true, userId: null, needsLogin: true, loading: false, bootstrapped: true, books: [] });
        return;
      }
      const userId = session.userId;
      // 防御：查询异常返回 null（而非 []）时不让 null 落进 store，否则下游 .length 直接崩
      const books = (await getRepos().word.listBooks(userId)) ?? [];
      set({ cloudReady: true, userId, needsLogin: false, books, loading: false, bootstrapped: true });
      const preferred = books.find((b) => b.status === 'active') ?? books[0];
      if (preferred) await get().setActiveBook(preferred.id);
      // T05 boot 链路：TTS 密钥云端文档 → 会话内存注入；前两周每日校准（>10% → Confirm 提案）
      const { bootRuntime } = await import('../offline/bootConfig');
      const boot = await bootRuntime();
      if (!boot.cloudReady && boot.message) {
        set({ error: boot.message });
      }
    } catch (e) {
      set({ loading: false, error: errMsg(e) });
    }
  },

  setActiveBook: async (bookId) => {
    set({ activeBookId: bookId, activePlan: null, planValidation: null, planFinish: null, todayHits: [], todayPendingCount: 0, wordMap: {} });
    const { userId } = get();
    if (!userId) return;
    try {
      const plan = await getRepos().plan.getActivePlan(bookId);
      set({ activePlan: plan });
      await get().refreshToday();
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

  /**
   * 今日队列刷新（真实词表路径，批 2 验收点）：
   * bookWords(list/order 排序) → wordsByTier → expandDayForWords → 确定性 ID 增量 upsert → 当日镜像。
   * 已存在（done/deferred/overdue）的 hit 不被覆盖（先查 existing 再补齐缺口）。
   */
  refreshToday: async (today = todayISO()) => {
    const { userId, activePlan } = get();
    if (!userId || !activePlan) return;
    try {
      const repos = getRepos();
      const book = await repos.word.getBook(activePlan.bookId);
      const bws = await repos.word.listBookWords(activePlan.bookId);
      const sorted = [...bws].sort((a, b) => a.listNo - b.listNo || a.orderInList - b.orderInList);
      const wordsByTier: Record<Tier, string[]> = { 1: [], 2: [], 3: [], 4: [] };
      const tierCounts: TierWordCounts = {};
      for (const bw of sorted) {
        wordsByTier[bw.tier].push(bw.wordId);
        tierCounts[bw.tier] = (tierCounts[bw.tier] ?? 0) + 1;
      }

      // 稳固信号：近 30 天反馈聚合（驱动降频与冻结预览）
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const recent = await repos.feedback.listFeedbacksRange(since, new Date().toISOString());
      const steadyWords: WordSteadiness[] = repos.feedback.aggregateSteadiness(recent);

      const params = planToParams(activePlan, book?.listSize ?? 50);
      const entries = expandDayForWords(params, wordsByTier, today, steadyWords);

      // 增量补齐：确定性 ID 已存在的不重写（保护 done/deferred 状态）
      const existing = await repos.hit.getHitsByDate(activePlan.id, today);
      const existingIds = new Set(existing.map((h) => h.id));
      const fresh: Hit[] = entries
        .filter((e) => !existingIds.has(hitDeterministicId(activePlan.id, e.wordId, e.roundNo, today)))
        .map((e) => ({
          id: hitDeterministicId(activePlan.id, e.wordId, e.roundNo, today),
          planId: activePlan.id,
          wordId: e.wordId,
          userId,
          tier: e.tier,
          roundNo: e.roundNo,
          listNo: e.listNo,
          scheduledDate: today,
          modality: e.modality,
          status: 'pending',
          explain: e.explain,
        }));
      if (fresh.length > 0) await repos.hit.upsertHits(fresh);

      const todayHits = await repos.hit.getHitsByDate(activePlan.id, today);
      await repos.hit.mirrorToday(todayHits);

      const validation = validatePlan({ params, tierCounts, steadyWords });
      const finish = planFinishDate(params, tierCounts);
      // 今日词卡数据
      const wordIds = [...new Set(entries.map((e) => e.wordId))];
      const words = await repos.word.listWordsByIds(wordIds);
      const wordMap: Record<string, Word> = {};
      for (const w of words) wordMap[w.id] = w;

      set({
        todayHits,
        todayPendingCount: todayHits.filter((h) => h.status === 'pending').length,
        wordMap,
        planValidation: validation,
        planFinish: finish,
        error: null,
      });
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

  completeHit: async (hitId) => {
    const repos = getRepos();
    const completedAt = new Date().toISOString();
    await repos.hit.completeHit(hitId, completedAt);
    set((s) => {
      const todayHits = s.todayHits.map((h) =>
        h.id === hitId ? { ...h, status: 'done' as const, completedAt } : h,
      );
      return { todayHits, todayPendingCount: todayHits.filter((h) => h.status === 'pending').length };
    });
  },


  decideProposalAction: async (proposalId, approve) => {
    const { userId, activePlan } = get();
    if (!userId || !activePlan) return { ok: false, message: 'no active plan' };
    try {
      const ctx = getToolCtx(userId, activePlan.id);
      const decision = await decideProposal({ ctx }, proposalId, approve);
      await get().refreshToday();
      if (decision.kind === 'rejected') return { ok: false, message: decision.reason };
      return { ok: true, message: decision.kind === 'auto' ? 'applied' : decision.kind };
    } catch (e) {
      return { ok: false, message: errMsg(e) };
    }
  },
}));
