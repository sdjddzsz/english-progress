/**
 * TodayPage.tsx —— 今日页（PRD §5.2.1）：
 * 今日队列（真实词表路径，store.refreshToday）/ 计划概览 / 距考试天数。
 * 欠账守卫：UI 提示（ReschedulePanel 弹窗，T05 抽出复用）+ 路由级拦截（OverdueGuardRoute）。
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
  DialogContent,
  DialogTitle,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import EditCalendarIcon from '@mui/icons-material/EditCalendar';
import { diffDays } from '../scheduler';
import { EXAM_DATE } from '../config/constants';
import { useAppStore } from '../store/useAppStore';
import PlanSummaryCard from '../components/plan/PlanSummaryCard';
import ReschedulePanel from '../components/plan/ReschedulePanel';

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
    refreshToday,
    bootstrap,
  } = useAppStore();

  const [guardOpen, setGuardOpen] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const today = new Date().toISOString().slice(0, 10);
  const daysToExam = useMemo(() => diffDays(EXAM_DATE, today), [today]);
  const inSprint = activePlan ? today >= activePlan.sprintStartDate : false;

  const grouped = useMemo(() => {
    const g: Record<number, typeof todayHits> = { 1: [], 2: [], 3: [], 4: [] };
    for (const h of todayHits) g[h.tier].push(h);
    return g;
  }, [todayHits]);

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
            先到「词书」页选择词书，然后直接开始单词考查（按用时与对错判定，连续熟练 5 次毕业）。
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
            <Button variant="contained" onClick={() => navigate('/quiz')}>
              开始单词考查
            </Button>
            <Button variant="outlined" onClick={() => navigate('/book')}>
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
                variant="outlined"
                onClick={() => navigate('/quiz')}
              >
                单词考查
              </Button>
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

          {/* 欠账提示（UI 级；mustReschedule 时路由级拦截已兜底，这里提供主动入口） */}
          {overdue && overdue.count > 0 && (
            <Alert
              severity={overdue.mustReschedule ? 'warning' : 'info'}
              sx={{ mt: 2 }}
              action={
                <Button color="inherit" size="small" onClick={() => setGuardOpen(true)}>
                  去处理
                </Button>
              }
            >
              欠账 {overdue.count} 条（阈值 {overdue.threshold}）
              {overdue.mustReschedule ? '：已超阈值，需要重排后才能继续新任务。' : '：可在队列中顺带补上。'}
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

      {/* 重排弹窗（复用 T05 抽出的 ReschedulePanel；mustReschedule 时另有路由级拦截） */}
      <Dialog open={guardOpen} onClose={() => setGuardOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>欠账重排</DialogTitle>
        <DialogContent>
          <ReschedulePanel onDone={() => setGuardOpen(false)} />
        </DialogContent>
      </Dialog>
    </Box>
  );
}
