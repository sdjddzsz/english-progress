/**
 * SpellingPage.tsx —— 拼写 / 听写（用户 2026-10-13：「所有单词软件的基本功能都要有」）。
 *
 * 此前项目里「拼写词形记不住」只是反馈面板里的一个 L2 标签词 —— 也就是说，
 * 系统让你说"我拼写记不住"，但**从不给你拼的机会**。这是背单词软件的标配训练模式。
 *
 * 两种模式共用一套流程：
 *  - 拼写模式：给中文释义 + 发音，输入英文拼写；
 *  - 听写模式：只给发音（可重复播放），输入英文拼写。
 * 判分纯本地确定性比对（去首尾空格 + 小写），并给出**首次输入的差异提示**
 *  （首字母错 → 直接给首字母；否则给长度与逐位提示），避免只说"错了"这种无用反馈。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import type { L1State, Word } from '../types/domain';
import { useAppStore } from '../store/useAppStore';
import { useFeedback } from '../hooks/useFeedback';
import { useTTS } from '../hooks/useTTS';

type Mode = 'spell' | 'dictation';

/** 拼写判分结果 */
export type SpellVerdict =
  | { kind: 'correct' }
  | { kind: 'empty' }
  | { kind: 'wrong'; hint: string; firstTry: string };

/**
 * 拼写比对 + 差异提示（纯函数，便于单测钉死）。
 * ⚠ 判定只做「忽略大小写与首尾空格」的严格比对 —— 不做模糊匹配：
 *   拼写训练就是要暴露错在哪，模糊命中会把练习变成自我安慰。
 */
export function checkSpelling(input: string, answer: string): SpellVerdict {
  const got = input.trim().toLowerCase();
  const want = answer.trim().toLowerCase();
  if (got === '') return { kind: 'empty' };
  if (got === want) return { kind: 'correct' };
  const hints: string[] = [];
  if (got[0] !== want[0]) hints.push(`首字母是 ${want[0].toUpperCase()}`);
  if (got.length !== want.length) hints.push(`长度应为 ${want.length} 个字母`);
  // 定位第一个不同的位置（只在等长且首字母对时给逐位提示）
  if (hints.length === 0) {
    const i = [...got].findIndex((c, k) => c !== want[k]);
    if (i >= 0) hints.push(`第 ${i + 1} 个字母是 ${want[i].toUpperCase()}`);
  }
  return { kind: 'wrong', hint: hints.join('；') || '拼写有误', firstTry: got };
}

export default function SpellingPage() {
  const navigate = useNavigate();
  const { todayHits, wordMap } = useAppStore();
  const { submit, startSession } = useFeedback();
  const { speak } = useTTS();

  const [mode, setMode] = useState<Mode>('spell');
  /** 默认每日词量 20（可在页面内调；不写进设置，避免为一个小选项新增云端配置） */
  const [limit, setLimit] = useState(20);

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: Word[] = [];
    for (const h of todayHits) {
      if (seen.has(h.wordId)) continue;
      seen.add(h.wordId);
      const w = wordMap[h.wordId];
      if (w) out.push(w);
      if (out.length >= limit) break;
    }
    return out;
  }, [todayHits, wordMap, limit]);

  const [idx, setIdx] = useState(0);
  const [input, setInput] = useState('');
  const [verdict, setVerdict] = useState<SpellVerdict | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [wrongCount, setWrongCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [finished, setFinished] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const startRef = useRef<number>(performance.now());

  const current = items[idx] ?? null;

  // 每题重置 + 听写模式自动发音
  useEffect(() => {
    if (!current) return;
    setInput('');
    setVerdict(null);
    setAttempts(0);
    startRef.current = performance.now();
    if (mode === 'dictation') {
      void speak({ text: current.lemma, ipa: current.ipa, arpabet: current.arpabet, mode: 'word' }, current.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, mode]);

  const submitAnswer = useCallback(async () => {
    if (!current || !verdict) return;
    const hit = todayHits.find((h) => h.wordId === current.id);
    if (hit) {
      setBusy(true);
      setErr('');
      try {
        if (!sessionIdRef.current) sessionIdRef.current = await startSession('vocab_visual');
        const l1: L1State = verdict.kind === 'correct' && attempts === 0 ? 'instant' : 'familiar_but_forgotten';
        await submit(
          hit,
          sessionIdRef.current,
          {
            l1State: l1,
            l2Tags: verdict.kind === 'correct' ? [] : ['拼写词形记不住'],
          },
          performance.now() - startRef.current,
        );
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    }
    if (idx + 1 >= items.length) setFinished(true);
    else setIdx((i) => i + 1);
  }, [current, verdict, attempts, todayHits, submit, startSession, idx, items.length]);

  const check = useCallback(() => {
    if (!current) return;
    const v = checkSpelling(input, current.lemma);
    setVerdict(v);
    setAttempts((a) => a + 1);
    if (v.kind === 'wrong') setWrongCount((c) => c + 1);
  }, [current, input]);

  if (items.length === 0) {
    return (
      <Box p={2}>
        <Paper sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="h6">今日队列为空</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            拼写训练的词全部来自今日队列，先去 Today 完成当前任务。
          </Typography>
          <Button variant="contained" sx={{ mt: 2 }} onClick={() => navigate('/')}>
            回 Today
          </Button>
        </Paper>
      </Box>
    );
  }

  if (finished || !current) {
    return (
      <Box p={2}>
        <Paper sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="h6">拼写练习完成（{items.length} 词）</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            其中 {items.length - wrongCount} 词一次写对，{wrongCount} 词写错过（已带「拼写词形记不住」记录，
            明日队列会优先照顾它们）。
          </Typography>
          <Stack direction="row" spacing={1} justifyContent="center" sx={{ mt: 2 }}>
            <Button variant="outlined" onClick={() => navigate('/training')}>
              回训练
            </Button>
            <Button
              variant="contained"
              onClick={() => {
                setIdx(0);
                setWrongCount(0);
                setFinished(false);
                setInput('');
                setVerdict(null);
              }}
            >
              再来一轮
            </Button>
          </Stack>
        </Paper>
      </Box>
    );
  }

  return (
    <Box p={2} pb={4}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h6">拼写 / 听写</Typography>
        <Typography variant="body2" color="text.secondary">
          {idx + 1} / {items.length}
        </Typography>
      </Stack>

      <ToggleButtonGroup
        exclusive
        size="small"
        sx={{ mt: 1 }}
        value={mode}
        onChange={(_, v: Mode | null) => v && setMode(v)}
      >
        <ToggleButton value="spell">看中文拼写</ToggleButton>
        <ToggleButton value="dictation">听发音拼写</ToggleButton>
      </ToggleButtonGroup>

      <LinearProgress
        variant="determinate"
        value={(idx / Math.max(1, items.length)) * 100}
        sx={{ my: 1.5 }}
      />

      {err && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {err}
        </Alert>
      )}

      <Paper sx={{ p: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" sx={{ mb: 2 }}>
          {mode === 'spell' ? (
            <Typography variant="h6" textAlign="center">
              {current.senses[0] || '（无释义）'}
            </Typography>
          ) : (
            <Button startIcon={<VolumeUpIcon />} onClick={() => void speak({ text: current.lemma, ipa: current.ipa, arpabet: current.arpabet, mode: 'word' }, current.id)}>
              播放发音
            </Button>
          )}
          {mode === 'spell' && (
            <Button
              size="small"
              startIcon={<VolumeUpIcon />}
              onClick={() => void speak({ text: current.lemma, ipa: current.ipa, arpabet: current.arpabet, mode: 'word' }, current.id)}
            >
              听一下
            </Button>
          )}
        </Stack>

        <TextField
          fullWidth
          autoFocus
          autoComplete="off"
          label="输入英文拼写"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !verdict) check();
            else if (e.key === 'Enter' && verdict) void submitAnswer();
          }}
          disabled={verdict != null}
          helperText="回车提交"
        />

        {verdict && (
          <Box sx={{ mt: 2 }}>
            {verdict.kind === 'correct' && (
              <Alert severity={attempts === 1 ? 'success' : 'info'}>
                {attempts === 1 ? '一次写对。' : `写对了（第 ${attempts} 次）。`}
              </Alert>
            )}
            {verdict.kind === 'wrong' && (
              <Alert severity="warning">
                拼写不对 —— {verdict.hint}。正确拼写是 <strong>{current.lemma}</strong>
                {current.ipa ? ` /${current.ipa.replace(/^\/|\/$/g, '')}/` : ''}。
              </Alert>
            )}
            <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1.5 }}>
              {/* 上一词：点错了「下一个」能退回去，不用认栽 */}
              {idx > 0 && (
                <Button
                  variant="text"
                  size="small"
                  disabled={busy}
                  onClick={() => {
                    setIdx((i) => Math.max(0, i - 1));
                    setInput('');
                    setVerdict(null);
                    setAttempts(0);
                  }}
                >
                  ← 上一词
                </Button>
              )}
              <Button variant="contained" disabled={busy} onClick={() => void submitAnswer()}>
                {busy ? <CircularProgress size={20} /> : idx + 1 >= items.length ? '完成' : '下一个'}
              </Button>
            </Stack>
          </Box>
        )}

        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
          <Chip size="small" variant="outlined" label={`今日已练 ${idx} / 写错 ${wrongCount}`} />
        </Stack>
      </Paper>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        词量上限 {limit}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
        {[10, 20, 50].map((n) => (
          <Button key={n} size="small" variant={limit === n ? 'contained' : 'outlined'} onClick={() => setLimit(n)}>
            {n} 词
          </Button>
        ))}
      </Stack>
    </Box>
  );
}
