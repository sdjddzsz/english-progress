/**
 * BookPage.tsx —— 词书页（PRD §5.2.3）：
 * 词书列表 / 设为当前 / 难度层分布视图 / List 内词表浏览。
 * 导入入口在 T05 批次开放；页内无调度逻辑，数据经 getRepos()（src/data 边界内）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import type { Book, BookWord, Tier, Word } from '../types/domain';
import { TIERS } from '../scheduler';
import { getRepos, useAppStore } from '../store/useAppStore';

const TIER_LABEL: Record<Tier, string> = { 1: 'T1 已掌握', 2: 'T2 熟词', 3: 'T3 半熟', 4: 'T4 生词' };

export default function BookPage() {
  const navigate = useNavigate();
  const { books, activeBookId, setActiveBook, bootstrap, loading } = useAppStore();

  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [tier, setTier] = useState<Tier>(3);
  const [bookWords, setBookWords] = useState<BookWord[]>([]);
  const [wordMap, setWordMap] = useState<Record<string, Word>>({});
  const [loadingWords, setLoadingWords] = useState(false);
  const [error, setError] = useState('');

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

  const selectedBook: Book | null = books.find((b) => b.id === selectedBookId) ?? null;

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

      {books.length === 0 ? (
        <Paper sx={{ mt: 2, p: 3 }}>
          <Typography variant="body1">还没有词书</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            样例种子（60 词）与 ECDICT 全量导入将在 T05 批次接入部署流程。
          </Typography>
        </Paper>
      ) : (
        <>
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
              <Tabs value={tier} onChange={(_, v: Tier) => setTier(v)} sx={{ mt: 1 }}>
                {TIERS.map((t) => (
                  <Tab key={t} value={t} label={TIER_LABEL[t]} />
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
