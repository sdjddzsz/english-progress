/**
 * BookPage.tsx —— 词书页（PRD §5.2.3）：
 * 词书列表 / 设为当前 / 词库平铺浏览（阶段+四档标注）/ List 内词表浏览。
 * 导入入口在 T05 批次开放；页内无调度逻辑，数据经 getRepos()（src/data 边界内）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import type { Book, BookWord, Word } from '../types/domain';
import { clearSession } from '../features/quiz/session';
import { STAGE_LABEL, STAGE_META, TIER_VERDICT_LABEL, type WordStage } from '../features/quiz/stages';
import { getRepos, useAppStore } from '../store/useAppStore';
import {
  getSeedCursor,
  rebuildWordBook,
  seedLibraryToCloud,
  type SeedCursor,
  type SeedProgress,
} from '../data/seedBootstrap';

/** 词表浏览分页大小：词条释义按页拉取，避免一次拉全书 8296 条 */
const PAGE_SIZE = 50;

const STEP_LABEL: Record<SeedProgress['step'], string> = {
  fetching: '下载词库数据…',
  words: '导入词条',
  book_words: '建立词书关联',
  book: '创建词书',
  done: '完成',
};

export default function BookPage() {
  const navigate = useNavigate();
  // storeError：云请求失败（如 403 / 超时）时由 store 写入，页面顶部可见，不再白屏或转圈
  const { books, activeBookId, setActiveBook, bootstrap, loading, error: storeError, userId } = useAppStore();

  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [bookWords, setBookWords] = useState<BookWord[]>([]);
  const [wordMap, setWordMap] = useState<Record<string, Word>>({});
  const [loadingWords, setLoadingWords] = useState(false);
  const [error, setError] = useState('');
  const [seedProgress, setSeedProgress] = useState<SeedProgress | null>(null);
  const [seedError, setSeedError] = useState('');
  /** 重建模式：删旧书再导新种子（幂等初始化不会覆盖已存在的书，必须显式重建） */
  const [rebuild, setRebuild] = useState(false);
  // 断点续传游标（本机 localStorage，**按当前登录用户隔离**）：
  // 必须与 seedLibraryToCloud 用同一个 userId 拼 key，否则 UI 提示会与实际续传点不一致。
  const [seedCursor, setSeedCursor] = useState<SeedCursor | null>(() => getSeedCursor(userId));
  // 多选调阶段（用户 2026-10-15 四阶段制：词库每词标阶段，可多选手动调整）
  const [stageSel, setStageSel] = useState<Set<string>>(new Set());
  const [stageMoveOpen, setStageMoveOpen] = useState(false);
  const [stageMoveTarget, setStageMoveTarget] = useState<number>(1);
  const [stageMoveBusy, setStageMoveBusy] = useState(false);
  const runSeed = useCallback(async () => {
    const { userId: uid } = useAppStore.getState();
    if (!uid) {
      setSeedError('尚未登录，无法初始化词库。');
      return;
    }
    setSeedError('');
    setSeedProgress({ step: 'fetching', done: 0, total: 0 });
    try {
      // rebuild=1 时显式重建：已存在的词书不会被普通初始化覆盖（幂等设计），
      // 换种子版本后必须走这条路径，否则用户永远看不到新词书。
      const result = rebuild
        ? await rebuildWordBook(uid, (p) => setSeedProgress(p))
        : await seedLibraryToCloud(uid, (p) => setSeedProgress(p));
      // ⚠ 必须 force：bootstrap 首次完成后会短路，普通调用不会重新拉词书列表（新词书就不会出现）
      await bootstrap({ force: true });
      if (!result.skipped) {
        setSelectedBookId(result.bookId);
      }
    } catch (e) {
      setSeedError(e instanceof Error ? e.message : String(e));
    } finally {
      setSeedProgress(null);
      // 用与导入同一个 uid 读回，保证读写同一 key
      setSeedCursor(getSeedCursor(uid));
    }
  }, [bootstrap, rebuild]);

  // userId 变化（登录完成 / 切换账号）后重读游标：游标按用户隔离，换账号必须换提示
  useEffect(() => {
    setSeedCursor(getSeedCursor(userId));
  }, [userId]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!selectedBookId && books.length > 0) setSelectedBookId(activeBookId ?? books[0].id);
  }, [books, activeBookId, selectedBookId]);

  const loadWords = useCallback(async (bookId: string, p: number) => {
    setLoadingWords(true);
    setError('');
    try {
      const repos = getRepos();
      // 全词库一次拉齐（8296 行量级，listAll 分页；T1~T4 旧标签已清除，不再按层过滤）
      const bws = await repos.word.listBookWords(bookId);
      // 词条按当前页拉取（用户 2026-10-15：要能翻页浏览全部单词，不再截断在前 50）
      const start = (p - 1) * PAGE_SIZE;
      const pageBws = bws.slice(start, start + PAGE_SIZE);
      const words = await repos.word.listWordsByIds(pageBws.map((b) => b.wordId));
      const map: Record<string, Word> = {};
      for (const w of words) map[w.id] = w;
      setBookWords(bws);
      setWordMap(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingWords(false);
    }
  }, []);
  /** 多选调阶段：批量写 stage（stageStreak 清零，按新阶段重新计连击） */
  const moveStageSelected = useCallback(async () => {
    if (stageSel.size === 0) return;
    setStageMoveBusy(true);
    setError('');
    try {
      await getRepos().word.updateWordStages(
        [...stageSel].map((id) => ({ bookWordId: id, stage: stageMoveTarget as WordStage })),
      );
      setStageSel(new Set());
      setStageMoveOpen(false);
      if (selectedBookId) await loadWords(selectedBookId, page);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStageMoveBusy(false);
    }
  }, [stageSel, stageMoveTarget, selectedBookId, page, loadWords]);


  useEffect(() => {
    if (selectedBookId) void loadWords(selectedBookId, page);
  }, [selectedBookId, page, loadWords]);

  // 进度重置（用户 2026-10-15）：单词级 / 全局。confirmTarget=null 关闭弹窗。
  const [confirmTarget, setConfirmTarget] = useState<'all' | BookWord | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState('');

  const doReset = useCallback(async () => {
    if (!confirmTarget || !selectedBookId) return;
    setResetting(true);
    setResetMsg('');
    try {
      const repos = getRepos();
      if (confirmTarget === 'all') {
        const n = await repos.word.resetAllQuizProgress(selectedBookId);
        setResetMsg(n === 0 ? '没有找到有进度痕迹的词，无需重置。' : `已重置 ${n} 个词的考查进度（全部回阶段一）。`);
      } else {
        await repos.word.resetQuizProgress(confirmTarget.id);
        setResetMsg(`已重置「${wordMap[confirmTarget.wordId]?.lemma ?? confirmTarget.wordId}」。`);
      }
      // 当天的考查会话快照一并作废（用户 2026-10-15：重置进度后，回到考查页不能
      // 还恢复旧的队列与判定——那批词的进度已清，快照留着就是"保留进度"）。
      const { userId: uid } = useAppStore.getState();
      if (uid) clearSession(uid, selectedBookId);
      // 旧计划制的任务与欠账一并清（用户 2026-10-15 联动：重置进度后欠账必须归零——
      // 欠账来自 hits 表的 pending 记录，不清的话重置完「欠账 N 条」原样还在）。
      // 全局重置清整个计划的未完成 hits；单词级只清该词的。
      // 加固（2026-10-15）：不依赖 store 内存里的 activePlan（可能为 null → 整块被
      // 静默跳过，欠账 296 残留事故），重置时按 bookId 现查一次。
      const plan = await repos.plan.getActivePlan(selectedBookId);
      if (plan) {
        const allHits = await repos.hit.hits.listAll([
          { column: 'planId', op: 'eq', value: plan.id },
        ]);
        const wordScope = confirmTarget === 'all' ? null : confirmTarget.wordId;
        const stale = allHits.filter(
          (h) => h.status !== 'done' && (wordScope ? h.wordId === wordScope : true),
        );
        if (stale.length > 0) {
          const nowIso = new Date().toISOString();
          await repos.hit.upsertHits(
            stale.map((h) => ({ ...h, status: 'done', completedAt: nowIso })),
          );
        }
      }
      setConfirmTarget(null);
      // 重置后刷新词库（进度痕迹清零、阶段回一）
      if (selectedBookId) void loadWords(selectedBookId, page);
      // store 立即重算欠账/今日队列，回到阶段页不再显示旧欠账
      await useAppStore.getState().refreshToday();
    } catch (e) {
      setResetMsg(`重置失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResetting(false);
    }
  }, [confirmTarget, selectedBookId, page, loadWords]);

  const selectedBook: Book | null = books.find((b) => b.id === selectedBookId) ?? null;

  // 断点续传提示（本机游标）：最后一处未完成进度；无中断则空串
  const resumeHint = !seedCursor
    ? ''
    : seedCursor.words < seedCursor.totalWords
      ? `上次导入中断于 ${seedCursor.words}/${seedCursor.totalWords}（词条），点击继续`
      : seedCursor.bookWords < seedCursor.totalBookWords
        ? `上次导入中断于 ${seedCursor.bookWords}/${seedCursor.totalBookWords}（词书关联），点击继续`
        : '';

  if (loading && books.length === 0) {
    return (
      <Box p={6} textAlign="center">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box p={2} pb={4}>
      <Typography variant="h5">词书</Typography>

      {storeError && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {storeError}
        </Alert>
      )}

      {books.length === 0 ? (
        <Paper sx={{ mt: 2, p: 3 }}>
          <Typography variant="body1">还没有词书</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            首次使用：一键导入 ECDICT 六级词库（8296 词：全部六级词 + 四级/考研/雅思高频词；含音标、多读音、全部词性释义、词形变化），需联网，约 1 分钟。
            导入后所有词从「生词」档、阶段一开始；四档只随练习成绩升降，不按词频猜。
          </Typography>
          {resumeHint && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {resumeHint}
            </Typography>
          )}
          <Button
            variant="contained"
            sx={{ mt: 2 }}
            disabled={seedProgress !== null}
            onClick={() => void runSeed()}
          >
            初始化六级词库
          </Button>
          {seedProgress && (
            <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={20} />
              <Typography variant="body2">
                {STEP_LABEL[seedProgress.step]}
                {seedProgress.total > 0 && ` ${seedProgress.done}/${seedProgress.total}`}
              </Typography>
            </Box>
          )}
          {seedError && (
            <Typography variant="body2" color="error" sx={{ mt: 1 }}>
              初始化失败：{seedError}（可重试：已导入的部分会保留，从断点继续）
            </Typography>
          )}
        </Paper>
      ) : (
        <>
          {/* 重建入口：换种子版本后必须显式重建（普通初始化对已存在的书是幂等跳过） */}
          <Paper variant="outlined" sx={{ mt: 2, p: 1.5 }}>
            <FormControlLabel
              control={<Checkbox checked={rebuild} onChange={(e) => setRebuild(e.target.checked)} />}
              label={
                <Typography variant="body2">
                  重建词书（删掉当前这本再按最新词库导入；删除前会自动备份分层快照）
                </Typography>
              }
            />
            {rebuild && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                会删除当前词书的词条与分层（先备份到 tier_snapshots），然后导入最新词库。
                已产生的学习记录（hits / 反馈）保留 —— 新词库是旧词库的超集，不会产生孤儿记录。
              </Alert>
            )}
            <Button
              variant={rebuild ? 'contained' : 'outlined'}
              color={rebuild ? 'warning' : 'primary'}
              sx={{ mt: 1 }}
              disabled={seedProgress !== null}
              onClick={() => void runSeed()}
            >
              {rebuild ? '确认重建词书' : '重新导入词库'}
            </Button>
            {seedError && (
              <Typography variant="body2" color="error" sx={{ mt: 1 }}>
                失败：{seedError}
              </Typography>
            )}
          </Paper>

          {/* 词书列表 */}
          <Stack spacing={1} sx={{ mt: 2 }}>
            {books.map((b) => (
              <Paper
                key={b.id}
                variant="outlined"
                sx={{ p: 1.5, borderColor: b.id === selectedBookId ? 'primary.main' : 'divider' }}
                onClick={() => {
                  setSelectedBookId(b.id);
                  setPage(1); // 换书回到第一页，避免页码越界
                }}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Box>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="body1">{b.name}</Typography>
                      {b.id === activeBookId && <Chip size="small" color="primary" label="当前" />}
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {b.wordCount} 词 · {b.listSize} 词/List · 来源 {b.source}
                    </Typography>
                  </Box>
                  {b.id !== activeBookId && (
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={(e) => {
                        e.stopPropagation();
                        void setActiveBook(b.id);
                      }}
                    >
                      设为当前
                    </Button>
                  )}
                </Stack>
              </Paper>
            ))}
          </Stack>

          {/* 词库（用户 2026-10-15：T1~T4 旧标签随改版失效已清除，改为四档+阶段标注的平铺词表） */}
          {selectedBook && (
            <Paper sx={{ mt: 2, p: 2 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="h6">词库</Typography>
                <Stack direction="row" spacing={1}>
                  <Button size="small" variant="outlined" onClick={() => navigate('/plan-editor')}>
                    计划编辑
                  </Button>
                  {/* 全局重置（用户 2026-10-15：进度坏完了清除重来）——带确认 */}
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    startIcon={<RestartAltIcon />}
                    onClick={() => setConfirmTarget('all')}
                  >
                    重置全部进度
                  </Button>
                </Stack>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                共 {selectedBook.wordCount} 词。每词标当前阶段与四档（熟练/认识/不熟/生词，按练习成绩升降）；
                四档只作展示与排序，不搞自测评分。
              </Typography>
              {/* 多选调阶段工具条（用户 2026-10-15 四阶段制） */}
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => {
                    const pageIds = bookWords.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((bw) => bw.id);
                    setStageSel((s) => (pageIds.every((id) => s.has(id)) ? new Set() : new Set(pageIds)));
                  }}
                >
                  {stageSel.size > 0 ? `已选 ${stageSel.size} 词` : '勾选词条'}
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  disabled={stageSel.size === 0}
                  onClick={() => setStageMoveOpen(true)}
                >
                  调整所选词的阶段
                </Button>
              </Stack>
              {error && (
                <Typography variant="body2" color="error" sx={{ mt: 1 }}>
                  {error}
                </Typography>
              )}
              {loadingWords ? (
                <Box textAlign="center" py={3}>
                  <CircularProgress size={24} />
                </Box>
              ) : (
                <Stack divider={<Divider flexItem />}>
                  {bookWords.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((bw) => {
                    const lemma = wordMap[bw.wordId]?.lemma ?? bw.wordId;
                    const ipa = wordMap[bw.wordId]?.ipa;
                    const sense = (wordMap[bw.wordId]?.senses[0] ?? '').replace(/\s+/g, ' ');
                    return (
                    <Stack key={bw.id} direction="row" alignItems="center" spacing={0.5} py={0.75}>
                      <Checkbox
                        size="small"
                        checked={stageSel.has(bw.id)}
                        onChange={() =>
                          setStageSel((s) => {
                            const next = new Set(s);
                            if (next.has(bw.id)) next.delete(bw.id);
                            else next.add(bw.id);
                            return next;
                          })
                        }
                      />
                      {/* 左：词 + 音标（同一行内联，caption 必须 component="span"，否则块级换行） */}
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Box component="span">
                          <Typography variant="body1" component="span">
                            {lemma}
                          </Typography>
                          {ipa && (
                            <Typography variant="caption" color="text.secondary" component="span" sx={{ ml: 0.5 }}>
                              /{ipa}/
                            </Typography>
                          )}
                        </Box>
                        <Box component="span" sx={{ display: 'block' }}>
                          <Typography variant="caption" color="text.secondary" component="span">
                            {bw.specialTraining && (
                              <Chip size="small" color="error" variant="outlined" label="特训" sx={{ mr: 0.5 }} />
                            )}
                            {STAGE_LABEL[bw.stage]} · {TIER_VERDICT_LABEL[bw.tier]} · 连 {bw.stageStreak}
                            {bw.lastQuizAt ? ` · 上次 ${bw.lastQuizAt.slice(0, 10)}` : ' · 未考过'}
                          </Typography>
                        </Box>
                      </Box>
                      {/* 右：List 号 + 首义（截断）+ 行内重置 */}
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
                        <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 160 }}>
                          List {bw.listNo + 1}
                          {sense ? ` · ${sense.slice(0, 14)}` : ''}
                        </Typography>
                        <Tooltip title="重置这个词的考查进度（回阶段一、记录清零）">
                          <IconButton
                            size="small"
                            aria-label={`reset ${lemma}`}
                            onClick={() => setConfirmTarget(bw)}
                          >
                            <RestartAltIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </Stack>
                    );
                  })}
                  {bookWords.length === 0 && (
                    <Typography variant="body2" color="text.secondary" py={2} textAlign="center">
                      词库里暂无词。
                    </Typography>
                  )}
                  {bookWords.length > PAGE_SIZE && (
                    <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" py={1}>
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={page <= 1 || loadingWords}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                      >
                        上一页
                      </Button>
                      <Typography variant="caption" color="text.secondary">
                        第 {page} / {Math.ceil(bookWords.length / PAGE_SIZE)} 页 · 共 {bookWords.length} 词
                      </Typography>
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={page >= Math.ceil(bookWords.length / PAGE_SIZE) || loadingWords}
                        onClick={() => setPage((p) => Math.min(Math.ceil(bookWords.length / PAGE_SIZE), p + 1))}
                      >
                        下一页
                      </Button>
                    </Stack>
                  )}
                </Stack>
              )}
            </Paper>
          )}

          {/* 重置进度确认（危险操作：不可撤销，须显式确认） */}
          <Dialog open={confirmTarget !== null} onClose={() => (resetting ? undefined : setConfirmTarget(null))} maxWidth="xs" fullWidth>
            <DialogTitle>重置考查进度？</DialogTitle>
            <DialogContent>
              <Typography variant="body2">
                {confirmTarget === 'all'
                  ? '将把当前词书**全部**有进度记录的词重置：阶段回阶段一、四档回生词、连击/特种训练/上次考查记录全部清零。此操作不可撤销。'
                  : `将重置「${wordMap[(confirmTarget as BookWord | null)?.wordId ?? '']?.lemma ?? ''}」：阶段回阶段一、考查记录清零。此操作不可撤销。`}
              </Typography>
              {resetMsg && (
                <Alert severity="info" sx={{ mt: 1.5 }}>
                  {resetMsg}
                </Alert>
              )}
            </DialogContent>
            <DialogActions>
              <Button disabled={resetting} onClick={() => setConfirmTarget(null)}>
                取消
              </Button>
              <Button disabled={resetting} variant="contained" color="error" onClick={() => void doReset()}>
                {resetting ? <CircularProgress size={18} /> : '确认重置'}
              </Button>
            </DialogActions>
          </Dialog>

          {/* 多选调阶段弹窗（四阶段制：调阶后 stageStreak 清零，按新阶段重新计） */}
          <Dialog open={stageMoveOpen} onClose={() => (stageMoveBusy ? undefined : setStageMoveOpen(false))} maxWidth="xs" fullWidth>
            <DialogTitle>调整 {stageSel.size} 个词的阶段</DialogTitle>
            <DialogContent>
              <TextField
                select
                fullWidth
                size="small"
                value={stageMoveTarget}
                onChange={(e) => setStageMoveTarget(Number(e.target.value))}
                sx={{ mt: 1 }}
              >
                <MenuItem value={1}>{STAGE_META[1].name}</MenuItem>
                <MenuItem value={2}>{STAGE_META[2].name}</MenuItem>
                <MenuItem value={3}>{STAGE_META[3].name}</MenuItem>
                <MenuItem value={4}>{STAGE_META[4].name}</MenuItem>
              </TextField>
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                调阶后该词的连续熟练清零，按新阶段重新计。
              </Typography>
            </DialogContent>
            <DialogActions>
              <Button disabled={stageMoveBusy} onClick={() => setStageMoveOpen(false)}>
                取消
              </Button>
              <Button disabled={stageMoveBusy} variant="contained" onClick={() => void moveStageSelected()}>
                {stageMoveBusy ? <CircularProgress size={18} /> : '确认移动'}
              </Button>
            </DialogActions>
          </Dialog>
        </>
      )}
    </Box>
  );
}
