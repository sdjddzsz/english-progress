/**
 * TodayPage.tsx —— 今日页（用户 2026-10-15 拍板 A：清单彻底改成考查制）：
 * 「阶段待完成」与考查页（QuizPage）共用 selectQuizPool 同一套规则 ——
 * 该考的词（层间隔 + 特种训练优先）且当天未过关；考查里过关/毕业，回到本页数字立刻真降。
 * 计划概览卡片与欠账守卫保留（仍是计划制的输入面板）；原计划制 hit 队列不再展示。
 * 页面不含调度逻辑：词书行来自 repos，规则来自 features/quiz。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  Pagination,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import EditCalendarIcon from '@mui/icons-material/EditCalendar';
import { diffDays } from '../scheduler';
import { EXAM_DATE } from '../config/constants';
import { getRepos, useAppStore } from '../store/useAppStore';
import { selectQuizPool } from '../features/quiz/pool';
import type { BookWord } from '../types/domain';
import PlanSummaryCard from '../components/plan/PlanSummaryCard';
import ReschedulePanel from '../components/plan/ReschedulePanel';

const TIER_LABEL: Record<number, string> = { 1: 'T1', 2: 'T2', 3: 'T3', 4: 'T4' };

/** 待刷词分页（用户 2026-10-15：一次性全渲染几千行卡死首页，每页 100 词） */
const PAGE_SIZE = 100;

export default function TodayPage() {
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
  const [pool, setPool] = useState<BookWord[]>([]);
  const [total, setTotal] = useState(0);
  const [graduated, setGraduated] = useState(0);
  const [lemmaMap, setLemmaMap] = useState<Record<string, string>>({});
  const [poolError, setPoolError] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 考查制今日清单：与考查页同一套 selectQuizPool。回到本页（路由重挂载）即重算，
  // 所以在考查页练完/过关后回来，数字立刻反映最新状态。
  const loadPool = useCallback(async () => {
    if (!userId || !activeBookId) return;
    try {
      const repos = getRepos();
      const all = await repos.word.listBookWords(activeBookId);
      const { pool: p, total: t, graduated: g } = selectQuizPool(all);
      setPool(p);
      setTotal(t);
      setGraduated(g);
      setPage(1);
      setPoolError('');
    } catch (e) {
      setPoolError(e instanceof Error ? e.message : String(e));
    }
  }, [userId, activeBookId]);

  useEffect(() => {
    void loadPool();
  }, [loadPool]);

  const today = new Date().toISOString().slice(0, 10);
  const daysToExam = useMemo(() => diffDays(EXAM_DATE, today), [today]);
  const inSprint = activePlan ? today >= activePlan.sprintStartDate : false;

  const grouped = useMemo(() => {
    const g: Record<number, BookWord[]> = { 1: [], 2: [], 3: [], 4: [] };
    for (const bw of pool) g[bw.tier].push(bw);
    return g;
  }, [pool]);

  // 展示顺序 T4→T1 拉平后分页（用户 2026-10-15：一次全渲染几千行卡死，每页 100 词）
  const ordered = useMemo(() => [...grouped[4], ...grouped[3], ...grouped[2], ...grouped[1]], [grouped]);
  const pageCount = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => ordered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [ordered, safePage],
  );

  // 词义映射只取当前页的词（整池可达数千，一次全拉拖慢首屏）
  useEffect(() => {
    if (pageRows.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const ids = [...new Set(pageRows.map((bw) => bw.wordId))].filter((id) => !(id in lemmaMap));
        if (ids.length === 0) return;
        const words = await getRepos().word.listWordsByIds(ids);
        if (cancelled) return;
        setLemmaMap((m) => {
          const next = { ...m };
          for (const w of words) next[w.id] = w.lemma;
          return next;
        });
      } catch {
        // 词义拉取失败不阻断列表（行内回退显示 wordId）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageRows, lemmaMap]);

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
              开始学习
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
          {/* 计划概览（计划制的输入面板，保留；四标签可点，2026-10-15） */}
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

          {/* 考查制今日清单（用户 2026-10-15 拍板 A）：与考查页同一套规则 */}
          <Paper sx={{ mt: 2, p: 2 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="body1">
                阶段待完成 <strong>{pool.length}</strong> · 共 {total} 词 · 已毕业 {graduated}
              </Typography>
              <Button
                variant="contained"
                startIcon={<PlayArrowIcon />}
                onClick={() => navigate('/quiz')}
              >
                开始学习
              </Button>
            </Stack>
            {poolError && (
              <Alert severity="error" sx={{ mt: 1.5 }}>
                今日清单加载失败：{poolError}
              </Alert>
            )}
            {!poolError && pool.length === 0 && total > 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                今天该考的都过关了，明天再来。
              </Typography>
            )}
          </Paper>

          {/* 该考的词：分页展示（T4 最上；每页 100 词；换层时插层头） */}
          {ordered.length > 0 && (
            <Paper sx={{ mt: 2, p: 2 }}>
              {pageRows.map((bw, i) => {
                const prev = i > 0 ? pageRows[i - 1].tier : null;
                const showHeader = bw.tier !== prev;
                return (
                  <Box key={bw.id}>
                    {showHeader && (
                      <Stack direction="row" spacing={1} alignItems="center" py={1}>
                        <Chip
                          size="small"
                          color={bw.tier === 4 ? 'error' : bw.tier === 3 ? 'warning' : 'default'}
                          label={TIER_LABEL[bw.tier]}
                        />
                        <Typography variant="body2" color="text.secondary">
                          {grouped[bw.tier].length} 词该考
                        </Typography>
                      </Stack>
                    )}
                    <Stack divider={i > 0 && pageRows[i - 1].tier === bw.tier ? <Divider flexItem /> : undefined}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" py={0.75}>
                        <Box>
                          <Typography variant="body1" component="span">
                            {lemmaMap[bw.wordId] ?? bw.wordId}
                          </Typography>
                          {bw.specialTraining && (
                            <Chip size="small" color="error" variant="outlined" label="特种训练" sx={{ ml: 1 }} />
                          )}
                        </Box>
                        <Typography variant="caption" color="text.secondary">
                          {bw.lastQuizAt ? `上次考查 ${bw.lastQuizAt.slice(0, 10)}` : '首次考查'}
                        </Typography>
                      </Stack>
                    </Stack>
                  </Box>
                );
              })}
              {pageCount > 1 && (
                <Stack alignItems="center" sx={{ mt: 2 }}>
                  <Pagination
                    count={pageCount}
                    page={safePage}
                    onChange={(_, v) => setPage(v)}
                    showFirstButton
                    showLastButton
                  />
                </Stack>
              )}
            </Paper>
          )}

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
