/**
 * ConfusionPicker.tsx —— 混淆词选择（PRD §4.6 混淆对）：
 * 候选固定来自当前队列词（四阶共同规则），支持搜索过滤；可清除。
 */
import { Autocomplete, Box, TextField, Typography } from '@mui/material';
import { useMemo } from 'react';

export interface ConfusionPickerProps {
  candidates: { id: string; lemma: string }[];
  value: string | null;
  onChange(wordId: string | null): void;
}

export default function ConfusionPicker({ candidates, value, onChange }: ConfusionPickerProps) {
  const selected = useMemo(() => candidates.find((c) => c.id === value) ?? null, [candidates, value]);

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
        和哪个词混淆了？（可选）
      </Typography>
      <Autocomplete
        size="small"
        options={candidates}
        getOptionLabel={(o) => (typeof o === 'string' ? o : o.lemma)}
        value={selected}
        onChange={(_, v) => onChange(v && typeof v !== 'string' ? v.id : null)}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        renderInput={(params) => <TextField {...params} placeholder="输入词形过滤" />}
        disabled={candidates.length === 0}
      />
    </Box>
  );
}
