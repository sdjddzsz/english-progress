/**
 * WordCard.tsx —— 词卡（视觉/听觉双模态共用）：
 * 词形 + 音标 + 释义 + 例句；TTS 发音（单词/例句两档）；
 * explain 区展示轮次与上次出现（"为什么是这些词"可解释性，S3）。
 * 展示型组件：不含调度逻辑；数据由页面/store 注入。
 */
import { Box, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import type { Word } from '../../types/domain';
import { useTTS } from '../../hooks/useTTS';

export interface WordCardProps {
  word: Word | null;
  /** 听觉模态下未揭晓前隐藏词形与释义 */
  hideText?: boolean;
  /** 可解释性：上次出现信息（来自 hit.explain.lastSeen） */
  lastSeen?: { date: string; roundNo: number; modality: string };
  roundNo?: number;
  tier?: number;
  compact?: boolean;
}

const TIER_LABEL: Record<number, string> = { 1: 'T1 已掌握', 2: 'T2 熟词', 3: 'T3 半熟', 4: 'T4 生词' };

export default function WordCard({ word, hideText = false, lastSeen, roundNo, tier, compact = false }: WordCardProps) {
  const { speak, loading } = useTTS();

  if (!word) {
    return (
      <Typography variant="body2" color="text.secondary">
        词库数据加载中…
      </Typography>
    );
  }

  const speakWord = () => void speak({ text: word.lemma, ipa: word.ipa, mode: 'word' }, word.id);
  const firstExample = word.examples[0];
  const speakExample = () => {
    if (firstExample) void speak({ text: firstExample.en, mode: 'sentence' }, word.id);
  };

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center">
        {!hideText && (
          <Typography variant={compact ? 'h6' : 'h4'} component="span">
            {word.lemma}
          </Typography>
        )}
        {word.ipa && !hideText && (
          <Typography variant={compact ? 'body2' : 'body1'} color="text.secondary">
            /{word.ipa.replace(/^\/|\/$/g, '')}/
          </Typography>
        )}
        <Tooltip title={loading ? '合成中…' : '发音'}>
          <span>
            <IconButton onClick={speakWord} disabled={loading} aria-label="play word">
              <VolumeUpIcon />
            </IconButton>
          </span>
        </Tooltip>
        {firstExample && !hideText && (
          <Tooltip title="读例句">
            <span>
              <IconButton onClick={speakExample} disabled={loading} size="small" aria-label="play example">
                <RecordVoiceOverIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Stack>

      {!hideText && (
        <>
          {word.pos && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {word.pos}
            </Typography>
          )}
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {word.senses.slice(0, 3).map((s, i) => (
              <Typography key={i} variant="body1">
                {i + 1}. {s}
              </Typography>
            ))}
          </Stack>
          {firstExample && (
            <Box sx={{ mt: 1, pl: 1.5, borderLeft: 3, borderColor: 'divider' }}>
              <Typography variant="body2">{firstExample.en}</Typography>
              <Typography variant="body2" color="text.secondary">
                {firstExample.zh}
              </Typography>
            </Box>
          )}
        </>
      )}

      {(tier != null || roundNo != null || lastSeen) && (
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
          {tier != null && <Chip size="small" label={TIER_LABEL[tier] ?? `T${tier}`} variant="outlined" />}
          {roundNo != null && <Chip size="small" label={`第 ${roundNo} 轮`} variant="outlined" />}
          {lastSeen && (
            <Chip
              size="small"
              variant="outlined"
              label={`上次：${lastSeen.date} 第 ${lastSeen.roundNo} 轮 · ${lastSeen.modality === 'audio' ? '听觉' : '视觉'}`}
            />
          )}
        </Stack>
      )}
    </Box>
  );
}
