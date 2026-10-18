/**
 * VoiceOverrideDialog.tsx —— 模型/音色临换面板（用户 2026-10-18）：
 * 长按「重新合成」按钮打开 → 选模型+音色 → 临时固定本轮考查。
 *
 * 硬约束（用户原话「云端音频和模型音色要对准不要串了」）：
 * - 音色按模型分组（DASHSCOPE_VOICE_OPTIONS_BY_MODEL，官方明确音色不能跨模型混用）；
 * - 选定的 {model, voice} 只作为覆盖传进编排器 opts，由 orchestrator 的
 *   applyVoiceOverride 合并成生效配置——cacheKey 与 cloudAudioPath 同源派生，
 *   本地缓存 lane / 云端 lane 按生效音色+模型对齐，换项即换 lane，旧 lane 原样保留。
 *
 * 纯 helper（voicesForModel / defaultVoiceForModel / voiceLabelOf）导出供单测与页面复用。
 */
import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { ALL_MODELS, defaultVoiceForModel, voiceLabelOf, voicesForModel } from '../../tts/voiceOptions';
import type { VoiceOverride } from '../../tts/types';

export interface VoiceOverrideDialogProps {
  open: boolean;
  /** 当前本轮覆盖（null=用设置页配置） */
  current: VoiceOverride | null;
  /** 读当前生效模型/音色（useTTS.getEffectiveVoiceModel）——无覆盖时回显用 */
  getDefaults: () => Promise<{ model: string; voice: string }>;
  onClose(): void;
  /** 确定/恢复默认：v=null 表示清除覆盖回到设置页配置 */
  onApply(v: VoiceOverride | null): void;
}

export default function VoiceOverrideDialog({ open, current, getDefaults, onClose, onApply }: VoiceOverrideDialogProps) {
  const [sel, setSel] = useState<VoiceOverride>({ model: ALL_MODELS[0], voice: defaultVoiceForModel(ALL_MODELS[0]) });

  // 打开时回显：有覆盖→覆盖值；无覆盖→异步读生效配置（设置页值），读不到用常量默认
  useEffect(() => {
    if (!open) return;
    if (current) {
      setSel(current);
      return;
    }
    let alive = true;
    void getDefaults().then((d) => {
      if (alive) setSel(d);
    });
    return () => {
      alive = false;
    };
  }, [open, current, getDefaults]);

  const voices = voicesForModel(sel.model);

  const changeModel = (model: string) => {
    // 新模型音色表里还保留得住就沿用（如 longanyang 同属 v3-flash 与 v3-plus），否则回落该模型默认
    const keep = voicesForModel(model).some((v) => v.voice === sel.voice);
    setSel({ model, voice: keep ? sel.voice : defaultVoiceForModel(model) });
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>临时更换模型 / 音色</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          只影响本轮考查，离开页面或开新一轮自动恢复设置页配置。
          云端音频按「音色 + 模型」分开存放，换哪个都不会串到别的音色上。
        </Typography>
        <Typography variant="caption" color="text.secondary">
          模型
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={sel.model}
          onChange={(_, v) => {
            if (v) changeModel(v);
          }}
          sx={{ flexWrap: 'wrap', gap: 0.5, mb: 2 }}
        >
          {ALL_MODELS.map((m) => (
            <ToggleButton key={m} value={m}>
              {m}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary">
          音色{voices.length === 0 ? '（该模型暂无可用音色）' : ''}
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={sel.voice}
          onChange={(_, v) => {
            if (v) setSel({ ...sel, voice: v });
          }}
          sx={{ flexDirection: 'column', alignItems: 'stretch', gap: 0.5 }}
        >
          {voices.map((v) => (
            <ToggleButton key={v.voice} value={v.voice} disabled={voices.length === 0}>
              {v.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {sel.model === 'cosyvoice-v2' && (
          <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 1 }}>
            注意：v2 对音素注入有缺陷，个别词音频会跑飞，一般用 v3-flash。
          </Typography>
        )}
        <Box sx={{ mt: 2 }}>
          <Typography variant="body2">
            当前选择：<strong>{voiceLabelOf(sel.model, sel.voice)}</strong> · {sel.model}
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onApply(null)} color="inherit">
          恢复默认
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={onClose} color="inherit">
          取消
        </Button>
        <Button
          onClick={() => onApply(sel)}
          variant="contained"
          disabled={voices.length === 0 || !sel.voice}
        >
          确定（当场重录）
        </Button>
      </DialogActions>
    </Dialog>
  );
}
