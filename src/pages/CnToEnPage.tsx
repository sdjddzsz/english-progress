/**
 * CnToEnPage.tsx —— 见中文联想英文（PRD §4.5，默认每日 15 词，可关）：
 * 显示中文释义 → 心里回想词形 → L1 两键单选即跳；作答后揭晓词形与音标。
 * 词源 = 今日队列（四阶共同规则：目标词 100% 来自当前队列）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Box, Button, Chip, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import type { L1State } from '../types/domain';
import { useAppStore } from '../store/useAppStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useFeedback } from '../hooks/useFeedback';
import { useTTS } from '../hooks/useTTS';

interface Item {
  hitId: string;
  wordId: string;
  lemma: string;
  ipa: string;
  /** CMUdict ARPAbet（发音真源；透传给 TTS 请求） */
  arpabet?: string;
  sense: string;
}

export default function CnToEnPage() {
  const navigate = useNavigate();
  const { todayHits, wordMap } = useAppStore();
  const { submit, startSession } = useFeedback();
  const { speak } = useTTS();
  const cnToEnEnabled = useSettingsStore((s) => s.cnToEnEnabled);
  const dailyWords = useSettingsStore((s) => s.cnToEnDailyWords);

  const items = useMemo<Item[]>(() => {
    const seen = new Set<string>();
    const out: Item[] = [];
    for (const h of todayHits) {
      if (seen.has(h.wordId)) continue;
      seen.add(h.wordId);
      const w = wordMap[h.wordId];
      out.push({
        hitId: h.id,
        wordId: h.wordId,
        lemma: w?.lemma ?? h.wordId,
        ipa: w?.ipa ?? '',
        ...(w?.arpabet ? { arpabet: w.arpabet } : {}),
        sense: w?.senses[0] ?? '',
      });
      if (out.length >= dailyWords) break;
    }
    return out;
  }, [todayHits, wordMap, dailyWords]);

  const [idx, setIdx] = useState(0);
  const [answered, setAnswered] = useState<L1State | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const startRef = useRef(performance.now());
  const sessionIdRef = useRef<string | null>(null);

  const current = items[idx] ?? null;

  useEffect(() => {
    startRef.current = performance.now();
    setAnswered(null);
  }, [current?.wordId]);

  const answer = async (l1: L1State) => {
    if (!current || answered) return;
    setAnswered(l1);
    setBusy(true);
    try {
      if (!sessionIdRef.current) sessionIdRef.current = await startSession('cn_to_en');
      const hit = todayHits.find((h) => h.id === current.hitId);
      if (hit) {
        await submit(hit, sessionIdRef.current, { l1State: l1 }, performance.now() - startRef.current);
      }
      // 作答后读一遍英文（听觉巩固）
      void speak({ text: current.lemma, ipa: current.ipa, arpabet: current.arpabet, mode: 'word' }, current.wordId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!cnToEnEnabled) {
    return (
      <Box p={2}>
        <Paper sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="h6">「见中文联想英文」已在设置中关闭</Typography>
          <Button variant="contained" sx={{ mt: 2 }} onClick={() => navigate('/settings')}>
            去设置
          </Button>
        </Paper>
      </Box>
    );
  }

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
          <Typography variant="h6">完成（{items.length} 词）</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            明日按队列继续；答"没想起"的词会由调度器自然加密出现。
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
        <Typography variant="h6">见中文 · 联想英文</Typography>
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
        <Chip label="看中文，想词形" variant="outlined" size="small" />
        <Typography variant="h5" sx={{ mt: 2 }}>
          {current.sense || '（该词暂无释义）'}
        </Typography>

        {!answered ? (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              点选即跳下一词。
            </Typography>
            <Stack direction="row" spacing={1} justifyContent="center" sx={{ mt: 2 }}>
              <Button variant="contained" color="success" disabled={busy} onClick={() => void answer('instant')}>
                想起英文
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
            {current.ipa && (
              <Typography variant="body1" color="text.secondary">
                /{current.ipa.replace(/^\/|\/$/g, '')}/
              </Typography>
            )}
            <Button variant="contained" fullWidth sx={{ mt: 2 }} onClick={() => setIdx((i) => i + 1)}>
              下一词
            </Button>
          </>
        )}
      </Paper>
    </Box>
  );
}
