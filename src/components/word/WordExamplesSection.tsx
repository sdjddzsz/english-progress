/**
 * WordExamplesSection.tsx —— 题卡里的「例句」区块（用户 2026-10-22）。
 *
 * 位置：原上/下一题按钮处（按钮已移到题卡上方，为的是一屏多显示）。
 * 每条例句：🔊 AI 朗读（TTS 主轨，与单词发音同一编排链）+ 英文/中文 + 归属义项标注 + 🗑 删除。
 * 生成入口在上方「全部释义」区长按任一释义 → 菜单「生成例句」。
 */
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import { displaySenses } from '../../features/senses';
import type { Word, WordExample } from '../../types/domain';

interface Props {
  word: Word;
  examples: WordExample[];
  /** 正在生成（LLM + 落库） */
  genBusy: boolean;
  /** 生成/删除失败文案 */
  error: string;
  /** TTS 是否正在发音（朗读按钮上转圈） */
  speaking: boolean;
  onSpeak: (en: string) => void;
  onRemove: (id: string) => void;
}

/** 例句归属义项的短标签（「v. 放弃，抛弃」） */
function senseLabelOf(word: Word, senseId: string): string {
  const s = displaySenses(word).find((x) => x.senseId === senseId);
  if (!s) return '';
  return `${s.pos ? `[${s.pos}] ` : ''}${s.zh}`;
}

export default function WordExamplesSection({
  word,
  examples,
  genBusy,
  error,
  speaking,
  onSpeak,
  onRemove,
}: Props) {
  return (
    <Box sx={{ width: '100%', textAlign: 'left' }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="caption" color="text.secondary">
          例句{examples.length > 0 ? `（${examples.length}）` : ''}
        </Typography>
        {genBusy && (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <CircularProgress size={12} />
            <Typography variant="caption" color="primary">
              生成中…
            </Typography>
          </Stack>
        )}
      </Stack>
      {error && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.25 }}>
          {error}
        </Typography>
      )}
      {examples.length === 0 && !genBusy && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
          长按上方任一释义 → 「生成例句」，每次生成追加一条
        </Typography>
      )}
      <Stack spacing={1} sx={{ mt: 0.5 }}>
        {examples.map((ex) => {
          const label = senseLabelOf(word, ex.senseId);
          return (
            <Stack key={ex.id} direction="row" alignItems="flex-start" spacing={0.5}>
              <Tooltip title="朗读例句（AI 发音）">
                <span>
                  <IconButton
                    size="small"
                    disabled={speaking}
                    aria-label={`play example ${ex.id}`}
                    onClick={() => onSpeak(ex.en)}
                    sx={{ mt: -0.25 }}
                  >
                    {speaking ? <CircularProgress size={16} /> : <VolumeUpIcon fontSize="small" />}
                  </IconButton>
                </span>
              </Tooltip>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {ex.en}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  {ex.zh}
                  {label ? ` · ${label}` : ''}
                </Typography>
              </Box>
              <Tooltip title="删除这条例句">
                <span>
                  <IconButton
                    size="small"
                    aria-label={`delete example ${ex.id}`}
                    onClick={() => onRemove(ex.id)}
                    sx={{ mt: -0.25, color: 'text.disabled' }}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          );
        })}
      </Stack>
    </Box>
  );
}
