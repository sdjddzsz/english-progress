/**
 * SettingsPage.tsx —— 设置页（PRD §5.2.5）：
 * 云配置状态 / 学习偏好（设备、见中文联想英文）/ AI 通道（连通性检查）/ TTS。
 *
 * TTS 真源是云端 tts_provider_configs 文档（编排器 useTTS.getConfig 从那里读），
 * 本地 settings store 只是回填用的影子副本——所以保存必须写云端，否则主轨不生效。
 * 密钥默认只写会话内存（hooks/useTTS.setRuntimeTTSApiKey，刷新即失）；
 * 勾选"跨刷新保留"时才随 apiKeyRef 机制落库（RLS owner-only，架构 §8 #2 唯一例外）。
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  LinearProgress,
  MenuItem,
  Paper,
  Slider,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import type { TTSProviderConfig, TTSProviderName } from '../types/domain';
import type { LLMChannel } from '../ai/llmClient';
import { listModels } from '../ai/llmClient';
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
  DASHSCOPE_VOICE_OPTIONS,
} from '../config/constants';
import { cacheHitRate, readUsageStats, resetUsageStats, type UsageStats } from '../tts/usageStats';
import { backfillArpabetFromSeed, type BackfillProgress } from '../data/backfillArpabet';

export default function SettingsPage() {
  const bootstrap = useAppStore((s) => s.bootstrap);
  const settings = useSettingsStore();
  const { speak } = useTTS();

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
  /** T8 存量回填（升级发音真源） */
  const [bfRunning, setBfRunning] = useState(false);
  const [bfProgress, setBfProgress] = useState<BackfillProgress | null>(null);
  const [bfMsg, setBfMsg] = useState('');
  const [bfErr, setBfErr] = useState('');
  const [baseUrl, setBaseUrl] = useState(settings.aiBaseUrl);
  const [model, setModel] = useState(settings.aiModel);
  const [channel, setChannel] = useState<LLMChannel>(settings.aiChannel);
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
          if (cfg.voice && !voice) setVoice(cfg.voice);
          if (cfg.model) setTtsModel(cfg.model);
          setPersistKey(Boolean(cfg.runtimeApiKey));
        }
      } catch {
        setTtsConfig(null);
      }
    })();
    // P1-1：进入设置页刷新一次本地用量
    setUsage(readUsageStats());
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
      setProbeMsg(`连接正常，可用模型 ${models.length} 个${models[0] ? `（如 ${models[0].id}）` : ''}。`);
    } catch (e) {
      setProbeErr(e instanceof Error ? e.message : String(e));
    }
  };

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
    const v = voice.trim() || (isDashscope ? DASHSCOPE_DEFAULT_VOICE : '');
    const m = ttsModel.trim() || (isDashscope ? DASHSCOPE_DEFAULT_MODEL : '');
    settings.setTTS(provider, v, m);
    setRuntimeTTSApiKey(apiKey);

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
      const ready = Boolean(ep && v && key);
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
    // 探针带 arpabet（dashscope → <phoneme alphabet="cmu"> 零转换；azure 忽略该字段、回退 ipa）
    const engine = await speak({ text: 'progress', ipa: 'ˈprɒɡres', arpabet: 'P R AA1 G R EH2 S', mode: 'word' });
    setUsage(readUsageStats()); // P1-1：试听会写用量，刷新成本卡
    if (engine === 'neural_tts') {
      setTtsMsg('主轨（神经语音）发音成功。');
    } else if (engine === 'ipa_espeak') {
      setTtsErr(
        '走的是 espeak 兜底（机械音）——主轨没通。常见原因：① 浏览器 CORS/预检不放行（控制台报 Failed to fetch）——' +
          'DashScope 会自动改走 WebSocket 直连，若仍落到兜底说明 WS 也不通；② API Key 无效或未开通百炼；' +
          '③ 端点与密钥所在资源不匹配。请对照控制台报错逐项排查。',
      );
    } else {
      setTtsErr('发音失败，请打开浏览器控制台查看 [tts] 报错。');
    }
    const userId = useAppStore.getState().userId;
    const id = ttsConfig?.id;
    if (userId && id) {
      try {
        const updated = await getRepos().config.updateTTSConfig(id, {
          lastTestAt: new Date().toISOString(),
          status: engine === 'neural_tts' ? 'active' : engine ? 'error' : 'pending_user_setup',
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
            <>
              <TextField
                label="Base URL（形如 https://host/v1）"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                size="small"
              />
              <TextField label="模型名" value={model} onChange={(e) => setModel(e.target.value)} size="small" />
            </>
          )}
          {channel === 'workbuddy' && (
            <TextField
              label="模型名（留空用默认）"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              size="small"
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
                onChange={(e) => setTtsModel(e.target.value)}
                size="small"
                helperText="CosyVoice 系列；cmu 音素注入需支持 SSML 的模型与音色。"
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
                value={voice || DASHSCOPE_DEFAULT_VOICE}
                onChange={(e) => setVoice(e.target.value)}
                size="small"
                helperText="专用英文音色（loong*）不支持 SSML，故默认用中英混合的中文系音色，英文音素由 CMU 精确驱动。"
              >
                {DASHSCOPE_VOICE_OPTIONS.map((o) => (
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
            type="password"
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

          <Stack direction="row" justifyContent="flex-end">
            <Button size="small" onClick={() => void handleTryListen()}>
              试听
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
          <Typography variant="subtitle2">用量与成本（本地统计 · 仅主轨计费）</Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap">
            <Typography variant="body2">本月字符数：{usage.chars}</Typography>
            <Typography variant="body2">本月请求数：{usage.requests}</Typography>
            <Typography variant="body2">缓存命中率：{(cacheHitRate(usage) * 100).toFixed(1)}%</Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            资费：{DASHSCOPE_PRICE_PER_10K_CHARS} 元/万字符；新用户开通百炼 90 天内 {DASHSCOPE_FREE_QUOTA_CHARS} 字符免费。
            按本月字符数估算约 ¥{((usage.chars / 10000) * DASHSCOPE_PRICE_PER_10K_CHARS).toFixed(2)}
            （免费额度未计入；缓存命中不产生新字符）。
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
            优先级：音频缓存 → 主轨（3 秒超时）→ espeak 兜底。兜底首次触发会有一次轻提示，不影响学习节奏。
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
