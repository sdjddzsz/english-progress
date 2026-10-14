/**
 * WordCard.tsx —— 词卡（视觉/听觉双模态共用）：
 * 词形 + 音标 + 释义 + 例句；TTS 发音（单词/例句两档）；
 * ⚠ 多读音词必须按义项逐条列出读音与词性（用户 2026-10-13：不同词性/词义对应不同读音要明确标识）；
 * explain 区展示轮次与上次出现（"为什么是这些词"可解释性，S3）。
 * 展示型组件：不含调度逻辑；数据由页面/store 注入。
 */
import { Box, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { useEffect } from 'react';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import { CircularProgress } from '@mui/material';
import type { Word, WordSense } from '../../types/domain';
import { useTTS } from '../../hooks/useTTS';
import { describeSenses, senseLabel } from '../../features/senses';
import { useSettingsStore } from '../../store/useSettingsStore';

export interface WordCardProps {
  word: Word | null;
  /** 听觉模态下未揭晓前隐藏词形与释义 */
  hideText?: boolean;
  /** 可解释性：上次出现信息（来自 hit.explain.lastSeen） */
  lastSeen?: { date: string; roundNo: number; modality: string };
  roundNo?: number;
  tier?: number;
  compact?: boolean;
  /** 限定展示某一个义项（学习流按判定单位给词时传进来）；不给则展示全部义项 */
  sense?: WordSense;
}

const TIER_LABEL: Record<number, string> = { 1: 'T1 已掌握', 2: 'T2 熟词', 3: 'T3 半熟', 4: 'T4 生词' };

export default function WordCard({
  word,
  hideText = false,
  lastSeen,
  roundNo,
  tier,
  compact = false,
  sense,
}: WordCardProps) {
  const { speak, speakAuto, loading } = useTTS();
  const autoSpeak = useSettingsStore((s) => s.autoSpeak);

  const wordId = word?.id ?? '';
  const senseKey = sense?.senseId ?? '';
  const targetIpa = sense?.ipa || word?.ipa || '';
  const targetArpabet = sense?.arpabet || word?.arpabet || '';
  const targetLemma = sense?.lemma || word?.lemma || '';

  /**
   * 自动发音：进入新词 / 从"隐藏"切到"揭晓"时读一次（受设置开关控制）。
   * 只在词真的变了时才触发 —— 否则每次重渲染都会读一遍。
   */
  useEffect(() => {
    if (!autoSpeak || !wordId || hideText) return;
    void speakAuto({ text: targetLemma, ipa: targetIpa, arpabet: targetArpabet, mode: 'word' }, wordId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSpeak, wordId, senseKey, hideText]);

  if (!word) {
    return (
      <Typography variant="body2" color="text.secondary">
        词库数据加载中…
      </Typography>
    );
  }

  const entries = describeSenses(word);
  const multiPron = entries.length > 1;
  // 发音目标：限定义项 → 用它的读音；否则用首个义项（= 单词级 ipa/arpabet 兼容口径）
  const target = sense ?? entries[0]?.sense ?? null;
  const speakTarget = () =>
    void speak(
      {
        text: word.lemma,
        ipa: target?.ipa || word.ipa,
        arpabet: target?.arpabet || word.arpabet,
        mode: 'word',
      },
      word.id,
    );
  const firstExample = word.examples[0];
  const speakExample = () => {
    if (firstExample) void speak({ text: firstExample.en, mode: 'sentence' }, word.id);
  };

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        {!hideText && (
          <Typography variant={compact ? 'h6' : 'h4'} component="span">
            {word.lemma}
          </Typography>
        )}
        {!hideText && sense && <Typography variant="body1" color="text.secondary">{senseLabel(sense)}</Typography>}
        {/* 音标挨着词形：限定义项时用该义项的读音，否则用单词级读音 */}
        {!hideText && targetIpa && (
          <Typography variant={compact ? 'body2' : 'body1'} color="text.secondary">
            /{targetIpa.replace(/^\/|\/$/g, '')}/
          </Typography>
        )}
        {multiPron && !hideText && (
          <Chip size="small" color="warning" variant="outlined" label={`${entries.length} 种读音/词性`} />
        )}
        <Tooltip title={loading ? '合成中…' : '发音'}>
          <span>
            <IconButton onClick={speakTarget} disabled={loading} aria-label="play word">
              {loading ? <CircularProgress size={20} /> : <VolumeUpIcon />}
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
          {/* 义项表：每个词性一行，行内带该义项自己的读音；多读音词在这里被明确区分 */}
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {entries.map(({ sense: s }, i) => {
              const active = target != null && s.senseId === target.senseId;
              return (
                <Stack
                  key={s.senseId}
                  direction="row"
                  spacing={1}
                  alignItems="baseline"
                  sx={{
                    px: 0.75,
                    py: 0.25,
                    borderRadius: 1,
                    bgcolor: active ? 'action.selected' : 'transparent',
                  }}
                >
                  <Typography variant="body2" color="text.secondary" sx={{ minWidth: 34 }}>
                    {i + 1}.
                  </Typography>
                  <Typography variant="body1" sx={{ flex: 1 }}>
                    {/* ★ 词性必须显式标注（用户 2026-10-14：「有些单词的不同意思对应有不同词性，
                        但现在普遍只标注了单一词性」）。数据侧每个义项都带 pos
                        （8296 词里 6110 个是多义项且词性互不相同），
                        原来写 `s.zh || s.pos` 等于只在释义缺失时才顺带露出词性。 */}
                    {s.pos ? `${s.pos} ${s.zh}`.trim() : s.zh}
                  </Typography>
                  {/* 读音列：与该义项绑定（不是单词级那一个） */}
                  {s.ipa && (
                    <Typography variant="body2" color={multiPron ? 'warning.dark' : 'text.secondary'}>
                      /{s.ipa.replace(/^\/|\/$/g, '')}/
                    </Typography>
                  )}
                  {multiPron && (
                    <IconButton
                      size="small"
                      onClick={() =>
                        void speak({ text: s.lemma, ipa: s.ipa, arpabet: s.arpabet, mode: 'word' }, s.senseId)
                      }
                      aria-label={`play sense ${i + 1}`}
                    >
                      <VolumeUpIcon fontSize="small" />
                    </IconButton>
                  )}
                </Stack>
              );
            })}
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
