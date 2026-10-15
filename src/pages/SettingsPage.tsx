/**
 * SettingsPage.tsx —— 设置页（PRD §5.2.5）：
 * 云配置状态 / 学习偏好（设备、见中文联想英文）/ AI 通道（连通性检查）/ TTS。
 *
 * TTS 真源是云端 tts_provider_configs 文档（编排器 useTTS.getConfig 从那里读），
 * 本地 settings store 只是回填用的影子副本——所以保存必须写云端，否则主轨不生效。
 * 密钥默认只写会话内存（hooks/useTTS.setRuntimeTTSApiKey，刷新即失）；
 * 勾选"跨刷新保留"时才随 apiKeyRef 机制落库（RLS owner-only，架构 §8 #2 唯一例外）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  LinearProgress,
  MenuItem,
  Paper,
  Slider,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import type { TTSProviderConfig, TTSProviderName } from '../types/domain';
import type { LLMChannel } from '../ai/llmClient';
import { listModels, type LLMModelInfo } from '../ai/llmClient';
import RefreshIcon from '@mui/icons-material/Refresh';
import { isCloudConfigured } from '../data/cloud';
import { getRepos, useAppStore } from '../store/useAppStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { peekRuntimeTTSApiKey, setRuntimeTTSApiKey, useTTS } from '../hooks/useTTS';
import {
  DASHSCOPE_DEFAULT_ENDPOINT,
  DASHSCOPE_DEFAULT_MODEL,
  DASHSCOPE_DEFAULT_VOICE,
  DASHSCOPE_FREE_QUOTA_CHARS,
  DASHSCOPE_MODEL_OPTIONS,
  DASHSCOPE_PRICE_PER_10K_CHARS,
  DASHSCOPE_VOICE_OPTIONS_BY_MODEL,
} from '../config/constants';
import { cacheHitRate, readUsageStats, resetUsageStats, type UsageStats } from '../tts/usageStats';
import { backfillArpabetFromSeed, type BackfillProgress } from '../data/backfillArpabet';

/** 模型下拉里「自定义…」这一项的哨兵值 —— 不是真实模型 id，仅用于触发手填兜底 */
const CUSTOM_MODEL = '__custom__';

export default function SettingsPage() {
  const bootstrap = useAppStore((s) => s.bootstrap);
  const settings = useSettingsStore();
  const { speak, loading: ttsLoading, phaseLabel: ttsPhaseLabel } = useTTS();

  const [ttsConfig, setTtsConfig] = useState<TTSProviderConfig | null>(null);
  const [apiKey, setApiKey] = useState(peekRuntimeTTSApiKey());
  const [voice, setVoice] = useState(settings.ttsVoice);
  const [ttsModel, setTtsModel] = useState(settings.ttsModel || DASHSCOPE_DEFAULT_MODEL);
  const [endpoint, setEndpoint] = useState('');
  /** 密钥是否落库（跨刷新保留）。默认关：只存会话内存 */
  const [persistKey, setPersistKey] = useState(false);
  const [ttsMsg, setTtsMsg] = useState('');
  const [ttsErr, setTtsErr] = useState('');
  const [savingTTS, setSavingTTS] = useState(false);
  /** P1-1 本地用量（成本卡数据源；仅主轨计费） */
  const [usage, setUsage] = useState<UsageStats>(() => readUsageStats());
  // 云端实测聚合（用户 2026-10-14 第 2 条）：官网控制台没有公开用量 API（需阿里云登录态），
  // 但 pronunciation_logs 每次主轨合成都有记录（含 DashScope usage.characters 精确字符数），
  // 聚合它 = 跨设备一致的真实用量。
  const [cloudUsage, setCloudUsage] = useState<{ requests: number; chars: number } | null>(null);
  /** T8 存量回填（升级发音真源） */
  const [bfRunning, setBfRunning] = useState(false);
  const [bfProgress, setBfProgress] = useState<BackfillProgress | null>(null);
  const [bfMsg, setBfMsg] = useState('');
  const [bfErr, setBfErr] = useState('');
  const [baseUrl, setBaseUrl] = useState(settings.aiBaseUrl);
  const [model, setModel] = useState(settings.aiModel);
  const [channel, setChannel] = useState<LLMChannel>(settings.aiChannel);
  /** 模型下拉的选项来源（listModels 实时拉取）；拉不到时才退到「自定义」手填 */
  const [modelOptions, setModelOptions] = useState<LLMModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsErr, setModelsErr] = useState('');
  /** 选中「自定义…」时为 true（也用于回显"已存模型不在列表里"的情况） */
  const [customOpen, setCustomOpen] = useState(false);
  const [probeMsg, setProbeMsg] = useState('');
  const [probeErr, setProbeErr] = useState('');

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const userId = useAppStore.getState().userId;
    if (!userId) return;
    void (async () => {
      try {
        const cfg = await getRepos().config.getTTSConfig(userId);
        setTtsConfig(cfg);
        if (cfg) {
          // 云端是真源：回填 endpoint / voice / model / 密钥持久化开关
          if (cfg.endpoint) setEndpoint(cfg.endpoint);
          // ★ 无条件覆盖（原来是 `if (cfg.voice && !voice)`，2026-10-14 修）：
          // localStorage 里可能躺着历史脏 ttsVoice（实测曾把用户邮箱存进去），
          // 旧写法在脏值非空时不覆盖 ⇒ 脏值跟着每次保存反复写回云端。
          if (cfg.voice) setVoice(cfg.voice);
          if (cfg.model) setTtsModel(cfg.model);
          setPersistKey(Boolean(cfg.runtimeApiKey));
          // ★ 跨刷新保留的密钥回填进输入框（2026-10-14 修「每次试音都要重填 API」）：
          // 勾了「跨刷新保留」且云端有 runtimeApiKey 时，刷新后输入框不再空白；
          // 否则静默保存/试听都会拿空 key 把云端已有 key 覆盖掉（实测发生）。
          if (cfg.runtimeApiKey) {
            setApiKey(cfg.runtimeApiKey);
            setRuntimeTTSApiKey(cfg.runtimeApiKey); // 会话内存同步注入，主轨立即可用
          }
        }
      } catch {
        setTtsConfig(null);
      }
    })();
    // P1-1：进入设置页刷新一次本地用量
    setUsage(readUsageStats());
    // 云端实测聚合：本月主轨成功合成（跨设备真实数据）
    void (async () => {
      try {
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const logs = await getRepos().feedback.pronunciationLogs.listAll(
          [
            { column: 'engine', op: 'eq', value: 'neural_tts' },
            { column: 'success', op: 'eq', value: true },
            { column: 'createdAt', op: 'gte', value: monthStart.toISOString() },
          ],
          { orderBy: 'createdAt', ascending: false },
        );
        setCloudUsage({
          requests: logs.length,
          chars: logs.reduce((s, l) => s + (l.chars ?? 0), 0),
        });
      } catch {
        setCloudUsage(null); // 拉不到就不显示，不挡设置页
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const STATUS_LABEL: Record<string, string> = {
    pending_user_setup: '待配置（默认 · espeak 兜底已可用）',
    active: '已启用',
    error: '异常',
  };

  // 当前 provider（下拉真源：settings store 影子副本）
  const provider = settings.ttsProvider;
  const isDashscope = provider === 'dashscope';
  const isAzure = provider === 'azure';

  /** 切换 provider：把 provider / voice / model 同步进影子副本（model 为空时补默认） */
  const handleProviderChange = (next: TTSProviderName) => {
    settings.setTTS(next, voice, ttsModel || DASHSCOPE_DEFAULT_MODEL);
  };

  // 音色按模型联动（官方音色不能跨模型混用）：当前模型的可用音色列表
  const dashscopeVoiceOptions = DASHSCOPE_VOICE_OPTIONS_BY_MODEL[ttsModel] ?? [];
  // 当前选择必须属于当前模型列表，否则回落到列表第一项（再退 DASHSCOPE_DEFAULT_VOICE）
  const effectiveVoice = dashscopeVoiceOptions.some((o) => o.voice === voice)
    ? voice
    : dashscopeVoiceOptions[0]?.voice ?? DASHSCOPE_DEFAULT_VOICE;

  /** 切换模型：音色不在新模型列表时联动到新列表第一项 */
  const handleModelChange = (nextModel: string) => {
    setTtsModel(nextModel);
    const opts = DASHSCOPE_VOICE_OPTIONS_BY_MODEL[nextModel] ?? [];
    if (!opts.some((o) => o.voice === voice)) setVoice(opts[0]?.voice ?? DASHSCOPE_DEFAULT_VOICE);
  };

  /** endpoint 占位/帮助文案随 provider 切换 */
  const endpointPlaceholder = isDashscope
    ? DASHSCOPE_DEFAULT_ENDPOINT
    : isAzure
      ? 'https://<区域>.tts.speech.microsoft.com/cognitiveservices/v1'
      : 'https://<host>/v1';
  const endpointHelper = isDashscope
    ? '填通用端点即可（只差 API Key）。也可改填百炼控制台的 Workspace 专属域名 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer（官方称更稳）。'
    : isAzure
      ? 'Azure：需 VISA/Master 身份验证，国内用户不推荐。把 <区域> 换成资源所在区域（如 eastasia）。缺 endpoint 一律走兜底。'
      : 'OpenAI 兼容端点根地址（形如 https://host/v1）；该通道无 SSML 音素能力，音标驱动天然降级为文本合成。';

  const handleProbe = async () => {
    setProbeMsg('');
    setProbeErr('');
    try {
      const models = await listModels({ channel, ...(baseUrl ? { baseUrl } : {}) });
      setModelOptions(models);
      setProbeMsg(`连接正常，可用模型 ${models.length} 个${models[0] ? `（如 ${models[0].id}）` : ''}。`);
    } catch (e) {
      setProbeErr(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * 拉取模型列表（模型下拉的选项来源，用户 2026-10-14 要求改为下拉选择）。
   * workbuddy 通道走云端 models.list；openai_compatible 走 `${baseUrl}/models`。
   * 失败不阻塞：保留「自定义…」手填兜底，且把原因显示出来。
   */
  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsErr('');
    try {
      const models = await listModels({ channel, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) });
      setModelOptions(models);
      if (models.length === 0) setModelsErr('端点返回了空的模型列表');
    } catch (e) {
      setModelsErr(e instanceof Error ? e.message : String(e));
      setModelOptions([]);
    } finally {
      setModelsLoading(false);
    }
  }, [channel, baseUrl]);

  // 进页面 / 换通道 / 改 Base URL 后自动拉一次（400ms 防抖，避免输 URL 时连发请求）
  useEffect(() => {
    const t = setTimeout(() => {
      void loadModels();
    }, 400);
    return () => clearTimeout(t);
  }, [loadModels]);

  const handleSaveAI = () => {
    settings.setAI(channel, baseUrl.trim(), model.trim());
    setProbeMsg('AI 通道偏好已保存。');
  };

  /**
   * TTS 保存：本地 store 只是影子副本，编排器读的是云端 tts_provider_configs，
   * 所以这里必须把 provider/endpoint/voice 写回云端，否则主轨永远不生效（只会走 espeak 兜底）。
   */
  const handleSaveTTS = async () => {
    setTtsMsg('');
    setTtsErr('');
    // provider 默认值（dashscope 可留空，用 constants 里的通用端点/音色/模型）
    const ep = endpoint.trim() || (isDashscope ? DASHSCOPE_DEFAULT_ENDPOINT : '');
    // ★ 用 effectiveVoice 而不是 voice state（2026-10-14 修复）：
    // 下拉显示的是 effectiveVoice（已按模型校正/回落），但保存若用 voice state，
    // 遇到 localStorage 里的历史脏值（实测曾存进用户邮箱）就会"界面正常、存进去是脏值"，
    // 主轨拿着非法音色名请求 → 400 → 试听失败。
    const v = effectiveVoice.trim() || (isDashscope ? DASHSCOPE_DEFAULT_VOICE : '');
    const m = ttsModel.trim() || (isDashscope ? DASHSCOPE_DEFAULT_MODEL : '');
    settings.setTTS(provider, v, m);
    // 输入框空但勾着「跨刷新保留」时不清会话内存密钥（防静默保存毁掉可用 key）
    if (apiKey || !persistKey) setRuntimeTTSApiKey(apiKey);

    const userId = useAppStore.getState().userId;
    if (!userId) {
      setTtsErr('未登录：这次只写进了会话内存，刷新即失。登录后请再保存一次。');
      return;
    }
    setSavingTTS(true);
    try {
      const repos = getRepos();
      const cfg = (await repos.config.getTTSConfig(userId)) ?? (await repos.config.initDefaultTTSConfig(userId));
      const key = apiKey.trim();
      const ready = Boolean(ep && v && (key || cfg.runtimeApiKey));
      const patch: Partial<TTSProviderConfig> = {
        provider,
        endpoint: ep || undefined,
        voice: v || undefined,
        model: m || undefined,
        ssmlPhonemeEnabled: true,
        status: ready ? 'active' : 'pending_user_setup',
      };
      if (persistKey && key) {
        patch.apiKeyRef = 'runtimeApiKey';
        patch.runtimeApiKey = key;
      } else if (persistKey && !key && cfg.runtimeApiKey) {
        // ★ 输入框空但勾着「跨刷新保留」且云端已有 key：保留云端 key 不覆盖。
        // （2026-10-14 修：试听前静默保存曾拿空 key 把云端 key 清掉 → 主轨失效，
        //  用户每次刷新后都得重填一遍 API——不合理。想真正删 key：取消勾选再保存。）
        patch.apiKeyRef = 'runtimeApiKey';
      } else {
        // 空串即清空（undefined 会被 JSON 序列化丢掉，等于不改）
        patch.apiKeyRef = '';
        patch.runtimeApiKey = '';
      }
      const updated = await repos.config.updateTTSConfig(cfg.id, patch);
      if (!updated) {
        setTtsErr('云端配置未更新（0 行受影响，通常是 RLS 拦截）。请确认已登录后再试。');
        return;
      }
      setTtsConfig(updated);
      setTtsMsg(
        ready
          ? '已写入云端：主轨配置生效。点「试听」确认是否真的走了神经语音。'
          : '已写入云端，但 endpoint / 发音人 / 密钥未填全，仍会走 espeak 兜底。',
      );
    } catch (e) {
      setTtsErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingTTS(false);
    }
  };

  /** 试听即探针：命中 neural_tts = 主轨通；命中 ipa_espeak = 主轨没通，回落到机械音 */
  const handleTryListen = async () => {
    setTtsMsg('');
    setTtsErr('');
    // ★ 先静默保存页面当前配置（用户 2026-10-14 第 1 条：试听不需先保存+刷新）：
    // 编排器按云端配置合成（缓存 key 含音色），试听前把下拉里选的音色直接写云端，
    // 试听即用新音色新 key 重新合成——换音色立即出声。
    await handleSaveTTS();
    // 探针带 arpabet（dashscope → <phoneme alphabet="cmu"> 零转换；azure 忽略该字段、回退 ipa）
    const engine = await speak({ text: 'progress', ipa: 'ˈprɒɡres', arpabet: 'P R AA1 G R EH2 S', mode: 'word' });
    setUsage(readUsageStats()); // P1-1：试听会写用量，刷新成本卡
    if (engine === 'neural_tts') {
      setTtsMsg('主轨（神经语音）发音成功。');
    } else if (engine === 'ipa_espeak') {
      // 先分清「密钥根本不在会话里」与「密钥在但主轨请求失败」——这两者现象一样（机械音）、
      // 修法完全不同。原先只列了 CORS/Key/端点三条，把最常见的「刷新后密钥丢了」漏掉了，
      // 用户会以为是音质变差（2026-10-14 实际发生）。
      const hasKey = Boolean(peekRuntimeTTSApiKey());
      setTtsErr(
        hasKey
          ? '走的是 espeak 兜底（机械音）——密钥在会话里，但主轨请求没通。常见原因：' +
            '① 浏览器 CORS/预检不放行（控制台报 Failed to fetch，DashScope 会自动改走 WebSocket 直连，' +
            '若仍落到兜底说明 WS 也不通）；② Key 无效或未开通百炼；③ 端点与密钥所在资源不匹配。' +
            '请对照控制台报错逐项排查。'
          : '走的是 espeak 兜底（机械音）——原因是**会话里没有 API Key**：密钥默认只存内存、刷新即失，' +
            '所以昨天试听是自然音、今天刷新后就变成机械音。' +
            '勾选上方「跨刷新保留」再点一次保存，以后刷新会自动从云端取回密钥，主轨（神经语音）就一直是自然音。',
      );
    } else if (engine === 'web_speech') {
      setTtsMsg(
        '走的是浏览器内置语音（最后一道兜底）：主轨没通、离线 WASM 合成也没成功。' +
          '出声是有保证的，但音色由系统决定。想要神经语音请检查上方主轨配置。',
      );
    } else {
      setTtsErr('发音失败：主轨、离线合成、浏览器内置语音都没出声。请打开浏览器控制台查看 [tts] 报错。');
    }
    const userId = useAppStore.getState().userId;
    const id = ttsConfig?.id;
    if (userId && id) {
      try {
        const updated = await getRepos().config.updateTTSConfig(id, {
          lastTestAt: new Date().toISOString(),
          // ★ 只在成功时置 active；失败**绝不动 status**（2026-10-14 线上死锁的修复）——
          // orchestrator 要求 status==='active' 才发主轨请求，所以一旦把 status 置成 'error'，
          // 主轨就被永久跳过：之后再点试听仍是 espeak、请求根本没发出去，用户再无自愈手段
          // （现象就是"昨天试听是自然音，今天怎么点都是机械音"）。
          // 配置真有问题时，红框提示 + 用户重新保存（ready 时重置为 active）就够了。
          status: engine === 'neural_tts' ? 'active' : ttsConfig?.status ?? 'pending_user_setup',
        });
        if (updated) setTtsConfig(updated);
      } catch {
        // 探针回写失败不影响学习
      }
    }
  };

  /**
   * T8 存量回填「升级发音真源」：把云端已入库 words 行按 lemma 换成 CMUdict 派生 ipa + arpabet。
   * 幂等可重跑；未命中词保留原 ipa。进度可见（done/total），失败原样重跑。
   */
  const handleBackfill = async () => {
    setBfMsg('');
    setBfErr('');
    setBfRunning(true);
    setBfProgress({ done: 0, total: 0, updated: 0, skipped: 0 });
    try {
      const res = await backfillArpabetFromSeed({
        onProgress: (p) => {
          // 节流：每 50 词或首末次更新一次，避免高频重渲染
          if (p.done === 0 || p.done === p.total || p.done % 50 === 0) setBfProgress(p);
        },
      });
      setBfProgress({ done: res.total, total: res.total, updated: res.updated, skipped: res.skipped });
      setBfMsg(`回填完成：更新 ${res.updated} 词，跳过（CMUdict 未命中）${res.skipped} 词。可重复点击，结果幂等。`);
      if (res.errors.length > 0) {
        setBfErr(`部分写入失败（可原样重跑）：${res.errors.join(' | ')}`);
      }
    } catch (e) {
      setBfErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBfRunning(false);
    }
  };

  return (
    <Box p={2} pb={4}>
      <Typography variant="h5">设置</Typography>

      {/* 云配置状态 */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h6">云服务</Typography>
          <Chip size="small" color={isCloudConfigured() ? 'success' : 'warning'} label={isCloudConfigured() ? '已配置' : '未配置'} />
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {isCloudConfigured()
            ? '数据与 LLM 走 WorkBuddy 云（免密钥通道）。'
            : '缺 VITE_CLOUD_ENDPOINT / VITE_CLOUD_PUBLISHABLE_KEY——按 .env.example 填入云服务 publicConfig 后重新构建。'}
        </Typography>
      </Paper>

      {/* 学习偏好 */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Typography variant="h6" gutterBottom>
          学习偏好
        </Typography>
        <Stack spacing={2}>
          <TextField
            select
            label="设备形态（写入反馈记录）"
            value={settings.device}
            onChange={(e) => settings.setDevice(e.target.value as typeof settings.device)}
            size="small"
          >
            <MenuItem value="desktop">桌面</MenuItem>
            <MenuItem value="mobile">移动</MenuItem>
          </TextField>

          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Box>
              <Typography variant="body2">自动发音</Typography>
              <Typography variant="caption" color="text.secondary">
                进入/揭晓当前词时自动朗读一次（考查出题、背词、拼写都算）。列表页不自动朗读。
              </Typography>
            </Box>
            <Switch
              checked={settings.autoSpeak}
              onChange={(e) => settings.setAutoSpeak(e.target.checked)}
            />
          </Stack>

          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Box>
              <Typography variant="body2">答题音效</Typography>
              <Typography variant="caption" color="text.secondary">
                考查与拼写里答对/答错时播放提示音（本地合成，不联网、不占流量）。
                熟练/认识=对音，不熟/生词=错音。其它环节是自评式，没有客观对错，因此不播。
              </Typography>
            </Box>
            <Switch
              checked={settings.sfxEnabled}
              onChange={(e) => settings.setSfxEnabled(e.target.checked)}
            />
          </Stack>

          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Box>
              <Typography variant="body2">自动进入下一题（考查）</Typography>
              <Typography variant="caption" color="text.secondary">
                开=答完约 1 秒自动进下一题；关（默认）=答完停在原地，显示判定与正确答案，
                自己点「下一题」再走。
              </Typography>
            </Box>
            <Switch
              checked={settings.quizAutoNext}
              onChange={(e) => settings.setQuizAutoNext(e.target.checked)}
            />
          </Stack>

          <Box>
            <Typography variant="body2" gutterBottom>当天过关档位（考查）</Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={settings.quizDayThreshold}
              onChange={(_, v) => {
                if (v) settings.setQuizDayThreshold(v);
              }}
            >
              <ToggleButton value="lenient">宽松</ToggleButton>
              <ToggleButton value="standard">适当</ToggleButton>
              <ToggleButton value="strict">严格</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary" display="block">
              当天计划里，同一个词连续 3 次达到档位线才过关、当天不再出现：
              宽松=至少「不熟」、适当=至少「认识」、严格=至少「熟练」。
              一次没到线计数清零。总计划（明天起的考查频率）只看当天第一次判定的熟悉度。
            </Typography>
          </Box>

          <Box>
            <Typography variant="body2" gutterBottom>
              每轮考查词量：{settings.quizDailyLimit} 词
            </Typography>
            <Slider
              min={50}
              max={1000}
              step={50}
              value={settings.quizDailyLimit}
              onChange={(_, v) => settings.setQuizDailyLimit(v as number)}
              marks
              valueLabelDisplay="auto"
            />
            <Typography variant="caption" color="text.secondary" display="block">
              每天最多新铺多少词进考查（默认 300）。答错的词当天重排直到答对，不占这个额度；
              特种训练词每天必考，也不受此限。词量越大铺得越快，单日耗时也越长。
            </Typography>
          </Box>

          <Box>
            <Typography variant="body2" gutterBottom>
              阶段毕业条件（连续熟练次数，用户 2026-10-15 四阶段制）
            </Typography>
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
              {([1, 2, 3] as const).map((n) => (
                <TextField
                  key={n}
                  select
                  size="small"
                  label={`阶段${['一', '二', '三'][n - 1]}`}
                  value={settings.stageGraduate[n]}
                  onChange={(e) => settings.setStageGraduate(n, Number(e.target.value))}
                  sx={{ minWidth: 110 }}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c) => (
                    <MenuItem key={c} value={c}>
                      连续熟练 {c} 次
                    </MenuItem>
                  ))}
                </TextField>
              ))}
            </Stack>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
              阶段一由词选义 / 阶段二由义选词 / 阶段三听音选词：连续熟练达标即晋级下一阶段（默认各 3 次）。
              阶段四听词拼写：写对一次即彻底毕业，不可改。
            </Typography>
          </Box>

          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2">见中文联想英文（每日一小段）</Typography>
            <Switch
              checked={settings.cnToEnEnabled}
              onChange={(e) => settings.setCnToEn(e.target.checked)}
            />
          </Stack>

          {settings.cnToEnEnabled && (
            <Box>
              <Typography variant="body2">每日词数：{settings.cnToEnDailyWords}</Typography>
              <Slider
                min={5}
                max={30}
                step={5}
                value={settings.cnToEnDailyWords}
                onChange={(_, v) => settings.setCnToEn(true, v as number)}
                marks
                valueLabelDisplay="auto"
              />
            </Box>
          )}
        </Stack>
      </Paper>

      {/* AI 通道 */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Typography variant="h6" gutterBottom>
          AI 通道
        </Typography>
        <Stack spacing={2}>
          <TextField
            select
            label="通道"
            value={channel}
            onChange={(e) => setChannel(e.target.value as LLMChannel)}
            size="small"
          >
            <MenuItem value="workbuddy">WorkBuddy 免密钥（推荐）</MenuItem>
            <MenuItem value="openai_compatible">OpenAI 兼容端点（自备）</MenuItem>
          </TextField>

          {channel === 'openai_compatible' && (
            <TextField
              label="Base URL（形如 https://host/v1）"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              size="small"
              helperText="改完会自动重新拉取模型列表"
            />
          )}

          {/* 模型：下拉选择（用户 2026-10-14 要求改为下拉，不要手填）。
              选项由 listModels 实时拉取；列表拉不到、或已存模型不在列表里时，
              才退到「自定义…」手填 —— 兜底不能没有，否则端点异常时就无法配置了。 */}
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField
              select
              label="模型"
              value={modelOptions.some((o) => o.id === model) ? model : model ? CUSTOM_MODEL : ''}
              onChange={(e) => {
                const v = e.target.value;
                if (v === CUSTOM_MODEL) {
                  setCustomOpen(true);
                  if (!model) setModel('');
                } else {
                  setCustomOpen(false);
                  setModel(v);
                }
              }}
              size="small"
              sx={{ flex: 1, minWidth: 260 }}
              // 未选值时 label「模型」与 displayEmpty 的占位「选择模型」会同位重叠（用户 2026-10-15 截图），
              // 让 label 恒浮到边框线上即可分开。
              InputLabelProps={{ shrink: true }}
              disabled={modelsLoading && modelOptions.length === 0}
              helperText={
                modelsErr
                  ? `模型列表拉取失败：${modelsErr}（可选手动填）`
                  : modelOptions.length > 0
                    ? `共 ${modelOptions.length} 个可用模型`
                    : modelsLoading
                      ? '正在拉取模型列表…'
                      : ''
              }
              SelectProps={{
                displayEmpty: true,
                startAdornment: modelsLoading ? <CircularProgress size={14} sx={{ mr: 1 }} /> : undefined,
              }}
            >
              <MenuItem value="" disabled>
                选择模型
              </MenuItem>
              {modelOptions.map((m) => (
                <MenuItem key={m.id} value={m.id} disabled={m.disabled}>
                  {m.name ? `${m.name}（${m.id}）` : m.id}
                </MenuItem>
              ))}
              <MenuItem value={CUSTOM_MODEL}>自定义…</MenuItem>
            </TextField>
            <IconButton onClick={() => void loadModels()} size="small" title="重新拉取模型列表" disabled={modelsLoading}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Stack>
          {(customOpen || (model !== '' && modelOptions.length > 0 && !modelOptions.some((o) => o.id === model))) && (
            <TextField
              label="自定义模型名"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              size="small"
              helperText="端点上真实存在的模型 id"
            />
          )}

          {probeMsg && <Alert severity="success">{probeMsg}</Alert>}
          {probeErr && <Alert severity="error">{probeErr}</Alert>}

          <Stack direction="row" justifyContent="flex-end">
            <Button size="small" onClick={() => void handleProbe()}>
              检查连接
            </Button>
            <Button size="small" variant="contained" sx={{ ml: 1 }} onClick={handleSaveAI}>
              保存
            </Button>
          </Stack>
        </Stack>
      </Paper>

      {/* TTS */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h6">发音（TTS）</Typography>
          {ttsConfig && (
            <Chip
              size="small"
              color={ttsConfig.status === 'active' ? 'success' : ttsConfig.status === 'error' ? 'error' : 'default'}
              label={STATUS_LABEL[ttsConfig.status] ?? ttsConfig.status}
            />
          )}
        </Stack>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            select
            label="主轨供应商"
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as TTSProviderName)}
            size="small"
            helperText={
              isDashscope
                ? 'DashScope（阿里云百炼 CosyVoice）：国内直连、无需国际卡，按量付费。'
                : isAzure
                  ? 'Azure：需 VISA/Master 身份验证，国内用户不推荐（通道保留、不再主推）。'
                  : 'OpenAI 兼容端点：自备，无 SSML 音素注入，音标驱动降级为文本合成。'
            }
          >
            <MenuItem value="dashscope">DashScope（阿里云百炼 · 默认）</MenuItem>
            <MenuItem value="azure">Azure（保留 · 需国际卡）</MenuItem>
            <MenuItem value="openai_compatible">OpenAI 兼容 /audio/speech</MenuItem>
          </TextField>

          <TextField
            label="主轨终结点 endpoint"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            size="small"
            placeholder={endpointPlaceholder}
            helperText={endpointHelper}
          />

          {isDashscope ? (
            <>
              <TextField
                select
                label="模型 model"
                value={ttsModel}
                onChange={(e) => handleModelChange(e.target.value)}
                size="small"
                helperText="模型与音色需配套；音色会随模型联动。cmu 音素注入需支持 SSML 的模型与音色。"
              >
                {DASHSCOPE_MODEL_OPTIONS.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                label="发音人 voice"
                value={effectiveVoice}
                onChange={(e) => setVoice(e.target.value)}
                size="small"
                helperText="音色随模型联动（不能跨模型混用）；英文音素由 CMU 精确驱动。"
              >
                {dashscopeVoiceOptions.map((o) => (
                  <MenuItem key={o.voice} value={o.voice}>
                    {o.label}
                  </MenuItem>
                ))}
              </TextField>
            </>
          ) : (
            <>
              {!isAzure && (
                <TextField
                  label="模型 model"
                  value={ttsModel}
                  onChange={(e) => setTtsModel(e.target.value)}
                  size="small"
                  placeholder="tts-1"
                />
              )}
              <TextField
                label={isAzure ? '发音人（Azure voice，如 en-US-AriaNeural）' : '发音人 voice（如 alloy）'}
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                size="small"
              />
            </>
          )}

          <TextField
            label={
              isDashscope
                ? '主轨密钥（DashScope API Key，sk-…）'
                : isAzure
                  ? '主轨密钥（Azure KEY1）'
                  : '主轨密钥（可留空）'
            }
            // ★ 明文显示（用户 2026-10-14 明确要求：「谁家填 API 的时候保密到这种程度，
            // 你就不能让它明文」）。原来是 type="password"（一串圆点），填完看不清对不对、
            // 也无法确认粘贴是否完整。单人自用设备上遮挡没有实际收益，只添麻烦。
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            size="small"
            helperText="默认只存会话内存（刷新即失）；勾选下方开关才随配置文档落库。"
          />

          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Box>
              <Typography variant="body2">密钥跨刷新保留（存到云端配置文档）</Typography>
              <Typography variant="caption" color="text.secondary">
                该表为 RLS owner-only；不勾选则每次打开应用需重新粘贴一次密钥。
              </Typography>
            </Box>
            <Switch checked={persistKey} onChange={(e) => setPersistKey(e.target.checked)} />
          </Stack>

          {ttsMsg && <Alert severity="success">{ttsMsg}</Alert>}
          {ttsErr && <Alert severity="error">{ttsErr}</Alert>}

          <Stack direction="row" justifyContent="flex-end" alignItems="center" spacing={1}>
            {ttsLoading && <CircularProgress size={18} />}
            <Button size="small" disabled={ttsLoading} onClick={() => void handleTryListen()}>
              {ttsLoading ? ttsPhaseLabel : '试听'}
            </Button>
            <Button
              size="small"
              variant="contained"
              sx={{ ml: 1 }}
              disabled={savingTTS}
              onClick={() => void handleSaveTTS()}
            >
              保存
            </Button>
          </Stack>

          <Divider />
          <Typography variant="subtitle2">用量与成本（仅主轨计费）</Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap">
            <Typography variant="body2">本月字符数：{usage.chars}</Typography>
            <Typography variant="body2">本月请求数：{usage.requests}</Typography>
            <Typography variant="body2">缓存命中率：{(cacheHitRate(usage) * 100).toFixed(1)}%</Typography>
          </Stack>
          {cloudUsage && (
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              云端实测（跨设备一致，来自每次真实合成日志）：本月主轨成功 {cloudUsage.requests} 次 ·{' '}
              {cloudUsage.chars} 字符 ≈ ¥{((cloudUsage.chars / 10000) * DASHSCOPE_PRICE_PER_10K_CHARS).toFixed(2)}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary">
            阿里云控制台官网用量没有公开查询 API（需要控制台登录态），无法在此直读；上行为本应用自己的合成日志聚合，口径与官网账单一致。
            资费：{DASHSCOPE_PRICE_PER_10K_CHARS} 元/万字符；新用户开通百炼 90 天内 {DASHSCOPE_FREE_QUOTA_CHARS} 字符免费。
            （免费额度未计入；缓存命中不产生新字符）
          </Typography>
          <Stack direction="row" justifyContent="flex-end">
            <Button
              size="small"
              onClick={() => {
                resetUsageStats();
                setUsage(readUsageStats());
              }}
            >
              重置本地统计
            </Button>
          </Stack>

          <Divider />
          <Typography variant="caption" color="text.secondary">
            优先级：音频缓存 → 主轨（3 秒超时）→ espeak 离线合成 → 浏览器内置语音。
            兜底首次触发会有一次轻提示，不影响学习节奏。
          </Typography>

          <Divider />
          <Typography variant="subtitle2">存量数据 · 升级发音真源</Typography>
          <Typography variant="caption" color="text.secondary">
            把云端已入库 words 行的 ipa 换成 CMUdict 派生值，并写入 arpabet（DashScope cmu 音素真源）。
            未命中词保留原 ipa。可重复点击，结果幂等。
          </Typography>
          {bfProgress && (
            <Box>
              <Typography variant="body2">
                进度：{bfProgress.done}/{bfProgress.total}（更新 {bfProgress.updated} · 跳过 {bfProgress.skipped}）
              </Typography>
              <LinearProgress
                variant="determinate"
                value={bfProgress.total > 0 ? (bfProgress.done / bfProgress.total) * 100 : 0}
              />
            </Box>
          )}
          {bfMsg && <Alert severity="success">{bfMsg}</Alert>}
          {bfErr && <Alert severity="error">{bfErr}</Alert>}
          <Stack direction="row" justifyContent="flex-end">
            <Button size="small" disabled={bfRunning} onClick={() => void handleBackfill()}>
              {bfRunning ? '回填中…' : '升级发音真源'}
            </Button>
          </Stack>
        </Stack>
      </Paper>
    </Box>
  );
}
