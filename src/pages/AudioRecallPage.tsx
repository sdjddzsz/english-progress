/**
 * AudioRecallPage.tsx —— 听词联想（PRD §4.5）：
 * 听发音 → 回想词义 → 三键单选 → 作答后揭晓词形与释义，再进下一个。
 *
 * ⚠ 用户 2026-10-13：「哪怕同一个单词只要不同读音对应不同意思，就当成不同的单词判定」。
 *   因此本练习的**判定单位是义项（senseId）而非单词**：
 *   多读音词（record 名词 /ˈrekəd/ vs 动词 /rɪˈkɔːd/）会被拆成多个练习项，
 *   每项播自己的读音、揭晓自己的那一组释义，各自独立记一条反馈。
 *   界面上必须提前标出「本词有 N 种读音，现在放的是哪一种」，否则用户无法预期答案。
 *
 * 目标词 = 今日队列中听觉模态 hit（空则退化为全部今日 hit）。
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
import { normalizeSenses } from '../features/senses';
import type { WordSense } from '../types/domain';

interface Item {
  hitId: string;
  wordId: string;
  lemma: string;
  /** 本次练习针对的义项（判定单位） */
  sense: WordSense;
  senses: WordSense[];
  /** 该词共有几种读音（>1 需在界面上明确标出） */
  pronunciationCount: number;
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
      const w = wordMap[h.wordId];
      if (!w) continue;
      const senses = normalizeSenses(w);
      // 按**读音**去重：同一读音的多个词性合并成一项（用户定义：不同读音才算不同的单词）
      const byPron = new Map<string, WordSense[]>();
      for (const s of senses) {
        const key = s.pronunciationKey;
        const arr = byPron.get(key) ?? [];
        arr.push(s);
        byPron.set(key, arr);
      }
      const distinct = byPron.size;
      for (const group of byPron.values()) {
        const primary = group[0];
        const senseId = `${primary.senseId}_audio`;
        if (seen.has(senseId)) continue;
        seen.add(senseId);
        out.push({
          hitId: h.id,
          wordId: h.wordId,
          lemma: w.lemma,
          sense: {
            ...primary,
            senseId,
            zh: group.map((g) => (g.pos ? `${g.pos} ${g.zh}`.trim() : g.zh || g.pos)).filter(Boolean).join(' / '),
          },
          senses,
          pronunciationCount: distinct,
        });
      }
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

  // 每词开始：计时 + 自动发音（**播该义项自己的读音**）+ 3 秒超时自动"没想起"
  useEffect(() => {
    if (!current) return;
    startRef.current = performance.now();
    setAnswered(null);
    void speak(
      {
        text: current.lemma,
        ipa: current.sense.ipa,
        arpabet: current.sense.arpabet,
        mode: 'word',
      },
      current.sense.senseId,
    );
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
  }, [current?.sense.senseId]);

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
        {current.pronunciationCount > 1 && (
          <Box sx={{ mt: 1 }}>
            <Chip
              color="warning"
              size="small"
              variant="outlined"
              label={`这个词有 ${current.pronunciationCount} 种读音，现在放的是其中一种`}
            />
          </Box>
        )}
        <Box sx={{ mt: 2 }}>
          <Button
            size="small"
            onClick={() =>
              void speak(
                {
                  text: current.lemma,
                  ipa: current.sense.ipa,
                  arpabet: current.sense.arpabet,
                  mode: 'word',
                },
                current.sense.senseId,
              )
            }
          >
            再听一次
          </Button>
        </Box>

        {!answered ? (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              3 秒内没反应自动记"没想起"；点选后看答案再进下一项。
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
            {/* 揭晓：先给本次这一档读音对应的释义，再列出该词其它读音 —— 明确区分 */}
            <Typography variant="body1" color="warning.dark" sx={{ mt: 0.5 }}>
              /{current.sense.ipa.replace(/^\/|\/$/g, '')}/ · {current.sense.pos || '义项'}
            </Typography>
            <Typography variant="body1" sx={{ mt: 0.5 }}>
              {current.sense.zh}
            </Typography>
            {current.pronunciationCount > 1 && (
              <Box sx={{ mt: 1.5 }}>
                <Typography variant="caption" color="text.secondary">
                  同一个词的其它读音与意思（各算不同的词项）：
                </Typography>
                <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                  {current.senses
                    .filter((s) => s.pronunciationKey !== current.sense.pronunciationKey)
                    .map((s) => (
                      <Typography key={s.senseId} variant="caption" color="text.secondary">
                        /{s.ipa.replace(/^\/|\/$/g, '')}/ · {s.zh}
                      </Typography>
                    ))}
                </Stack>
              </Box>
            )}
            <Button variant="contained" fullWidth sx={{ mt: 2 }} onClick={next}>
              下一项
            </Button>
          </>
        )}
      </Paper>
    </Box>
  );
}
