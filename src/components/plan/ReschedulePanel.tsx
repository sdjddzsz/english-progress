/**
 * ReschedulePanel.tsx —— 欠账重排面板（T05 从 TodayPage 守卫对话框抽出复用）：
 * 四策略大白话单选卡片（extend 突破 deadline 置灰）+ 确认执行（rescheduleNow，
 * Require 级：面板确认 = 用户放行动作）。TodayPage 弹窗与路由级拦截共用。
 */
import { useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Paper,
  Radio,
  Stack,
  Typography,
} from '@mui/material';
import type { RescheduleStrategy } from '../../scheduler';
import { useAppStore } from '../../store/useAppStore';

export interface ReschedulePanelProps {
  /** standalone=true 时渲染为整页（路由级拦截）；false 时仅内容块（嵌弹窗） */
  standalone?: boolean;
  /** 重排成功后的回调（拦截态下无需额外动作，store 刷新后 mustReschedule 自动解除） */
  onDone?(): void;
}

export default function ReschedulePanel({ standalone = false, onDone }: ReschedulePanelProps) {
  const { overdue, overduePreviews, rescheduleNow } = useAppStore();
  const [chosen, setChosen] = useState<RescheduleStrategy | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acting, setActing] = useState(false);
  const [actMsg, setActMsg] = useState('');

  const handleReschedule = async () => {
    if (!chosen) return;
    setActing(true);
    const r = await rescheduleNow(chosen);
    setActing(false);
    setConfirmOpen(false);
    if (r.ok) {
      setChosen(null);
      onDone?.();
    } else {
      setActMsg(`重排未生效：${r.message}`);
    }
  };

  const content = (
    <>
      {overdue && (
        <Typography variant="body2" color="text.secondary">
          欠账 {overdue.count} 条（阈值 {overdue.threshold}）。选一种处理方式（每条都有大白话解释，改前可看清后果）：
        </Typography>
      )}
      <Stack spacing={1} sx={{ mt: 1 }}>
        {overduePreviews.map((p) => (
          <Paper
            key={p.strategy}
            variant="outlined"
            sx={{ p: 1.5, opacity: p.available ? 1 : 0.45, cursor: p.available ? 'pointer' : 'not-allowed' }}
            onClick={() => p.available && setChosen(p.strategy)}
          >
            <Stack direction="row" alignItems="center" spacing={1}>
              <Radio checked={chosen === p.strategy} disabled={!p.available} />
              <Box>
                <Typography variant="body2" fontWeight={600}>
                  {p.plainWords}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  日均变 ~{p.newDailyHits} 个 · 预计完成 {p.newFinishDate}
                  {p.deadlineExceeded ? ' · 突破截止日，不可选' : ''}
                  {p.strategy === 'drop_round' && !p.available ? ' · 各层已是最少轮次' : ''}
                </Typography>
              </Box>
            </Stack>
          </Paper>
        ))}
      </Stack>
      {actMsg && (
        <Typography variant="body2" color="error" sx={{ mt: 1 }}>
          {actMsg}
        </Typography>
      )}
      {!standalone && (
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>先不处理</Button>
          <Button variant="contained" disabled={!chosen || acting} onClick={() => setConfirmOpen(true)}>
            {acting ? <CircularProgress size={20} /> : '确认执行'}
          </Button>
        </DialogActions>
      )}

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs">
        <DialogTitle>确认执行重排？</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {chosen === 'extend' && '整体时间拉长，每天量不变。'}
            {chosen === 'compress' && '近期每天多背一点，总工期不变。'}
            {chosen === 'drop_round' && '减少一遍完整复习，完成时间不变。'}
            {chosen === 'freeze' && '把已掌握的词移出本轮，末轮再确认一次。'}
            {'执行后欠账清零、队列自动重排。'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>再想想</Button>
          <Button variant="contained" disabled={acting} onClick={() => void handleReschedule()}>
            {acting ? <CircularProgress size={20} /> : '确认'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );

  if (standalone) {
    return (
      <Stack sx={{ maxWidth: 640, mx: 'auto', p: 2 }}>
        <Typography variant="h5">欠账需要先处理</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          欠账已超阈值。按你的原则：欠账不静默累积——处理完才能继续新任务。
        </Typography>
        {content}
        <Button
          variant="contained"
          sx={{ mt: 2 }}
          disabled={!chosen || acting}
          onClick={() => setConfirmOpen(true)}
        >
          {acting ? <CircularProgress size={20} /> : '确认执行所选策略'}
        </Button>
      </Stack>
    );
  }
  return <>{content}</>;
}
