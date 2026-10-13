/**
 * BookPage.tsx —— 词书页（PRD §5.2.3）：
 * 词书列表 / 设为当前 / 难度层分布视图 / List 内词表浏览。
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
  Divider,
  FormControlLabel,
  Paper,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import type { Book, BookWord, Tier, Word } from '../types/domain';
import { TIERS } from '../scheduler';
import { getRepos, useAppStore } from '../store/useAppStore';
import {
  getSeedCursor,
  rebuildWordBook,
  seedLibraryToCloud,
  type SeedCursor,
  type SeedProgress,
} from '../data/seedBootstrap';

const TIER_LABEL: Record<Tier, string> = { 1: 'T1 已掌握', 2: 'T2 熟词', 3: 'T3 半熟', 4: 'T4 生词' };

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
  const [tier, setTier] = useState<Tier>(3);
  const [bookWords, setBookWords] = useState<BookWord[]>([]);
  const [wordMap, setWordMap] = useState<Record<string, Word>>({});
  const [loadingWords, setLoadingWords] = useState(false);
  const [error, setError] = useState('');
  const [seedProgress, setSeedProgress] = useState<SeedProgress | null>(null);
  const [seedError, setSeedError] = useState('');
  /** 重建模式：删旧书再导新种子（幂等初始化不会覆盖已存在的书，必须显式重建） */
  const [rebuild, setRebuild] = useState(false);
  /** 各层真实词量（用于分层分布展示；与难度层 Tab 独立，切换 Tab 不影响它） */
  const [tierStats, setTierStats] = useState<{ tier: Tier; count: number }[]>(
    TIERS.map((t) => ({ tier: t, count: 0 })),
  );
  // 断点续传游标（本机 localStorage，**按当前登录用户隔离**）：
  // 必须与 seedLibraryToCloud 用同一个 userId 拼 key，否则 UI 提示会与实际续传点不一致。
  const [seedCursor, setSeedCursor] = useState<SeedCursor | null>(() => getSeedCursor(userId));

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

  const loadTier = useCallback(async (bookId: string, t: Tier) => {
    setLoadingWords(true);
    setError('');
    try {
      const repos = getRepos();
      const bws = await repos.word.listBookWords(bookId, { tier: t });
      const words = await repos.word.listWordsByIds(bws.slice(0, 50).map((b) => b.wordId));
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

  useEffect(() => {
    if (selectedBookId) void loadTier(selectedBookId, tier);
  }, [selectedBookId, tier, loadTier]);

  // 各层词量：全书只读一次（listBookWords 无 tier 过滤），切 Tab 不重复拉
  useEffect(() => {
    if (!selectedBookId) return;
    let cancelled = false;
    void (async () => {
      try {
        const all = await getRepos().word.listBookWords(selectedBookId);
        if (cancelled) return;
        const counts = new Map<Tier, number>();
        for (const bw of all) counts.set(bw.tier, (counts.get(bw.tier) ?? 0) + 1);
        setTierStats(TIERS.map((t) => ({ tier: t, count: counts.get(t) ?? 0 })));
      } catch {
        if (!cancelled) setTierStats(TIERS.map((t) => ({ tier: t, count: 0 })));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedBookId]);

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
            导入后所有词一律记为 T4 生词 —— 掌握程度只由你的练习成绩决定，不再按词频猜。
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
                onClick={() => setSelectedBookId(b.id)}
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

          {/* 难度层视图 */}
          {selectedBook && (
            <Paper sx={{ mt: 2, p: 2 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="h6">难度层视图</Typography>
                <Button size="small" variant="outlined" onClick={() => navigate('/plan-editor')}>
                  计划编辑
                </Button>
              </Stack>
              {/* 各层真实词量：分层是「练习成绩」判定的结果，必须随时可见，
                  否则用户只能看到"某个 Tab 空了"，看不到整体分布 */}
              <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                {tierStats.map((s) => (
                  <Chip
                    key={s.tier}
                    size="small"
                    variant="outlined"
                    color={s.tier === 4 ? 'error' : s.tier === 3 ? 'warning' : 'default'}
                    label={`${TIER_LABEL[s.tier]} ${s.count}`}
                  />
                ))}
                <Chip size="small" label={`共 ${selectedBook.wordCount} 词`} />
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                新导入的词一律记为 T4 生词；层只按你的练习成绩升降（连续秒认升层、答错降层），不按词频猜。
              </Typography>
              <Tabs value={tier} onChange={(_, v: Tier) => setTier(v)} sx={{ mt: 1 }}>
                {TIERS.map((t) => (
                  <Tab
                    key={t}
                    value={t}
                    label={`${TIER_LABEL[t]} ${tierStats.find((s) => s.tier === t)?.count ?? 0}`}
                  />
                ))}
              </Tabs>
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
                  {bookWords.slice(0, 50).map((bw) => (
                    <Stack key={bw.id} direction="row" justifyContent="space-between" py={0.75}>
                      <Box>
                        <Typography variant="body1" component="span">
                          {wordMap[bw.wordId]?.lemma ?? bw.wordId}
                        </Typography>
                        {wordMap[bw.wordId]?.ipa && (
                          <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                            /{wordMap[bw.wordId].ipa}/
                          </Typography>
                        )}
                      </Box>
                      <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                        List {bw.listNo + 1} · {wordMap[bw.wordId]?.senses[0]?.slice(0, 18) ?? ''}
                      </Typography>
                    </Stack>
                  ))}
                  {bookWords.length === 0 && (
                    <Typography variant="body2" color="text.secondary" py={2} textAlign="center">
                      该层暂无词。
                    </Typography>
                  )}
                  {bookWords.length > 50 && (
                    <Typography variant="caption" color="text.secondary" py={1}>
                      仅显示前 50 词（共 {bookWords.length}）。
                    </Typography>
                  )}
                </Stack>
              )}
            </Paper>
          )}
        </>
      )}
    </Box>
  );
}
