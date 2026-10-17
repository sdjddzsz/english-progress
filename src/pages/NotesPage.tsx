/**
 * NotesPage.tsx —— 笔记页（用户 2026-10-17：笔记有专门页面查看）。
 *
 * 全部笔记按更新时间倒序平铺；顶部搜索框按词形/内容实时过滤；
 * 点开弹窗编辑（同 WordNoteButton 的弹窗交互：保存=覆盖、可删除）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import InputAdornment from '@mui/material/InputAdornment';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SearchIcon from '@mui/icons-material/Search';
import { getRepos, useAppStore } from '../store/useAppStore';
import type { WordNote } from '../types/domain';

export default function NotesPage() {
  const userId = useAppStore((s) => s.userId);
  const [notes, setNotes] = useState<WordNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  /** 正在编辑的笔记（null=弹窗关） */
  const [editing, setEditing] = useState<WordNote | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError('');
    try {
      setNotes(await getRepos().note.listNotes(userId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return notes;
    return notes.filter((n) => n.lemma.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
  }, [notes, query]);

  const saveEdit = async (): Promise<void> => {
    if (!editing || !userId) return;
    setSaving(true);
    setError('');
    try {
      const content = draft.trim();
      if (content === '') {
        await getRepos().note.removeNote(userId, editing.wordId);
      } else {
        await getRepos().note.saveNote({
          userId,
          wordId: editing.wordId,
          lemma: editing.lemma,
          content,
          source: editing.source,
          ...(editing.senseIndex != null ? { senseIndex: editing.senseIndex } : {}),
        });
      }
      setEditing(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box p={2} pb={4} maxWidth={720} mx="auto">
      <Typography variant="h5">笔记</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        考查页/训练页里点笔记图标记下的内容都在这里；按更新时间倒序。
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <TextField
        fullWidth
        size="small"
        sx={{ mt: 2 }}
        placeholder="搜词形或笔记内容…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
        }}
      />

      {loading ? (
        <Stack alignItems="center" sx={{ mt: 6 }}>
          <CircularProgress />
        </Stack>
      ) : filtered.length === 0 ? (
        <Paper sx={{ mt: 3, p: 3, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            {notes.length === 0 ? '还没有笔记——做题时点笔记图标就能记。' : '没有匹配的笔记。'}
          </Typography>
        </Paper>
      ) : (
        <Stack spacing={1.5} sx={{ mt: 2 }}>
          {filtered.map((n) => (
            <Paper key={n.id} sx={{ p: 2 }}>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Typography variant="subtitle1">{n.lemma}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {n.updatedAt.slice(0, 10)} · 来自 {n.source}
                </Typography>
              </Stack>
              <Typography
                variant="body2"
                sx={{ mt: 1, whiteSpace: 'pre-wrap', color: 'text.primary' }}
              >
                {n.content}
              </Typography>
              <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(n);
                    setDraft(n.content);
                  }}
                >
                  编辑
                </Button>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      <Dialog open={editing != null} onClose={() => setEditing(null)} fullWidth maxWidth="sm">
        <DialogTitle>「{editing?.lemma ?? ''}」的笔记</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={5}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button disabled={saving} onClick={() => setEditing(null)}>
            取消
          </Button>
          <Button variant="contained" disabled={saving} onClick={() => void saveEdit()}>
            {saving ? <CircularProgress size={18} /> : '保存（清空即删除）'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
