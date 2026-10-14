/**
 * SearchPage.tsx —— 全局词库搜索 + 单词详情（用户 2026-10-13：基础功能）。
 *
 * 背单词软件的底线功能，此前项目里**完全没有**（repo 层有 searchWordsByPrefix 但没有任何 UI 入口）：
 *  1. 输入前缀即时搜词（防抖，避免每敲一个字母打一次云请求）；
 *  2. 点结果进详情：全部义项（含每档读音）、词形变化、层级、收藏；
 *  3. 详情页可直接收藏进生词本 / 取消收藏。
 *
 * 数据经 getRepos()（src/data 边界内）；本页面不含调度逻辑。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import type { Word } from '../types/domain';
import { getRepos, useAppStore } from '../store/useAppStore';
import { describeSenses, hasMultiplePronunciations } from '../features/senses';
import { useTTS } from '../hooks/useTTS';

/** ECDICT exchange 的键 → 中文标签（背单词软件该有的词形变化展示） */
export const EXCHANGE_LABEL: Record<string, string> = {
  p: '过去式',
  d: '过去分词',
  i: '现在分词',
  '3': '三单',
  r: '比较级',
  t: '最高级',
  '0': '原形',
  '1': '原型变化',
  s: '复数',
};

/** 输入防抖：停止输入 N 毫秒后才发请求（避免每敲一个字母打一次云） */
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 30;

export default function SearchPage() {
  const navigate = useNavigate();
  const { userId, bootstrap } = useAppStore();
  const { speak } = useTTS();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Word[]>([]);
  const [selected, setSelected] = useState<Word | null>(null);
  const [starred, setStarred] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  /** 收藏状态批量读（详情页 + 结果列表打星） */
  const refreshStars = useCallback(
    async (ids: string[]) => {
      if (!userId || ids.length === 0) return;
      try {
        const set = await getRepos().word.listBookmarkedWordIds(userId, ids);
        setStarred(set);
      } catch {
        /* 收藏状态读失败不阻塞搜索（星标只是辅助信息） */
      }
    },
    [userId],
  );

  // 防抖搜索
  useEffect(() => {
    const q = query.trim();
    if (!userId) return;
    if (q === '') {
      setResults([]);
      setSelected(null);
      setSearched(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const rows = await getRepos().word.searchWordsByPrefix(q, SEARCH_LIMIT);
          if (cancelled) return;
          setResults(rows);
          setError('');
          setSearched(true);
          void refreshStars(rows.map((r) => r.id));
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setLoading(false);
    };
  }, [query, userId, refreshStars]);

  const toggleStar = useCallback(
    async (w: Word) => {
      if (!userId) return;
      const repos = getRepos();
      try {
        if (starred.has(w.id)) {
          await repos.word.removeBookmark(userId, w.id);
          setStarred((prev) => {
            const next = new Set(prev);
            next.delete(w.id);
            return next;
          });
        } else {
          await repos.word.addBookmark({
            userId,
            wordId: w.id,
            lemma: w.lemma,
            source: '搜索页',
            createdAt: new Date().toISOString(),
          });
          setStarred((prev) => new Set(prev).add(w.id));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [userId, starred],
  );

  const entries = useMemo(() => (selected ? describeSenses(selected) : []), [selected]);
  const multiPron = selected ? hasMultiplePronunciations(selected) : false;

  return (
    <Box p={2} pb={4}>
      <Typography variant="h5">查词</Typography>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 0.5 }}>
        <Typography variant="body2" color="text.secondary">
          输入词形开头即可查。点结果看全部义项与读音。
        </Typography>
        <Button size="small" startIcon={<StarIcon />} onClick={() => navigate('/bookmarks')}>
          生词本{starred.size > 0 ? `（${starred.size}）` : ''}
        </Button>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <TextField
        fullWidth
        size="small"
        sx={{ mt: 2 }}
        placeholder="输入单词，如 record"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
          endAdornment: loading ? (
            <InputAdornment position="end">
              <CircularProgress size={16} />
            </InputAdornment>
          ) : undefined,
        }}
      />

      {results.length > 0 && !selected && (
        <Paper variant="outlined" sx={{ mt: 2 }}>
          <Stack divider={<Divider flexItem />}>
            {results.map((w) => (
              <Stack
                key={w.id}
                direction="row"
                justifyContent="space-between"
                alignItems="center"
                sx={{ px: 1.5, py: 1, cursor: 'pointer' }}
                onClick={() => {
                  setSelected(w);
                  void refreshStars([w.id]);
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body1">{w.lemma}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    /{w.ipa.replace(/^\/|\/$/g, '')}/ {w.senses[0]?.slice(0, 30)}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.5} alignItems="center">
                  {hasMultiplePronunciations(w) && (
                    <Chip size="small" variant="outlined" label={`${describeSenses(w).length} 读音`} />
                  )}
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleStar(w);
                    }}
                    aria-label="star"
                  >
                    {starred.has(w.id) ? <StarIcon fontSize="small" color="warning" /> : <StarBorderIcon fontSize="small" />}
                  </IconButton>
                </Stack>
              </Stack>
            ))}
          </Stack>
        </Paper>
      )}

      {searched && !loading && results.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          没找到以「{query.trim()}」开头的词。
        </Typography>
      )}

      {selected && (
        <Paper sx={{ mt: 2, p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
            <Box>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="h5">{selected.lemma}</Typography>
                <Typography variant="body1" color="text.secondary">
                  /{selected.ipa.replace(/^\/|\/$/g, '')}/
                </Typography>
                {multiPron && <Chip size="small" color="warning" label={`${entries.length} 种读音/词性`} />}
                {selected.tags.length > 0 && (
                  <Chip size="small" variant="outlined" label={selected.tags.join(' / ')} />
                )}
              </Stack>
            </Box>
            <Stack direction="row" spacing={0.5}>
              <Tooltip title="发音">
                <IconButton
                  onClick={() =>
                    void speak(
                      {
                        text: selected.lemma,
                        ipa: selected.ipa,
                        arpabet: selected.arpabet,
                        mode: 'word',
                      },
                      selected.id,
                    )
                  }
                >
                  <VolumeUpIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title={starred.has(selected.id) ? '从生词本移除' : '加入生词本'}>
                <IconButton onClick={() => void toggleStar(selected)} aria-label="toggle bookmark">
                  {starred.has(selected.id) ? (
                    <StarIcon color="warning" />
                  ) : (
                    <StarBorderIcon />
                  )}
                </IconButton>
              </Tooltip>
            </Stack>
          </Stack>

          <Typography variant="subtitle2" sx={{ mt: 2 }}>
            释义与读音（{entries.length} 个义项）
          </Typography>
          <Stack spacing={0.5} sx={{ mt: 0.5 }}>
            {entries.map(({ sense: s, label }, i) => (
              <Stack key={s.senseId} direction="row" spacing={1} alignItems="baseline">
                <Typography variant="body2" color="text.secondary" sx={{ minWidth: 26 }}>
                  {i + 1}.
                </Typography>
                <Typography variant="body2" sx={{ flex: 1 }}>
                  {/* 词性显式标注（用户 2026-10-14）：同一单词不同义项词性可能不同 */}
                  {s.pos ? `${s.pos} ${s.zh}`.trim() : s.zh}
                </Typography>
                <Typography
                  variant="caption"
                  color={multiPron ? 'warning.dark' : 'text.secondary'}
                  sx={{ whiteSpace: 'nowrap' }}
                >
                  {label}
                </Typography>
                <IconButton
                  size="small"
                  onClick={() =>
                    void speak({ text: s.lemma, ipa: s.ipa, arpabet: s.arpabet, mode: 'word' }, s.senseId)
                  }
                  aria-label={`play sense ${i + 1}`}
                >
                  <VolumeUpIcon fontSize="small" />
                </IconButton>
              </Stack>
            ))}
          </Stack>

          {selected.exchange && Object.keys(selected.exchange).length > 0 && (
            <>
              <Typography variant="subtitle2" sx={{ mt: 2 }}>
                词形变化
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                {Object.entries(selected.exchange).map(([k, v]) => (
                  <Chip
                    key={k}
                    size="small"
                    variant="outlined"
                    label={`${EXCHANGE_LABEL[k] ?? k}：${v.replace(/\//g, ' / ')}`}
                  />
                ))}
              </Stack>
            </>
          )}

          {selected.examples.length > 0 && (
            <>
              <Typography variant="subtitle2" sx={{ mt: 2 }}>
                例句
              </Typography>
              {selected.examples.map((ex, i) => (
                <Box key={i} sx={{ mt: 0.5, pl: 1, borderLeft: 3, borderColor: 'divider' }}>
                  <Typography variant="body2">{ex.en}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {ex.zh}
                  </Typography>
                </Box>
              ))}
            </>
          )}

          <Button sx={{ mt: 2 }} onClick={() => setSelected(null)}>
            返回结果
          </Button>
        </Paper>
      )}
    </Box>
  );
}
