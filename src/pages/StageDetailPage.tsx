/**
 * StageDetailPage —— 阶段词表（用户 2026-10-15 四阶段制）：
 * 某一阶段的词库列表（分页 100/页，T4 最上），每词标层/特训/上次考查；
 * 支持多选手动调阶段（联动：调阶后 stageStreak 清零，见 docs/联动清单.md）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { getRepos, useAppStore } from '../store/useAppStore';
import { STAGE_LABEL, STAGE_META, type WordStage } from '../features/quiz/stages';
import type { BookWord } from '../types/domain';

const PAGE_SIZE = 100;
const TIER_LABEL: Record<number, string> = { 1: 'T1', 2: 'T2', 3: 'T3', 4: 'T4' };

export default function StageDetailPage() {
  const { stage } = useParams();
  const stageNo = ([1, 2, 3, 4] as const).includes(Number(stage) as 1 | 2 | 3 | 4)
    ? (Number(stage) as 1 | 2 | 3 | 4)
    : null;
  const navigate = useNavigate();
  const { activeBookId } = useAppStore();

  const [rows, setRows] = useState<BookWord[]>([]);
  const [lemmaMap, setLemmaMap] = useState<Record<string, string>>({});
  const [graduatedCount, setGraduatedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<number>(1);
  const [moveBusy, setMoveBusy] = useState(false);

  const load = useCallback(async () => {
    if (!stageNo || !activeBookId) return;
    setLoading(true);
    try {
      const repos = getRepos();
      const all = await repos.word.listBookWords(activeBookId);
      setRows(all.filter((bw) => bw.stage === stageNo));
      setGraduatedCount(all.filter((bw) => bw.stage === 0).length);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [stageNo, activeBookId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 展示顺序 T4→T1；分页 100/页；词义只取当前页（同首页联动 #11）
  const ordered = useMemo(() => {
    const g: Record<number, BookWord[]> = { 1: [], 2: [], 3: [], 4: [] };
    for (const bw of rows) g[bw.tier].push(bw);
    return [...g[4], ...g[3], ...g[2], ...g[1]];
  }, [rows]);
  const pageCount = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => ordered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [ordered, safePage],
  );

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
      await load();
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
            disabled={ordered.length === 0}
            onClick={() => navigate(`/stage-quiz/${stageNo}`)}
          >
            开始刷（{ordered.length}）
          </Button>
        </Stack>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {meta.desc} · 本阶段词库 {rows.length} 词{stageNo !== 4 ? '' : '（写对一次即彻底毕业）'}
        {graduatedCount > 0 ? ` · 全书已彻底毕业 ${graduatedCount} 词` : ''}
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
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
                    {TIER_LABEL[bw.tier]} · 连 {bw.stageStreak}
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
                第 {safePage} / {pageCount} 页 · 共 {ordered.length} 词
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
