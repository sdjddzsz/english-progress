/**
 * SenseEditDialog.tsx —— 长按某条释义弹出的「编辑/删除义项」弹窗（用户 2026-10-18）；
 * 2026-10-19：同一弹窗承担「新增词义」（mode="add"）——释义列表旁的「+ 增加词义」按钮打开。
 * 改动经 features/senses 的纯函数同步词级字段，再走 wordRepo.updateWordSenses 整行 upsert
 * （words 表 RLS 只放行 insert 通道，单 PATCH 会被拒）。删除最后一个义项会被拒绝。
 */
import { useEffect, useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import { getRepos } from '../../store/useAppStore';
import { applySenseAdd, applySenseDelete, applySenseEdit, normalizeSenses } from '../../features/senses';
import type { Word } from '../../types/domain';

interface Props {
  word: Word | null;
  /** edit 模式：编辑第几个义项；add 模式忽略（传 null 即可） */
  senseIndex: number | null;
  /** edit=长按释义编辑/删除；add=新增词义（默认 edit） */
  mode?: 'edit' | 'add';
  onClose: () => void;
  /** 保存/删除成功后把新 Word 回传（调用方换掉内存里的旧对象，界面立即刷新） */
  onSaved: (word: Word) => void;
}

export default function SenseEditDialog({ word, senseIndex, mode = 'edit', onClose, onSaved }: Props) {
  const isAdd = mode === 'add';
  const open = isAdd ? word !== null : word !== null && senseIndex !== null;
  const senses = word ? normalizeSenses(word) : [];
  const sense = !isAdd && open && senseIndex !== null ? senses[senseIndex] : undefined;

  const [pos, setPos] = useState('');
  const [zh, setZh] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');

  // 每次打开重新装填（弹窗复用同一实例）：
  // edit 装当前义项；add 预填首义项词性（补的释义多为同词性）、释义留空给用户填
  useEffect(() => {
    if (!open || !word) return;
    if (isAdd) {
      setPos(senses[0]?.pos ?? '');
      setZh('');
    } else if (sense) {
      setPos(sense.pos);
      setZh(sense.zh);
    }
    setError('');
    setConfirmingDelete(false);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isAdd, senseIndex, sense?.senseId]);

  const save = async (): Promise<void> => {
    if (!word || (!isAdd && senseIndex === null)) return;
    if (!zh.trim()) {
      setError('释义不能为空');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const patch = { pos: pos.trim(), zh: zh.trim() };
      const next = isAdd ? applySenseAdd(word, patch) : applySenseEdit(word, senseIndex as number, patch);
      await getRepos().word.updateWordSenses(next);
      onSaved(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!word || senseIndex === null) return;
    const next = applySenseDelete(word, senseIndex);
    if (!next) {
      setError('至少保留一个义项，不能删空');
      setConfirmingDelete(false);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await getRepos().word.updateWordSenses(next);
      onSaved(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>
        {isAdd ? '新增词义 ' : '编辑义项 '}
        {word?.lemma ?? ''}
        {!isAdd && senses.length > 1 ? `（第 ${(senseIndex ?? 0) + 1} / ${senses.length} 个）` : ''}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="词性"
            size="small"
            value={pos}
            onChange={(e) => setPos(e.target.value)}
            placeholder="n. / vt. / a. …（可留空）"
          />
          <TextField
            label="中文释义"
            size="small"
            multiline
            minRows={2}
            value={zh}
            onChange={(e) => setZh(e.target.value)}
          />
          {isAdd ? (
            <Typography variant="caption" color="text.secondary">
              新义项追加在最后，读音跟随本词默认读音；保存后直接写回词书（下次出题/其它设备都能看到）。
            </Typography>
          ) : (
            <Typography variant="caption" color="text.secondary">
              读音字段不在这里改——读音是判定「是不是同一个词」的身份，改了会动调度。读音不对请用「重新合成」。
            </Typography>
          )}
          {!isAdd && senses.length <= 1 && (
            <Typography variant="caption" color="text.secondary">
              该词只有这一个义项，删除会被拒绝（词不能没有释义）。
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between', px: 3, pb: 2 }}>
        {!isAdd &&
          (confirmingDelete ? (
            <Stack direction="row" spacing={1}>
              <Button size="small" color="error" variant="contained" disabled={saving} onClick={() => void remove()}>
                确认删除
              </Button>
              <Button size="small" onClick={() => setConfirmingDelete(false)} disabled={saving}>
                再想想
              </Button>
            </Stack>
          ) : (
            <Button size="small" color="error" disabled={saving || senses.length <= 1} onClick={() => setConfirmingDelete(true)}>
              删除该义项
            </Button>
          ))}
        <Stack direction="row" spacing={1}>
          <Button size="small" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button size="small" variant="contained" disabled={saving} onClick={() => void save()}>
            保存
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
