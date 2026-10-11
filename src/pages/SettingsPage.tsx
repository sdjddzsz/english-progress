/**
 * SettingsPage.tsx —— 设置页（PRD §5.2.5）：
 * 云配置状态 / 学习偏好（设备、见中文联想英文）/ AI 通道（连通性检查）/ TTS（发音人、
 * 会话级密钥、试听）。密钥只写会话内存（hooks/useTTS.setRuntimeTTSApiKey），绝不落盘。
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  MenuItem,
  Paper,
  Slider,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import type { TTSProviderConfig } from '../types/domain';
import type { LLMChannel } from '../ai/llmClient';
import { listModels } from '../ai/llmClient';
import { isCloudConfigured } from '../data/cloud';
import { getRepos, useAppStore } from '../store/useAppStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { peekRuntimeTTSApiKey, setRuntimeTTSApiKey, useTTS } from '../hooks/useTTS';

export default function SettingsPage() {
  const bootstrap = useAppStore((s) => s.bootstrap);
  const settings = useSettingsStore();
  const { speak } = useTTS();

  const [ttsConfig, setTtsConfig] = useState<TTSProviderConfig | null>(null);
  const [apiKey, setApiKey] = useState(peekRuntimeTTSApiKey());
  const [voice, setVoice] = useState(settings.ttsVoice);
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
        setTtsConfig(await getRepos().config.getTTSConfig(userId));
      } catch {
        setTtsConfig(null);
      }
    })();
  }, []);

  const STATUS_LABEL: Record<string, string> = {
    pending_user_setup: '待配置（默认 · espeak 兜底已可用）',
    active: '已启用',
    error: '异常',
  };

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

  const handleSaveTTS = () => {
    settings.setTTS(settings.ttsProvider, voice.trim());
    setRuntimeTTSApiKey(apiKey);
  };

  const handleTryListen = () => {
    void speak({ text: 'progress', ipa: 'ˈprɒɡres', mode: 'word' });
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
            value={settings.ttsProvider}
            onChange={(e) => settings.setTTS(e.target.value as typeof settings.ttsProvider, settings.ttsVoice)}
            size="small"
          >
            <MenuItem value="azure">Azure（SSML 音素注入）</MenuItem>
            <MenuItem value="openai_compatible">OpenAI 兼容 /audio/speech</MenuItem>
          </TextField>

          <TextField
            label="发音人（Azure voice，如 en-US-AriaNeural）"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            size="small"
          />

          <TextField
            label="主轨密钥（仅保存在当前会话内存，刷新即失）"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            size="small"
            helperText="不落 localStorage、不进代码；未填时自动走 espeak 兜底轨。"
          />

          <Stack direction="row" justifyContent="flex-end">
            <Button size="small" onClick={handleTryListen}>
              试听
            </Button>
            <Button size="small" variant="contained" sx={{ ml: 1 }} onClick={handleSaveTTS}>
              保存
            </Button>
          </Stack>

          <Divider />
          <Typography variant="caption" color="text.secondary">
            优先级：音频缓存 → 主轨（3 秒超时）→ espeak 兜底。兜底首次触发会有一次轻提示，不影响学习节奏。
          </Typography>
        </Stack>
      </Paper>
    </Box>
  );
}
