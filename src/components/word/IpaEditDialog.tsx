/**
 * IpaEditDialog.tsx —— 长按音标弹出的「编辑读音」弹窗（用户 2026-10-24：
 * 词书里 fine 的音标是错的，要能就地修）。
 *
 * 为什么不是一个输入框的事：IPA 只是**展示层**，合成音频的真源是 ARPAbet
 * （DashScope 主轨 <phoneme alphabet="cmu">；Azure 轨才用 IPA）。只改 IPA 不改
 * ARPAbet，显示修好了、发音还是旧的那一版（fine 三个义项正是两边都错）。
 * 所以本弹窗只让用户改 IPA，ARPAbet 由 `ipaToArpabet` 逆向派生，派生结果明示在
 * 弹窗里；pronunciationKey 随新 ARPAbet 重算（读音分组的影响也明示）。
 *
 * 写路径与 SenseEditDialog 完全相同：wordRepo.updateWordSenses 整行 upsert
 * （words 表 RLS 只放行 insert 通道，单 PATCH 会被拒）。
 */
import { useEffect, useMemo, useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import { getRepos } from '../../store/useAppStore';
import { applySensePronEdit, applyWordPronEdit, normalizeSenses } from '../../features/senses';
import { ipaToArpabet } from '../../tts/arpabetToIpa';
import { stripIpaSlashes } from '../../tts/ipaMap';
import { useTTS } from '../../hooks/useTTS';
import type { Word } from '../../types/domain';

interface Props {
  word: Word | null;
  /** sense 模式：编辑第几个义项；word 模式忽略 */
  senseIndex: number | null;
  /** sense=长按某条义项的音标；word=长按词级音标（默认 sense） */
  mode?: 'sense' | 'word';
  onClose: () => void;
  /** 保存成功后把新 Word 回传（调用方换掉内存里的旧对象，界面立即刷新） */
  onSaved: (word: Word) => void;
}

export default function IpaEditDialog({ word, senseIndex, mode = 'sense', onClose, onSaved }: Props) {
  const { speak, loading } = useTTS();
  const isWordMode = mode === 'word';
  // 没有义项级读音数据的老词（sensesDetail 缺失）：义项是 normalizeSenses 合成出来的，
  // 按义项写会把扁平 senses 写丢——自动降级为词级编辑（弹窗内明示）。
  const hasDetail = Boolean(word?.sensesDetail && word.sensesDetail.length > 0);
  const useSense = !isWordMode && senseIndex !== null && hasDetail;
  const open = word !== null && (useSense || isWordMode);

  const senses = word ? normalizeSenses(word) : [];
  const sense = useSense && senseIndex !== null ? senses[senseIndex] : undefined;
  const currentIpa = useSense ? (sense?.ipa ?? '') : (word?.ipa ?? '');

  const [ipa, setIpa] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 每次打开重新装填（弹窗复用同一实例）
  useEffect(() => {
    if (!open) return;
    setIpa(currentIpa);
    setError('');
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, word?.id, senseIndex, mode, currentIpa]);

  /** IPA → ARPAbet 派生预览：用户边打字边看到合成会用什么音素 */
  const derived = useMemo(() => {
    const stripped = stripIpaSlashes(ipa);
    if (!stripped) return { arpabet: '', err: '' };
    try {
      return { arpabet: ipaToArpabet(stripped), err: '' };
    } catch (e) {
      return { arpabet: '', err: e instanceof Error ? e.message : String(e) };
    }
  }, [ipa]);

  /** 同词还有几个义项与目标义项同属一档读音（改动后分组会按新值重算） */
  const samePronCount = useMemo(() => {
    if (!useSense || !sense) return 0;
    return senses.filter((s) => s.senseId !== sense.senseId && s.pronunciationKey === sense.pronunciationKey)
      .length;
  }, [useSense, sense, senses]);

  const save = async (): Promise<void> => {
    if (!word) return;
    const stripped = stripIpaSlashes(ipa);
    if (!stripped) {
      setError('音标不能为空');
      return;
    }
    if (!derived.arpabet) {
      setError(`音标里有无法合成的字符：${derived.err.replace('ipaToArpabet: ', '')}`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      // 存储口径与种子一致：带斜杠
      const patch = { ipa: `/${stripped}/`, arpabet: derived.arpabet };
      const next = useSense
        ? applySensePronEdit(word, senseIndex as number, patch)
        : applyWordPronEdit(word, patch);
      await getRepos().word.updateWordSenses(next);
      onSaved(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const trial = (): void => {
    const stripped = stripIpaSlashes(ipa);
    if (!word || !stripped || !derived.arpabet) return;
    void speak(
      { text: word.lemma, ipa: `/${stripped}/`, arpabet: derived.arpabet, mode: 'word' },
      sense?.senseId ?? word.id,
    );
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>
        编辑读音 · {word?.lemma ?? ''}
        {useSense && senses.length > 1 ? `（第 ${(senseIndex ?? 0) + 1} / ${senses.length} 个义项）` : ''}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          {!isWordMode && !hasDetail && (
            <Alert severity="info">该词没有义项级读音数据，本次改的是词级读音。</Alert>
          )}
          <TextField
            label="音标（IPA）"
            size="small"
            value={ipa}
            onChange={(e) => setIpa(e.target.value)}
            placeholder="/ˈfaɪn/（斜杠可省）"
            error={Boolean(derived.err)}
            helperText={
              derived.err
                ? `无法合成：${derived.err.replace('ipaToArpabet: unsupported character ', '不认识的字符 ')}`
                : derived.arpabet
                  ? `合成音素（ARPAbet）：${derived.arpabet}`
                  : '输入音标后自动推导合成音素'
            }
          />
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              size="small"
              startIcon={<VolumeUpIcon />}
              disabled={!derived.arpabet || loading}
              onClick={trial}
            >
              试听
            </Button>
            <Typography variant="caption" color="text.secondary">
              先试听确认无误，再保存。
            </Typography>
          </Stack>
          {useSense ? (
            <Typography variant="caption" color="text.secondary">
              读音是判定「是不是同一个词」的依据：改动后该义项的读音分组按新值重算
              {samePronCount > 0 ? `（当前还有 ${samePronCount} 个义项与它同档）` : ''}；
              已记录的学习进度挂在义项上，不受影响。词级音标只在首义项改动时跟随同步。
            </Typography>
          ) : (
            <Typography variant="caption" color="text.secondary">
              词级音标用于列表展示与兜底合成；考查 / 背词页按各义项自己的读音显示——
              义项读音不对，请在考查页或背词卡里长按那一条音标来改。
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between', px: 3, pb: 2 }}>
        <span />
        <Stack direction="row" spacing={1}>
          <Button size="small" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button size="small" variant="contained" disabled={saving || !derived.arpabet} onClick={() => void save()}>
            保存
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
