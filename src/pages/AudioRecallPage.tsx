/**
 * AudioRecallPage.tsx —— 听词联想（PRD §4.5）：
 * 听发音 → 回想词义 → L1 三键单选即跳（无确认按钮）；犹豫超 3 秒（AUDIO_RECALL_TIMEOUT_MS）
 * 自动记"没想起"；作答后揭晓词形与释义，再进下一个。
 * 目标词 = 今日队列中听觉模态 hit（空则退化为全部今日 hit）；每词反馈挂在其当日 hit 上。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import type { L1State } from '../types/domain';
import { AUDIO_RECALL_TIMEOUT_MS } from '../config/constants';
import { useAppStore } from '../store/useAppStore';
import { useFeedback } from '../hooks/useFeedback';
import { useTTS } from '../hooks/useTTS';

interface Item {
  hitId: string;
  wordId: string;
  lemma: string;
  ipa: string;
  senses: string[];
}

export default function AudioRecallPage() {
  const navigate = useNavigate();
  const { todayHits, wordMap } = useAppStore();
  const { submit, startSession } = useFeedback();
  const { speak } = useTTS();

  const items = useMemo<Item[]>(() => {
    const audioHits = todayHits.filter((h) => h.modality === 'audio');
    const pool = audioHits.length > 0 ? audioHits : todayHits;
    const seen = new Set<string>();
    const out: Item[] = [];
    for (const h of pool) {
      if (seen.has(h.wordId)) continue;
      seen.add(h.wordId);
      const w = wordMap[h.wordId];
      out.push({
        hitId: h.id,
        wordId: h.wordId,
        lemma: w?.lemma ?? h.wordId,
        ipa: w?.ipa ?? '',
        senses: w?.senses ?? [],
      });
    }
    return out;
  }, [todayHits, wordMap]);

  const [idx, setIdx] = useState(0);
  const [answered, setAnswered] = useState<L1State | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const startRef = useRef(performance.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const current = items[idx] ?? null;

  const answer = useCallback(
    async (l1: L1State) => {
      if (!current || answered) return;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setAnswered(l1);
      setBusy(true);
      try {
        // 会话惰性创建：训练流独立于背词会话
        if (!sessionIdRef.current) {
          sessionIdRef.current = await startSession('vocab_audio');
        }
        const hit = todayHits.find((h) => h.id === current.hitId);
        if (hit) {
          await submit(
            hit,
            sessionIdRef.current,
            { l1State: l1, l2Tags: l1 === 'unknown' ? ['听不出这个词'] : [] },
            performance.now() - startRef.current,
          );
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, answered, todayHits, submit, startSession],
  );

  // 每词开始：计时 + 自动发音 + 3 秒超时自动"没想起"（单选即跳语义）
  useEffect(() => {
    if (!current) return;
    startRef.current = performance.now();
    setAnswered(null);
    void speak({ text: current.lemma, ipa: current.ipa, mode: 'word' }, current.wordId);
    timerRef.current = setTimeout(() => {
      void answer('unknown');
    }, AUDIO_RECALL_TIMEOUT_MS);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.wordId]);

  const next = () => setIdx((i) => i + 1);

  if (items.length === 0) {
    return (
      <Box p={2}>
        <Paper sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="h6">今日没有可练的队列词</Typography>
          <Button variant="contained" sx={{ mt: 2 }} onClick={() => navigate('/')}>
            回 Today
          </Button>
        </Paper>
      </Box>
    );
  }
  if (!current) {
    return (
      <Box p={2}>
        <Paper sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="h6">听词联想完成（{items.length} 词）</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            反应慢的词已带标签记录，明日队列会自动照顾它们。
          </Typography>
          <Button variant="contained" sx={{ mt: 2 }} onClick={() => navigate('/training')}>
            回训练
          </Button>
        </Paper>
      </Box>
    );
  }

  return (
    <Box p={2} pb={4}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h6">听词联想</Typography>
        <Typography variant="body2" color="text.secondary">
          {idx + 1} / {items.length}
        </Typography>
      </Stack>

      {err && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {err}
        </Alert>
      )}

      <Paper sx={{ mt: 2, p: 3, textAlign: 'center' }}>
        <Chip icon={<VolumeUpIcon />} label="听发音，回想词义" variant="outlined" />
        <Box sx={{ mt: 2 }}>
          <Button size="small" onClick={() => void speak({ text: current.lemma, ipa: current.ipa, mode: 'word' }, current.wordId)}>
            再听一次
          </Button>
        </Box>

        {!answered ? (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              3 秒内没反应自动记"没想起"；点选即跳下一词。
            </Typography>
            <Stack direction="row" spacing={1} justifyContent="center" sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
              <Button variant="contained" color="success" disabled={busy} onClick={() => void answer('instant')}>
                秒想起
              </Button>
              <Button variant="contained" disabled={busy} onClick={() => void answer('recognized')}>
                想起了（有点慢）
              </Button>
              <Button variant="contained" color="error" disabled={busy} onClick={() => void answer('unknown')}>
                没想起
              </Button>
              {busy && <CircularProgress size={22} sx={{ alignSelf: 'center' }} />}
            </Stack>
          </>
        ) : (
          <>
            <Typography variant="h4" sx={{ mt: 2 }}>
              {current.lemma}
            </Typography>
            {current.ipa && <Typography variant="body1" color="text.secondary">/{current.ipa}/</Typography>}
            <Stack sx={{ mt: 1 }} spacing={0.5}>
              {current.senses.slice(0, 2).map((s, i) => (
                <Typography key={i} variant="body1">
                  {i + 1}. {s}
                </Typography>
              ))}
            </Stack>
            <Button variant="contained" fullWidth sx={{ mt: 2 }} onClick={next}>
              下一词
            </Button>
          </>
        )}
      </Paper>
    </Box>
  );
}
