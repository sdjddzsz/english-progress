/**
 * FeedbackPanel.tsx —— 每 hit 反馈面板（PRD §4.6）：
 * L1 认知状态（必选单选）→ L2 问题定位（多选 ≤3）→ L3 处置动作（可选）→ 备注（≤60）→ 混淆词。
 * 提交后由 useFeedback 落库；本组件不含调度与数据访问逻辑。
 */
import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  FormControl,
  FormLabel,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import type { L1State, L2Tag, L3Action } from '../../types/domain';
import { MAX_L2_TAGS, NOTE_MAX_LENGTH } from '../../config/constants';
import ConfusionPicker from './ConfusionPicker';

export interface FeedbackPanelSubmit {
  l1State: L1State;
  l2Tags: L2Tag[];
  confusionWordId?: string;
  l3Actions: L3Action[];
  note?: string;
}

export interface FeedbackPanelProps {
  /** 候选混淆词（今日队列词，目标词必须来自当前队列） */
  candidates: { id: string; lemma: string }[];
  onSubmit(input: FeedbackPanelSubmit): void;
  disabled?: boolean;
}

const L1_OPTIONS: { value: L1State; label: string; emoji: string }[] = [
  { value: 'instant', label: '秒认', emoji: '😀' },
  { value: 'recognized', label: '认得', emoji: '😐' },
  { value: 'familiar_but_forgotten', label: '见过想不起', emoji: '😵' },
  { value: 'unknown', label: '不认识', emoji: '❌' },
];

const L2_TAGS: L2Tag[] = [
  '词义记不住',
  '中文释义太抽象易混',
  '多义项分不清',
  '拼写词形记不住',
  '形近词混淆',
  '词根词缀不熟',
  '发音读不准',
  '重音位置记不住',
  '听不出这个词',
  '词性判断错',
  '搭配介词不会用',
  '知道意思但造句造不出',
  '例句看不懂',
  '阅读里没反应过来',
  '听力里没反应过来',
  '释义有误',
  '例句不当',
  '音标有误',
];

const L3_OPTIONS: { value: L3Action; label: string }[] = [
  { value: 'extra_practice', label: '加练一次' },
  { value: 'postpone', label: '暂缓到末轮' },
  { value: 'star', label: '重点收藏' },
  { value: 'pronunciation_doubt', label: '发音存疑' },
  { value: 'content_doubt', label: '释义/例句存疑' },
];

export default function FeedbackPanel({ candidates, onSubmit, disabled = false }: FeedbackPanelProps) {
  const [l1, setL1] = useState<L1State | null>(null);
  const [l2Tags, setL2Tags] = useState<L2Tag[]>([]);
  const [l3Actions, setL3Actions] = useState<L3Action[]>([]);
  const [note, setNote] = useState('');
  const [confusionId, setConfusionId] = useState<string | null>(null);

  const noteTooLong = note.length > NOTE_MAX_LENGTH;
  const canSubmit = l1 != null && !noteTooLong;

  const toggleL2 = useMemo(
    () => (tag: L2Tag) => {
      setL2Tags((prev) => {
        if (prev.includes(tag)) return prev.filter((t) => t !== tag);
        if (prev.length >= MAX_L2_TAGS) return prev; // 上限 3
        return [...prev, tag];
      });
    },
    [],
  );

  const toggleL3 = (a: L3Action) => {
    setL3Actions((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]));
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({
      l1State: l1 as L1State,
      l2Tags,
      ...(confusionId ? { confusionWordId: confusionId } : {}),
      l3Actions,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  };

  return (
    <Stack spacing={2}>
      <FormControl>
        <FormLabel>这个词现在是（必选）</FormLabel>
        <ToggleButtonGroup
          exclusive
          value={l1}
          onChange={(_, v: L1State | null) => setL1(v)}
          fullWidth
          size="small"
          disabled={disabled}
        >
          {L1_OPTIONS.map((o) => (
            <ToggleButton key={o.value} value={o.value}>
              {o.emoji} {o.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </FormControl>

      <Box>
        <FormLabel component="legend" sx={{ mb: 0.5 }}>
          哪里卡住了（可选，最多 {MAX_L2_TAGS} 项）
        </FormLabel>
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
          {L2_TAGS.map((t) => (
            <Chip
              key={t}
              label={t}
              size="small"
              color={l2Tags.includes(t) ? 'primary' : 'default'}
              variant={l2Tags.includes(t) ? 'filled' : 'outlined'}
              onClick={() => toggleL2(t)}
              disabled={disabled || (!l2Tags.includes(t) && l2Tags.length >= MAX_L2_TAGS)}
            />
          ))}
        </Stack>
      </Box>

      <ConfusionPicker candidates={candidates} value={confusionId} onChange={setConfusionId} />

      <Box>
        <FormLabel component="legend" sx={{ mb: 0.5 }}>
          处置（可选）
        </FormLabel>
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
          {L3_OPTIONS.map((o) => (
            <Chip
              key={o.value}
              label={o.label}
              size="small"
              color={l3Actions.includes(o.value) ? 'secondary' : 'default'}
              variant={l3Actions.includes(o.value) ? 'filled' : 'outlined'}
              onClick={() => toggleL3(o.value)}
              disabled={disabled}
            />
          ))}
        </Stack>
      </Box>

      <TextField
        label="备注（给 AI 看的补充说明，可选）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        multiline
        minRows={1}
        size="small"
        disabled={disabled}
        error={noteTooLong}
        helperText={noteTooLong ? `超出 ${NOTE_MAX_LENGTH} 字上限` : `${note.length}/${NOTE_MAX_LENGTH}`}
      />

      <Button variant="contained" onClick={handleSubmit} disabled={disabled || !canSubmit}>
        提交，下一个
      </Button>
    </Stack>
  );
}
