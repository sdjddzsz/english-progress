/**
 * StudyPage.tsx —— 核心学习流（逐 hit）：
 * 视觉 hit：词形 → 回想 → 揭晓释义 → 反馈面板；听觉 hit：自动发音 → 回想 → 揭晓 → 反馈。
 * 每 hit 一条 Feedback（useFeedback）+ completeHit（hitRepo，失败自动入离线队列）。
 * 会话结束：endSession + SessionSummary。页面无调度逻辑。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import ReplayIcon from '@mui/icons-material/Replay';
import type { StudySession } from '../types/domain';
import { useAppStore } from '../store/useAppStore';
import { useFeedback } from '../hooks/useFeedback';
import type { FeedbackPanelSubmit } from '../components/feedback/FeedbackPanel';
import { useTTS } from '../hooks/useTTS';
import WordCard from '../components/word/WordCard';
import FeedbackPanel from '../components/feedback/FeedbackPanel';

export default function StudyPage() {
  const navigate = useNavigate();
  const { todayHits, wordMap, completeHit } = useAppStore();
  const { submit, startSession, finishSession } = useFeedback();
  const { speak } = useTTS();

  const pending = useMemo(() => todayHits.filter((h) => h.status === 'pending'), [todayHits]);

  const [session, setSession] = useState<StudySession | null>(null);
  const [idx, setIdx] = useState(0);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const hitStartRef = useRef<number>(performance.now());

  const current = pending[idx] ?? null;

  // 会话开始（有任务时）
  useEffect(() => {
    if (session || pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const id = await startSession('integrated');
        if (!cancelled) setSession({ id } as StudySession);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, pending.length, startSession]);

  // 每个 hit 开始：重置计时与揭晓态；听觉模态自动发音
  useEffect(() => {
    hitStartRef.current = performance.now();
    setReveal(false);
    if (current && current.modality === 'audio') {
      const w = wordMap[current.wordId];
      if (w) void speak({ text: w.lemma, ipa: w.ipa, arpabet: w.arpabet, mode: 'word' }, w.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const candidates = useMemo(
    () => [...new Set(todayHits.map((h) => h.wordId))].map((id) => ({ id, lemma: wordMap[id]?.lemma ?? id })),
    [todayHits, wordMap],
  );

  const handleSubmit = useCallback(
    async (input: FeedbackPanelSubmit) => {
      if (!current || !session) return;
      setBusy(true);
      setErr('');
      try {
        const reactionMs = performance.now() - hitStartRef.current;
        await submit(current, session.id, input, reactionMs);
        await completeHit(current.id);
        if (idx + 1 >= pending.length) {
          await finishSession(session.id, pending.length);
          navigate('/');
        } else {
          setIdx((i) => i + 1);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [current, session, idx, pending.length, submit, completeHit, finishSession, navigate],
  );

  // ===== 完成态 =====
  if (pending.length === 0) {
    return (
      <Box p={2}>
        <Paper sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="h6">今日队列已完成</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            可以去「训练」做听词联想 / 见中文联想英文，或回到 Today 看计划概况。
          </Typography>
          <Button variant="contained" sx={{ mt: 2 }} onClick={() => navigate('/')}>
            回 Today
          </Button>
        </Paper>
      </Box>
    );
  }
  if (!current) return null;

  const word = wordMap[current.wordId] ?? null;

  return (
    <Box p={2} pb={4}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="body2" color="text.secondary">
          {idx + 1} / {pending.length}
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          label={current.modality === 'audio' ? '听觉 hit' : '视觉 hit'}
        />
      </Stack>

      {err && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {err}
        </Alert>
      )}

      <Paper sx={{ mt: 2, p: 3 }}>
        <WordCard
          word={word}
          hideText={current.modality === 'audio' && !reveal}
          tier={current.tier}
          roundNo={current.roundNo}
          lastSeen={current.explain.lastSeen}
        />

        {!reveal && (
          <>
            <Divider sx={{ my: 2 }} />
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" color="text.secondary">
                先在心里回想词义，再揭晓作答。
              </Typography>
              <Button size="small" startIcon={<ReplayIcon />} onClick={() => void speak({ text: word?.lemma ?? '', ipa: word?.ipa, arpabet: word?.arpabet, mode: 'word' }, current.wordId)}>
                再听一次
              </Button>
            </Stack>
            <Button variant="contained" fullWidth sx={{ mt: 1.5 }} onClick={() => setReveal(true)}>
              揭晓释义
            </Button>
          </>
        )}

        {reveal && (
          <Box sx={{ mt: 2 }}>
            <FeedbackPanel candidates={candidates} onSubmit={(i) => void handleSubmit(i)} disabled={busy} />
            {busy && (
              <Stack direction="row" justifyContent="center" sx={{ mt: 1 }}>
                <CircularProgress size={20} />
              </Stack>
            )}
          </Box>
        )}
      </Paper>
    </Box>
  );
}
