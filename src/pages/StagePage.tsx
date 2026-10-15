/**
 * StagePage —— 阶段总览（首页第一标签，用户 2026-10-15 四阶段制）：
 * 四张阶段卡片（各阶段词库量 / 今日待刷 / 特种训练），点卡片进阶段详情；
 * 保留计划概览与欠账守卫（计划制输入面板仍生效）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import EditCalendarIcon from '@mui/icons-material/EditCalendar';
import { diffDays } from '../scheduler';
import { EXAM_DATE } from '../config/constants';
import { getRepos, useAppStore } from '../store/useAppStore';
import { STAGE_META, stageStats } from '../features/quiz/stages';
import PlanSummaryCard from '../components/plan/PlanSummaryCard';
import ReschedulePanel from '../components/plan/ReschedulePanel';

export default function StagePage() {
  const navigate = useNavigate();
  const {
    loading,
    error,
    cloudReady,
    userId,
    activePlan,
    planValidation,
    planFinish,
    activeBookId,
    overdue,
    refreshToday,
    bootstrap,
  } = useAppStore();

  const [guardOpen, setGuardOpen] = useState(false);
  const [stats, setStats] = useState<ReturnType<typeof stageStats> | null>(null);
  const [fullyGraduated, setFullyGraduated] = useState(0);
  const [listError, setListError] = useState('');

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const loadStats = useCallback(async () => {
    if (!userId || !activeBookId) return;
    try {
      const all = await getRepos().word.listBookWords(activeBookId);
      setStats(stageStats(all, new Date()));
      setFullyGraduated(all.filter((bw) => bw.stage === 0).length);
      setListError('');
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  }, [userId, activeBookId]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const today = new Date().toISOString().slice(0, 10);
  const daysToExam = useMemo(() => diffDays(EXAM_DATE, today), [today]);
  const inSprint = activePlan ? today >= activePlan.sprintStartDate : false;

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
        <Typography variant="h5">阶段</Typography>
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
            先到「词书」页选择词书；四个阶段随时可以刷（只要阶段词库里有词）。
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
            <Button variant="contained" onClick={() => navigate('/quiz')}>
              直接刷阶段一
            </Button>
            <Button variant="outlined" onClick={() => navigate('/book')}>
              去词书页
            </Button>
          </Stack>
        </Paper>
      ) : (
        <>
          {/* 计划概览（计划制的输入面板，保留） */}
          <Paper sx={{ mt: 2, p: 2 }}>
            <PlanSummaryCard
              plan={activePlan}
              validation={planValidation}
              finishDate={planFinish}
              overdueCount={overdue?.count ?? 0}
              onEditPlan={() => navigate('/plan-editor')}
              onOpenReschedule={() => setGuardOpen(true)}
            />
          </Paper>

          {/* 四阶段卡片 */}
          <Stack spacing={1.5} sx={{ mt: 2 }}>
            {([1, 2, 3, 4] as const).map((n) => {
              const s = stats?.[n];
              const meta = STAGE_META[n];
              const disabled = !s || s.due === 0;
              return (
                <Paper key={n} sx={{ p: 2 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="h6">{meta.name}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {meta.desc} · 词库 {s?.total ?? '…'} 词
                        {s && s.special > 0 ? ` · 特种训练 ${s.special} 词` : ''}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={1}>
                      <Button size="small" variant="outlined" onClick={() => navigate(`/stage/${n}`)}>
                        词表
                      </Button>
                      <Button
                        size="small"
                        variant="contained"
                        startIcon={<PlayArrowIcon />}
                        disabled={disabled}
                        onClick={() => navigate(n === 1 ? '/quiz' : `/stage-quiz/${n}`)}
                      >
                        开始刷（{s?.due ?? 0}）
                      </Button>
                    </Stack>
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
          {listError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              阶段统计加载失败：{listError}
            </Alert>
          )}
          {stats && fullyGraduated > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              已彻底毕业（阶段四写对）{fullyGraduated} 词。
            </Typography>
          )}

          {/* 欠账提示（计划制守卫保留） */}
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

      {/* 重排弹窗 */}
      <Dialog open={guardOpen} onClose={() => setGuardOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>欠账重排</DialogTitle>
        <DialogContent>
          <ReschedulePanel onDone={() => setGuardOpen(false)} />
        </DialogContent>
      </Dialog>
      {/* stats 加载指示 */}
      {!stats && activePlan && (
        <Box sx={{ mt: 2 }}>
          <LinearProgress />
        </Box>
      )}
    </Box>
  );
}
