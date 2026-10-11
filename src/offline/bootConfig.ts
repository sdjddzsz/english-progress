/**
 * bootConfig.ts —— 启动运行时装配（T05，架构 §8 #2 唯一声明例外）：
 * publicConfig(.env) → 云数据库 tts_provider_configs 文档 → 密钥字段运行时注入内存。
 * 密钥不落 localStorage / 不入代码：读入后仅存于 useTTS 的模块级变量（刷新即失）。
 * 云未配置时返回 cloudReady=false，由 App 层渲染全站引导态。
 */
import { getSessionInfo, isCloudConfigured } from '../data/cloud';
import { getRepos, todayISO } from '../store/useAppStore';
import { setRuntimeTTSApiKey } from '../hooks/useTTS';
import { runDailyCalibration } from '../features/placement/calibration';

export interface BootResult {
  cloudReady: boolean;
  userId?: string;
  /** 密钥是否成功从云端配置文档加载（false 时不阻塞——espeak 兜底可用） */
  ttsKeyLoaded: boolean;
  /** 前两周每日校准是否产生了提案（>10% 批量变动 → Confirm 提案，进 AI 方案页） */
  calibrationProposal?: boolean;
  message?: string;
}

/**
 * 启动序列（useAppStore.bootstrap 成功拿到登录态后调用）：
 * 1) 读 TTSProviderConfig；2) 若 apiKeyRef 指向文档字段则取值注入；3) 触发前两周每日校准。
 * 任何一步失败都不阻塞学习（返回带 message 的降级结果）。
 */
export async function bootRuntime(): Promise<BootResult> {
  if (!isCloudConfigured()) {
    return { cloudReady: false, ttsKeyLoaded: false, message: 'cloud not configured (.env missing publicConfig)' };
  }
  try {
    const session = await getSessionInfo();
    const userId = session.userId ?? 'local-user';
    let ttsKeyLoaded = false;
    try {
      const cfg = await getRepos().config.getTTSConfig(userId);
      if (cfg) {
        // apiKeyRef 指向云配置文档中的密钥字段名（如 'runtimeApiKey'）；从同一文档读出后注入内存
        const refField = cfg.apiKeyRef;
        const doc = cfg as unknown as Record<string, unknown>;
        const key = refField && typeof doc[refField] === 'string' ? (doc[refField] as string) : undefined;
        if (key && key.trim()) {
          setRuntimeTTSApiKey(key);
          ttsKeyLoaded = true;
        }
      }
    } catch {
      // 密钥加载失败不阻塞（兜底轨可用）
    }

    // 前两周每日校准（批量变动 >10% → 动态风险路由为 Confirm 提案；≤10% 自动落地）
    let calibrationProposal: boolean | undefined;
    try {
      const { activePlan } = (await import('../store/useAppStore')).useAppStore.getState();
      if (activePlan) {
        const r = await runDailyCalibration({ userId, plan: activePlan, today: todayISO() });
        calibrationProposal = r.proposalCreated;
      }
    } catch {
      // 校准失败不阻塞启动
    }

    return { cloudReady: true, userId, ttsKeyLoaded, ...(calibrationProposal !== undefined ? { calibrationProposal } : {}) };
  } catch (e) {
    return { cloudReady: false, ttsKeyLoaded: false, message: e instanceof Error ? e.message : String(e) };
  }
}
