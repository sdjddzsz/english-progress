/**
 * WordNoteButton.tsx —— 题旁笔记按钮 + 编辑弹窗（用户 2026-10-17）。
 *
 * 一词一记（noteRepo 确定性 id）：点开即加载该词已有笔记；保存 = 覆盖；
 * 有笔记时图标高亮，一眼看出这个词记过东西。
 * 支持离线兜底：写失败时提示（不阻断答题，runOrQueue 语义太重，笔记低频可直写）。
 */
import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import EditNoteIcon from '@mui/icons-material/EditNote';
import { getRepos, useAppStore } from '../../store/useAppStore';
import type { WordNote } from '../../types/domain';

interface Props {
  wordId: string;
  lemma: string;
  /** 来源：quiz:1 / stage-quiz:2 / manual … */
  source: string;
  senseIndex?: number;
  size?: 'small' | 'medium';
}

export default function WordNoteButton({ wordId, lemma, source, senseIndex, size = 'small' }: Props) {
  const userId = useAppStore((s) => s.userId);
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [existing, setExisting] = useState<WordNote | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 每次换词清「已存笔记」状态（图标高亮按当前词的实际存储来）
  useEffect(() => {
    setExisting(null);
  }, [wordId]);

  const openDialog = async (): Promise<void> => {
    if (!userId) return;
    setOpen(true);
    setError('');
    setLoading(true);
    try {
      const note = await getRepos().note.getNote(userId, wordId);
      setExisting(note);
      setContent(note?.content ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!userId) return;
    setSaving(true);
    setError('');
    try {
      const note = await getRepos().note.saveNote({
        userId,
        wordId,
        lemma,
        content,
        source,
        ...(senseIndex != null ? { senseIndex } : {}),
      });
      setExisting(note);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!userId) return;
    setSaving(true);
    setError('');
    try {
      await getRepos().note.removeNote(userId, wordId);
      setExisting(null);
      setContent('');
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const hasNote = existing != null && existing.content !== '';

  return (
    <>
      <Tooltip title={hasNote ? '查看/编辑笔记' : '记笔记'}>
        <span>
          <IconButton
            size={size}
            aria-label={`note ${lemma}`}
            disabled={!userId}
            onClick={() => void openDialog()}
            sx={hasNote ? { color: 'warning.main' } : undefined}
          >
            <EditNoteIcon fontSize={size === 'small' ? 'small' : 'inherit'} />
          </IconButton>
        </span>
      </Tooltip>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>「{lemma}」的笔记</DialogTitle>
        <DialogContent>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
              {error}
            </Alert>
          )}
          {loading ? (
            <CircularProgress size={22} sx={{ my: 2 }} />
          ) : (
            <TextField
              autoFocus
              fullWidth
              multiline
              minRows={5}
              placeholder="记点什么：用法、例句、易混点、自己的记忆线索……"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              sx={{ mt: 1 }}
            />
          )}
        </DialogContent>
        <DialogActions>
          {hasNote && (
            <Button color="error" disabled={saving || loading} onClick={() => void remove()}>
              删除笔记
            </Button>
          )}
          <Button disabled={saving || loading} onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="contained" disabled={saving || loading || content.trim() === ''} onClick={() => void save()}>
            {saving ? <CircularProgress size={18} /> : '保存'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
