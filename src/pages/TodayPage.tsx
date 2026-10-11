/**
 * TodayPage.tsx —— 今日页（PRD §5.2.1）：
 * 今日队列（真实词表路径，store.refreshToday）/ 欠账守卫（四策略大白话预览，UI 级拦截；
 * 路由级拦截在 T05 批次）/ 距考试天数 / 计划概览。
 * 页面不含调度逻辑：队列、校验、欠账预览全部来自 useAppStore。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Paper,
  Radio,
  Stack,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import EditCalendarIcon from '@mui/icons-material/EditCalendar';
import { diffDays, type RescheduleStrategy } from '../scheduler';
import { EXAM_DATE } from '../config/constants';
import { todayISO, useAppStore } from '../store/useAppStore';
import PlanSummaryCard from '../components/plan/PlanSummaryCard';

const TIER_LABEL: Record<number, string> = { 1: 'T1', 2: 'T2', 3: 'T3', 4: 'T4' };

export default function TodayPage() {
  const navigate = useNavigate();
  const {
    loading,
    error,
    cloudReady,
    activePlan,
    planValidation,
    planFinish,
    todayHits,
    todayPendingCount,
    wordMap,
    overdue,
    overduePreviews,
    bootstrap,
    rescheduleNow,
    refreshToday,
  } = useAppStore();

  const [chosen, setChosen] = useState<RescheduleStrategy | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acting, setActing] = useState(false);
  const [actMsg, setActMsg] = useState('');

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const today = todayISO();
  const daysToExam = useMemo(() => diffDays(EXAM_DATE, today), [today]);
  const inSprint = activePlan ? today >= activePlan.sprintStartDate : false;

  const grouped = useMemo(() => {
    const g: Record<number, typeof todayHits> = { 1: [], 2: [], 3: [], 4: [] };
    for (const h of todayHits) g[h.tier].push(h);
    return g;
  }, [todayHits]);

  const handleReschedule = async () => {
    if (!chosen) return;
    setActing(true);
    const r = await rescheduleNow(chosen);
    setActing(false);
    setConfirmOpen(false);
    setActMsg(r.ok ? '重排已生效，今日队列已刷新。' : `重排未生效：${r.message}`);
    if (r.ok) setChosen(null);
  };

  // ===== 引导态 =====
  if (!cloudReady && error) {
    return (
      <Box p={2}>
        <Alert severity="warning" title="云服务未配置">
          {error}
        </Alert>
        <Button sx={{ mt: 2 }} variant="outlined" onClick={() => navigate('/settings')}>
          去设置页查看云配置
        </Button>
      </Box>
    );
  }
  if (loading && !activePlan) {
    return (
      <Box p={6} textAlign="center">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box p={2} pb={4}>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline">
        <Typography variant="h5">Today</Typography>
        <Typography variant="body2" color="text.secondary">
          距六级考试 {daysToExam} 天{inSprint ? ' · 冲刺周进行中' : ''}
        </Typography>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mt: 1 }} onClose={() => void refreshToday()}>
          {error}（点击关闭后可重试）
        </Alert>
      )}

      {!activePlan ? (
        <Paper sx={{ mt: 2, p: 3 }}>
          <Typography variant="h6">还没有生效中的计划</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            先到「词书」页选择词书，再到「计划编辑」里确定档位与预算，系统会生成可解释的轮次安排。
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
            <Button variant="contained" onClick={() => navigate('/book')}>
              去词书页
            </Button>
            <Button variant="outlined" onClick={() => navigate('/plan-editor')}>
              计划编辑
            </Button>
          </Stack>
        </Paper>
      ) : (
        <>
          {/* 计划概览 */}
          <Paper sx={{ mt: 2, p: 2 }}>
            <PlanSummaryCard
              plan={activePlan}
              validation={planValidation}
              finishDate={planFinish}
              overdueCount={overdue?.count ?? 0}
            />
            <Divider sx={{ my: 1.5 }} />
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="body1">
                今日待完成 <strong>{todayPendingCount}</strong> / {todayHits.length}
              </Typography>
              <Button
                variant="contained"
                startIcon={<PlayArrowIcon />}
                disabled={todayPendingCount === 0}
                onClick={() => navigate('/study')}
              >
                开始学习
              </Button>
            </Stack>
          </Paper>

          {/* 欠账守卫（UI 级；路由级拦截 T05） */}
          {overdue && overdue.count > 0 && (
            <Alert
              severity={overdue.mustReschedule ? 'warning' : 'info'}
              sx={{ mt: 2 }}
              action={
                <Button color="inherit" size="small" onClick={() => setConfirmOpen(true)}>
                  去处理
                </Button>
              }
            >
              欠账 {overdue.count} 条（阈值 {overdue.threshold}）
              {overdue.mustReschedule ? '：已超阈值，需要重排后才能继续新任务。' : '：可在队列中顺带补上。'}
            </Alert>
          )}

          {actMsg && (
            <Alert severity="info" sx={{ mt: 2 }} onClose={() => setActMsg('')}>
              {actMsg}
            </Alert>
          )}

          {/* 今日队列（按层分组；展示可解释信息，不含禁用概念） */}
          {([4, 3, 2, 1] as const).map((tier) =>
            grouped[tier].length === 0 ? null : (
              <Paper key={tier} sx={{ mt: 2, p: 2 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip size="small" color={tier === 4 ? 'error' : tier === 3 ? 'warning' : 'default'} label={TIER_LABEL[tier]} />
                  <Typography variant="body2" color="text.secondary">
                    {grouped[tier].filter((h) => h.status === 'pending').length} / {grouped[tier].length} 待完成
                  </Typography>
                </Stack>
                <Stack divider={<Divider flexItem />} sx={{ mt: 1 }}>
                  {grouped[tier].map((h) => {
                    const w = wordMap[h.wordId];
                    return (
                      <Stack key={h.id} direction="row" justifyContent="space-between" alignItems="center" py={0.75}>
                        <Box>
                          <Typography variant="body1" component="span" sx={{ color: h.status === 'pending' ? 'text.primary' : 'text.disabled' }}>
                            {w?.lemma ?? h.wordId}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                            第 {h.roundNo} 轮 · {h.modality === 'audio' ? '听觉' : '视觉'}
                            {h.explain.lastSeen ? ` · 上次 ${h.explain.lastSeen.date}` : ' · 首见'}
                          </Typography>
                        </Box>
                        <Chip
                          size="small"
                          variant="outlined"
                          label={h.status === 'pending' ? '待完成' : h.status === 'done' ? '已完成' : h.status === 'deferred' ? '已暂缓' : '欠账'}
                        />
                      </Stack>
                    );
                  })}
                </Stack>
              </Paper>
            ),
          )}

          <Button
            fullWidth
            variant="outlined"
            startIcon={<EditCalendarIcon />}
            sx={{ mt: 2 }}
            onClick={() => navigate('/plan-editor')}
          >
            调整计划参数（改前出影响预览）
          </Button>
        </>
      )}

      {/* 重排确认框（Require 级：用户显式选择策略 + 确认放行） */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>欠账重排</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 1 }}>
            欠账 {overdue?.count ?? 0} 条。选一种处理方式（每条都有大白话解释，改前可看清后果）：
          </DialogContentText>
          <Stack spacing={1}>
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
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>先不处理</Button>
          <Button variant="contained" disabled={!chosen || acting} onClick={() => void handleReschedule()}>
            {acting ? <CircularProgress size={20} /> : '确认执行'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
