/**
 * StageDetailPage —— 阶段词表（用户 2026-10-15 四阶段制）：
 * 某一阶段的词库列表（分页 100/页，T4 最上），每词标层/特训/上次考查；
 * 支持多选手动调阶段（联动：调阶后 stageStreak 清零，见 docs/联动清单.md）。
 *
 * 数据链路（用户 2026-10-22 改）：**服务端 stage 过滤 + 服务端分页 + 计数**。
 * 旧实现拉整本 8296 行（9 个串行分页请求）再客户端按 stage 过滤，慢网络下
 * 体感「词表打不开」；现在一页 = 1 次计数 + 1 次取页（整页 3 次请求）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import { getRepos, useAppStore } from '../store/useAppStore';
import { STAGE_LABEL, STAGE_META, TIER_VERDICT_LABEL, type WordStage } from '../features/quiz/stages';
import type { BookWord } from '../types/domain';

const PAGE_SIZE = 100;

export default function StageDetailPage() {
  const { stage } = useParams();
  const stageNo = ([1, 2, 3, 4] as const).includes(Number(stage) as 1 | 2 | 3 | 4)
    ? (Number(stage) as 1 | 2 | 3 | 4)
    : null;
  const navigate = useNavigate();
  const { activeBookId } = useAppStore();

  // total = 本阶段词库总量（服务端计数）；rows = 当前页的 100 行（服务端分页）
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<BookWord[]>([]);
  const [lemmaMap, setLemmaMap] = useState<Record<string, string>>({});
  const [graduatedCount, setGraduatedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  /** 调阶后强制刷新当前页（safePage 不变时也要重取） */
  const [reloadKey, setReloadKey] = useState(0);
  /** 计数是否已到达（用 ref：页面效果据此决定何时关转圈，放进 deps 会多发一次取页请求） */
  const countsLoadedRef = useRef(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<number>(1);
  const [moveBusy, setMoveBusy] = useState(false);

  // 计数（本阶段总量 + 已彻底毕业量）：挂载/换阶段/换书/调阶后刷新
  const loadCounts = useCallback(async () => {
    if (!stageNo || !activeBookId) return;
    try {
      const repos = getRepos();
      const [n, graduated] = await Promise.all([
        repos.word.countBookWordsByStage(activeBookId, stageNo),
        repos.word.countBookWordsByStage(activeBookId, 0),
      ]);
      setTotal(n);
      setGraduatedCount(graduated);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      countsLoadedRef.current = true;
      setLoading(false);
    }
  }, [stageNo, activeBookId]);

  useEffect(() => {
    if (!stageNo || !activeBookId) {
      // 无词书/未知阶段：不再留无限转圈，直接给可操作提示（旧实现这里早返回，
      // loading 永远停在 true——用户看到的就是「打不开」）
      setLoading(false);
      if (!activeBookId) setError('还没有选择词书');
      return;
    }
    setLoading(true);
    countsLoadedRef.current = false;
    void loadCounts();
  }, [stageNo, activeBookId, loadCounts]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const ordered = useMemo(() => rows, [rows]);
  const pageRows = ordered;

  // 调阶后总量变小 ⇒ page 越界时收敛回第 1 页（不收敛的话「上一页」要连点两次）
  useEffect(() => {
    if (total > 0 && page > Math.ceil(total / PAGE_SIZE)) setPage(1);
  }, [total, page]);

  // 当前页行：safePage 变化即取（counts 到达后的收敛也在内）
  useEffect(() => {
    if (!stageNo || !activeBookId) return;
    let cancelled = false;
    void (async () => {
      try {
        const pageRowsFetched = await getRepos().word.listBookWordsPage(activeBookId, {
          stage: stageNo,
          offset: (safePage - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
        });
        if (cancelled) return;
        setRows(pageRowsFetched);
        setError('');
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        // 计数也到达了才关转圈（计数通常比取页慢，等它以免头部闪「0 词」）
        if (!cancelled && countsLoadedRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stageNo, activeBookId, safePage, reloadKey]);

  // 词义映射只取当前页（同首页联动 #11）
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
        // 词义拉取失败不阻断列表
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageRows, lemmaMap]);

  const toggle = (id: string): void =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const moveSelected = async (): Promise<void> => {
    if (!stageNo || selected.size === 0) return;
    setMoveBusy(true);
    try {
      await getRepos().word.updateWordStages(
        [...selected].map((id) => ({ bookWordId: id, stage: moveTarget as WordStage })),
      );
      setSelected(new Set());
      setMoveOpen(false);
      // 计数 + 当前页一起刷新（移走后总量/本页内容都变了）
      await loadCounts();
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMoveBusy(false);
    }
  };

  if (!stageNo) {
    return (
      <Box p={2}>
        <Alert severity="error">未知阶段：{stage}</Alert>
      </Box>
    );
  }
  const meta = STAGE_META[stageNo];

  return (
    <Box p={2} pb={4}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="h5">{meta.name}</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={() => navigate('/')}>
            回总览
          </Button>
          <Button
            variant="contained"
            startIcon={<PlayArrowIcon />}
            disabled={total === 0}
            onClick={() => navigate(stageNo === 1 ? '/quiz' : `/stage-quiz/${stageNo}`)}
          >
            开始刷（{total}）
          </Button>
        </Stack>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {meta.desc} · 本阶段词库 {total} 词{stageNo !== 4 ? '' : '（写对一次即彻底毕业）'}
        {graduatedCount > 0 ? ` · 全书已彻底毕业 ${graduatedCount} 词` : ''}
      </Typography>
      {!activeBookId ? (
        <Alert
          severity="info"
          sx={{ mt: 2 }}
          action={
            <Button color="inherit" size="small" startIcon={<MenuBookIcon />} onClick={() => navigate('/book')}>
              去词书页
            </Button>
          }
        >
          还没有选择词书——先到「词书」页选一本，阶段词表才有内容。
        </Alert>
      ) : (
        error && (
          <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )
      )}

      {/* 多选调阶段工具条 */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
        <Button
          size="small"
          variant="outlined"
          onClick={() =>
            setSelected((s) => (s.size === pageRows.length ? new Set() : new Set(pageRows.map((bw) => bw.id))))
          }
        >
          {selected.size === pageRows.length && pageRows.length > 0 ? '取消全选（本页）' : '全选（本页）'}
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={selected.size === 0}
          onClick={() => setMoveOpen(true)}
        >
          调整所选 {selected.size} 词的阶段
        </Button>
        {selected.size > 0 && (
          <Typography variant="caption" color="text.secondary">
            调阶后该词连续熟练清零、按新阶段重新计
          </Typography>
        )}
      </Stack>

      {loading ? (
        <Box textAlign="center" py={4}>
          <CircularProgress />
        </Box>
      ) : (
        <Paper sx={{ mt: 2, p: 2 }}>
          <Stack divider={<Divider flexItem />}>
            {pageRows.map((bw) => (
              <Stack key={bw.id} direction="row" alignItems="center" spacing={1} py={0.75}>
                <Checkbox size="small" checked={selected.has(bw.id)} onChange={() => toggle(bw.id)} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="body1" component="span">
                    {lemmaMap[bw.wordId] ?? bw.wordId}
                  </Typography>
                  {bw.specialTraining && (
                    <Chip size="small" color="error" variant="outlined" label="特训" sx={{ ml: 1 }} />
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                    {TIER_VERDICT_LABEL[bw.tier]} · 连 {bw.stageStreak}
                    {bw.lastQuizAt ? ` · 上次 ${bw.lastQuizAt.slice(0, 10)}` : ' · 未考过'}
                  </Typography>
                </Box>
                <Chip size="small" variant="outlined" label={STAGE_LABEL[bw.stage]} />
              </Stack>
            ))}
            {pageRows.length === 0 && (
              <Typography variant="body2" color="text.secondary" py={3} textAlign="center">
                本阶段暂无词。
              </Typography>
            )}
          </Stack>
          {pageCount > 1 && (
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" py={1}>
              <Button size="small" variant="outlined" disabled={safePage <= 1} onClick={() => setPage((p) => p - 1)}>
                上一页
              </Button>
              <Typography variant="caption" color="text.secondary">
                第 {safePage} / {pageCount} 页 · 共 {total} 词
              </Typography>
              <Button
                size="small"
                variant="outlined"
                disabled={safePage >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </Button>
            </Stack>
          )}
        </Paper>
      )}

      {/* 调阶段弹窗 */}
      {moveOpen && (
        <Box component="div" sx={{ mt: 2 }}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="body1">把所选 {selected.size} 词移到：</Typography>
            <TextField
              select
              fullWidth
              size="small"
              value={moveTarget}
              onChange={(e) => setMoveTarget(Number(e.target.value))}
              sx={{ mt: 1 }}
            >
              <MenuItem value={1}>阶段一 · 由词选义</MenuItem>
              <MenuItem value={2}>阶段二 · 由义选词</MenuItem>
              <MenuItem value={3}>阶段三 · 听音选词</MenuItem>
              <MenuItem value={4}>阶段四 · 听词拼写</MenuItem>
            </TextField>
            <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 2 }}>
              <Button variant="text" onClick={() => setMoveOpen(false)} disabled={moveBusy}>
                取消
              </Button>
              <Button variant="contained" onClick={() => void moveSelected()} disabled={moveBusy}>
                {moveBusy ? '移动中…' : '确认移动'}
              </Button>
            </Stack>
          </Paper>
        </Box>
      )}
    </Box>
  );
}
