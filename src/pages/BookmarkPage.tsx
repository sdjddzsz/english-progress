/**
 * BookmarkPage.tsx —— 生词本 / 收藏（用户 2026-10-13：基础功能）。
 *
 * 背单词软件的基本盘：把「我标记过的重要词」单独收起来随时翻、可清空、可单独练。
 * 此前项目里 star 只作为反馈标签存在（L3 'star'），**没有任何存储和查看入口** ——
 * 标了等于没标。这一页把它变成真的东西。
 *
 * 附带「只练生词本」：直接进视觉背词流，词源 = 生词本，而不是今日队列。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import type { Word, WordBookmark } from '../types/domain';
import { getRepos, useAppStore } from '../store/useAppStore';
import { describeSenses, hasMultiplePronunciations } from '../features/senses';
import { useTTS } from '../hooks/useTTS';

export default function BookmarkPage() {
  const navigate = useNavigate();
  const { userId, bootstrap } = useAppStore();
  const { speak } = useTTS();

  const [rows, setRows] = useState<WordBookmark[]>([]);
  const [words, setWords] = useState<Record<string, Word>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError('');
    try {
      const repos = getRepos();
      const list = await repos.word.listBookmarks(userId);
      setRows(list);
      const ids = list.map((r) => r.wordId);
      // 走仓库已有的分片读（7000 词规模下 id=in.(…) 必须分片）
      const fetched = await repos.word.listWordsByIds(ids);
      const map: Record<string, Word> = {};
      for (const w of fetched) map[w.id] = w;
      setWords(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = useCallback(
    async (wordId: string) => {
      if (!userId) return;
      try {
        await getRepos().word.removeBookmark(userId, wordId);
        setRows((prev) => prev.filter((r) => r.wordId !== wordId));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [userId],
  );

  if (loading && rows.length === 0) {
    return (
      <Box p={6} textAlign="center">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box p={2} pb={4}>
      <Typography variant="h5">生词本</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        在查词页或练习里点星标收进来的词，共 {rows.length} 个。
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {rows.length === 0 ? (
        <Paper sx={{ mt: 2, p: 3 }}>
          <Typography variant="body1">还没有收藏的词</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            去「查词」搜一个词，点星标就能收进来。
          </Typography>
          <Button variant="contained" sx={{ mt: 2 }} onClick={() => navigate('/search')}>
            去查词
          </Button>
        </Paper>
      ) : (
        <Paper sx={{ mt: 2 }}>
          <Stack divider={<Divider flexItem />}>
            {rows.map((r) => {
              const w = words[r.wordId];
              const entries = w ? describeSenses(w) : [];
              return (
                <Stack key={r.id} direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 1.5, py: 1 }}>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography variant="body1">{r.lemma}</Typography>
                      {w && (
                        <Typography variant="caption" color="text.secondary">
                          /{w.ipa.replace(/^\/|\/$/g, '')}/
                        </Typography>
                      )}
                      {w && hasMultiplePronunciations(w) && (
                        <Chip size="small" color="warning" variant="outlined" label={`${entries.length} 读音`} />
                      )}
                    </Stack>
                    <Typography variant="caption" color="text.secondary" component="div" noWrap>
                      {w ? entries.map((e) => e.sense.zh).filter(Boolean).join(' / ') : r.wordId}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={0.5}>
                    {w && (
                      <IconButton
                        size="small"
                        onClick={() =>
                          void speak(
                            { text: w.lemma, ipa: w.ipa, arpabet: w.arpabet, mode: 'word' },
                            w.id,
                          )
                        }
                        aria-label="play"
                      >
                        <VolumeUpIcon fontSize="small" />
                      </IconButton>
                    )}
                    <IconButton size="small" onClick={() => void remove(r.wordId)} aria-label="remove">
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                </Stack>
              );
            })}
          </Stack>
        </Paper>
      )}
    </Box>
  );
}

/** 供路由复用的入口说明（只练生词本的跳转目标） */
export const BOOKMARK_PRACTICE_HINT = '生词本可单独练：进「查词」逐词过，或在练习中标记星标';
export { PlayArrowIcon };
