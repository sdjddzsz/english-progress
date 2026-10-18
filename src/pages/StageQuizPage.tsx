/**
 * StageQuizPage —— 阶段二/三/四考查页（用户 2026-10-15 四阶段制）。
 *   阶段二：由义选词 —— 看中文释义，4 选 1 单词
 *   阶段三：听音选词 —— 听发音，4 选 1 单词（出题自动朗读，可重听）
 *   阶段四：听词拼写 —— 听发音，拼写输入；写对一次 = 彻底毕业（stage=0）
 * 判定：阶段二/三沿用用时+对错四档；阶段四只有对错。
 * 晋级/特训/层升降统一走 features/quiz/stages.ts 引擎；写回走离线队列（与阶段一同款）。
 * 会话快照暂不持久（阶段一有；2-4 队列短，刷新重开可接受）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import { getRepos, useAppStore } from '../store/useAppStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTTS } from '../hooks/useTTS';
import { useSfx } from '../hooks/useSfx';
import { clampSenseIndex, displaySenses, normalizeSenses } from '../features/senses';
import {
  judgeAnswer,
  QUIZ_DAY_PASS_COUNT,
  roundRelease,
  thresholdLineLabel,
  verdictChipSx,
  verdictLabel,
  type QuizVerdict,
} from '../features/quiz/judging';
import { applyStageChoiceResult, applyStageSpellingResult, enteringRound, STAGE_GRADUATE_LABEL, STAGE_META } from '../features/quiz/stages';
import { checkSpelling, type SpellVerdict } from './SpellingPage';import { runOrQueue } from '../data/queue';
import { describeWriteError } from '../data/errorText';
import { useLongPress } from '../hooks/useLongPress';
import WordNoteButton from '../components/notes/WordNoteButton';
import LongPressSenseRow from '../components/word/LongPressSenseRow';
import SenseEditDialog from '../components/word/SenseEditDialog';
import VoiceOverrideDialog from '../components/tts/VoiceOverrideDialog';
import { voiceLabelOf } from '../tts/voiceOptions';
import type { BookWord, Word } from '../types/domain';

type Phase = 'loading' | 'quiz' | 'done';
const STAGES = [2, 3, 4] as const;
type QuizStage = (typeof STAGES)[number];

interface QuizItem {
  bookWord: BookWord;
  word: Word;
  /** 阶段二展示的义项下标（多义词随机取一义） */
  senseIndex: number;
  /** 本轮内第几次作答该词（1=第一次；用户 2026-10-17：首答即达标 → 一遍过，达标线=设置页「每轮过关挡位」） */
  attemptNo: number;
  /** 本次作答后是否已放行 / 已晋级（进度显示用） */
  released?: boolean;
  promoted?: boolean;
  options?: string[];
  correct?: string;
  verdict?: QuizVerdict;
  picked?: string;
  spellVerdict?: SpellVerdict;
  askedAt?: number;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function StageQuizPage() {
  const { stage } = useParams();
  const navigate = useNavigate();
  const stageNo = STAGES.includes(Number(stage) as QuizStage) ? (Number(stage) as QuizStage) : null;
  // 阶段一的题面是原 QuizPage（由词选义，带会话恢复/上一题/AI 助教）——
  // 任何进 /stage-quiz/1 的入口都重定向过去，别在这里报「未知阶段」（用户 2026-10-15 报错修复）
  const stageParam = Number(stage);
  useEffect(() => {
    if (stageParam === 1) navigate('/quiz', { replace: true });
  }, [stageParam, navigate]);
  const { activeBookId, userId } = useAppStore();
  const { autoSpeak, quizDailyLimit, stageGraduate, quizDayThreshold } = useSettingsStore();
  const { speak, speakAuto, resynthesize, loading: ttsLoading, voiceOverride, setVoiceOverride, getEffectiveVoiceModel } = useTTS();
  const sfx = useSfx();

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  // 长按释义编辑（用户 2026-10-18）：当前在编辑第几个义项
  const [senseEditIdx, setSenseEditIdx] = useState<number | null>(null);
  // 长按「重新合成」→ 模型/音色临换面板（用户 2026-10-18）
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const resynthLongPress = useLongPress(() => setVoicePickerOpen(true));
  const [syncHint, setSyncHint] = useState('');
  const [items, setItems] = useState<QuizItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState('');
  const [verdict, setVerdict] = useState<QuizVerdict | null>(null);
  const [spellVerdict, setSpellVerdict] = useState<SpellVerdict | null>(null);  const [stats, setStats] = useState({ skilled: 0, advanced: 0, total: 0 });
  const [input, setInput] = useState('');
  const showAtRef = useRef(0);

  const start = useCallback(async () => {
    if (!userId || !stageNo) return;
    // 新一轮开局：临时模型/音色覆盖复位（「临时固定本轮」——新 round 回到设置页配置）
    setVoiceOverride(null);
    setPhase('loading');
    setError('');
    try {
      const repos = getRepos();
      if (!activeBookId) throw new Error('没有生效词书');
      const all = await repos.word.listBookWords(activeBookId);
      const pool = all.filter((bw) => bw.stage === stageNo);
      if (pool.length === 0) {
        setPhase('done');
        return;
      }
      const batch = pool.slice(0, quizDailyLimit);
      // 新一轮开局：轮标线归零（用户 2026-10-18「进入新一轮的单词得从零开始计数」）。
      // 本地先换 0 再落库；落库走离线队列——断网/云端缺列时入 pending_ops 补传
      // （C1：旧实现 try/catch 静默吞，云端残留旧值、跨设备语义不一致；
      // 补传带 skipAnsweredSince，入队后又答过的词以作答写回为权威）。
      const resetOutcome = await runOrQueue(
        'bookWord.roundReset',
        { ids: batch.map((bw) => bw.id), since: new Date().toISOString() },
        async () => {
          await repos.word.resetRoundStreaks(batch.map((bw) => bw.id));
        },
      );
      if (resetOutcome === 'queued') setSyncHint('本轮过关计数归零已存本机，联网后自动同步');
      const roundBatch = batch.map(enteringRound);
      const words = await repos.word.listWordsByIds(batch.map((bw) => bw.wordId));
      const wordById = new Map(words.map((w) => [w.id, w]));
      // 干扰项词源：本批词；不足 4 个再随机补一批词书词条
      let source = words;
      if (new Set(words.map((w) => w.lemma)).size < 4) {
        const extra = await repos.word.searchWordsByPrefix('', 60);
        const seen = new Set(words.map((w) => w.id));
        source = [...words, ...extra.filter((w) => !seen.has(w.id))];
      }
      const quizItems: QuizItem[] = roundBatch
        .filter((bw) => wordById.has(bw.wordId))
        .map((bw) => {
          const word = wordById.get(bw.wordId) as Word;
          return {
            bookWord: bw,
            word,
            senseIndex: Math.floor(Math.random() * normalizeSenses(word).length),
            attemptNo: 1,
          };
        });
      // 预生成选项（同批内打乱取 3 个干扰词形）
      for (const it of quizItems) {
        const others = shuffle(source.filter((w) => w.id !== it.word.id && w.lemma !== it.word.lemma)).slice(0, 3);
        it.options = shuffle([it.word.lemma, ...others.map((w) => w.lemma)]);
        it.correct = it.word.lemma;
      }
      setItems(quizItems);
      setIdx(0);
      setStats({ skilled: 0, advanced: 0, total: quizItems.length });
      setPhase('quiz');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('done');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBookId, userId, stageNo, quizDailyLimit]);

  useEffect(() => {
    void start();
  }, [start]);

  const current = items[idx] ?? null;

  // 出题计时 + 自动朗读（阶段三/四发音即题面；阶段二自动读正确答案词会泄题，不读）
  useEffect(() => {
    if (phase !== 'quiz' || !current) return;
    showAtRef.current = Date.now();
    setPicked('');
    setVerdict(null);
    setInput('');
    setSpellVerdict(null);
    if (stageNo === 3 || stageNo === 4) {
      speakAuto(
        { text: current.word.lemma, ipa: current.word.ipa, arpabet: current.word.arpabet, mode: 'word' },
        current.word.id,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, phase, current?.bookWord.id]);

  /** 写回：走离线队列（云端缺列/断网时入 pending_ops 补传） */
  const persist = async (bw: BookWord, patch: Record<string, unknown>): Promise<void> => {
    try {
      const outcome = await runOrQueue('bookWord.quiz', { bookWordId: bw.id, patch }, async () => {
        await getRepos().word.updateBookWordQuiz(bw.id, patch as never);
      });
      if (outcome === 'queued') setSyncHint('本条进度已存本机，联网后自动同步');
    } catch (e) {
      setError(describeWriteError(e));
    }
  };

  /** 阶段二/三作答 */
  const answerChoice = async (opt: string, forceUnknown = false): Promise<void> => {
    if (!current || !stageNo || verdict) return;
    const elapsed = Date.now() - showAtRef.current;
    const correct = opt === current.correct;
    const v: QuizVerdict = forceUnknown ? 'unknown' : judgeAnswer(elapsed, correct);
    sfx(v === 'skilled' || v === 'recognized' ? 'correct' : 'wrong');
    setPicked(opt);
    setVerdict(v);
    const bw = current.bookWord;
    // 毕业线判定固定「熟练」（阶段毕业设置只配次数）——绝不传每轮挡位（2026-10-18 事故）
    const sp = applyStageChoiceResult(bw, v, stageGraduate[stageNo === 4 ? 3 : stageNo], new Date(), current.attemptNo);
    const advanced = sp.stage !== bw.stage && sp.stage > (bw.stage as number);
    // 每轮过关挡位（用户 2026-10-15）：连续达标才放行；晋级立即放行。
    // 与阶段一（QuizPage）同一套 roundRelease 规则，挡位不匹配的问题同源修复
    const { dayStreak, release } = roundRelease({
      verdict: v,
      prevStreak: bw.quizDayStreak ?? 0,
      threshold: quizDayThreshold,
      lastQuizAt: bw.lastQuizAt,
      leftStage: advanced,
      attemptNo: current.attemptNo,
    });
    const nextBw: BookWord = {
      ...bw,
      ...sp,
      quizDayStreak: dayStreak,
      quizDayPassed: dayStreak >= QUIZ_DAY_PASS_COUNT,
    };
    setItems((its) =>
      its.map((it, i) =>
        i === idx ? { ...it, bookWord: nextBw, verdict: v, picked: opt, released: release, promoted: advanced } : it,
      ),
    );
    // 未放行/不会 → 排到队尾重来（不会按钮即判生词）
    if (!release) {
      setItems((its) => [
        ...its,
        { ...current, bookWord: nextBw, senseIndex: current.senseIndex, attemptNo: current.attemptNo + 1 },
      ]);
    }
    setStats((s) => ({
      skilled: s.skilled + (v === 'skilled' ? 1 : 0),
      advanced: s.advanced + (advanced ? 1 : 0),
      total: s.total,
    }));
    await persist(bw, { ...sp, quizDayStreak: dayStreak, quizDayPassed: dayStreak >= QUIZ_DAY_PASS_COUNT });
    if (autoSpeak && correct) {
      speak({ text: current.word.lemma, ipa: current.word.ipa, arpabet: current.word.arpabet, mode: 'word' }, current.word.id);
    }
  };

  /** 阶段四作答：拼写比对 → 对=彻底毕业 */
  const answerSpelling = async (): Promise<void> => {
    if (!current || !stageNo || spellVerdict) return;
    const sv = checkSpelling(input, current.word.lemma);
    if (sv.kind === 'empty') return;
    const correct = sv.kind === 'correct';
    sfx(correct ? 'correct' : 'wrong');
    setSpellVerdict(sv);
    const bw = current.bookWord;
    const sp = applyStageSpellingResult(bw, correct, new Date());
    const graduated = sp.stage === 0;
    // 写对=彻底毕业（离开本阶段）→ 立即放行；写错 → 排到队尾重来。
    // 过关计数与阶段二/三同口径（写对按「熟练」计，写错按「生词」清零）
    const { dayStreak, release } = roundRelease({
      verdict: correct ? 'skilled' : 'unknown',
      prevStreak: bw.quizDayStreak ?? 0,
      threshold: quizDayThreshold,
      lastQuizAt: bw.lastQuizAt,
      leftStage: graduated,
      attemptNo: current.attemptNo,
    });
    const nextBw: BookWord = {
      ...bw,
      ...sp,
      quizDayStreak: dayStreak,
      quizDayPassed: dayStreak >= QUIZ_DAY_PASS_COUNT,
    };
    setItems((its) =>
      its.map((it, i) => (i === idx ? { ...it, bookWord: nextBw, spellVerdict: sv, released: release, promoted: graduated } : it)),
    );
    if (!release) {
      setItems((its) => [
        ...its,
        { ...current, bookWord: nextBw, senseIndex: current.senseIndex, attemptNo: current.attemptNo + 1 },
      ]);
    }
    setStats((s) => ({
      skilled: s.skilled + (correct ? 1 : 0),
      advanced: s.advanced + (graduated ? 1 : 0),
      total: s.total,
    }));
    await persist(bw, { ...sp, quizDayStreak: dayStreak, quizDayPassed: dayStreak >= QUIZ_DAY_PASS_COUNT });
  };

  const next = (): void => {
    if (idx + 1 >= items.length) setPhase('done');
    else setIdx((i) => i + 1);
  };

  const sense = useMemo(() => (current ? displaySenses(current.word)[current.senseIndex] : null), [current]);

  if (!stageNo) {
    return (
      <Box p={2}>
        <Alert severity="error">未知阶段：{stage}</Alert>
      </Box>
    );
  }
  const meta = STAGE_META[stageNo];

  return (
    <Box p={2} pb={4} maxWidth={720} mx="auto">
      <Typography variant="h5">{meta.name}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {stageNo === 2 && '看词义选单词：3 秒内选对=熟练，3-5 秒=认识，5-7 秒=不熟，超时或选错=生词。'}
        {stageNo === 3 && '听发音选单词（可点喇叭重听）：判定同用时四档。'}
        {stageNo === 4 && '听发音拼写单词：写对一次即彻底毕业；写错会排到队尾重来。'}
        {(stageNo === 2 || stageNo === 3) &&
          `【轮标线】（放行线，档位取设置页「每轮过关挡位」=首见${thresholdLineLabel(quizDayThreshold)}）：本轮第一次作答就达到挡位的词一遍过；没达到的即使答对也排到队尾重来（重刷不算首过），连续达标 ${QUIZ_DAY_PASS_COUNT} 次才放行（晋级立即放行）。`}
        【毕业线】（晋级线，取设置页「阶段毕业条件」=首见{STAGE_GRADUATE_LABEL}，次数可配、判定固定）：
        每轮第一次作答就是「{STAGE_GRADUATE_LABEL}」算一次首过，连续 {stageGraduate[stageNo === 4 ? 3 : stageNo]} 轮首过晋级下一阶段
        {stageNo === 4 ? '（本阶段写对一次即毕业）' : ''}；不限每天一轮，完成一轮可立即再来一轮。
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {syncHint && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          {syncHint}
        </Typography>
      )}

      {phase === 'loading' && (
        <Box textAlign="center" py={6}>
          <CircularProgress />
        </Box>
      )}

      {phase === 'done' && (
        <Paper sx={{ mt: 3, p: 3, textAlign: 'center' }}>
          {items.length === 0 && !error ? (
            <Alert severity="success" sx={{ mb: 2 }}>
              该阶段现在没有词（可能是都毕业了，或去词书页导入）。
            </Alert>
          ) : (
            <Alert severity="info" sx={{ mb: 2 }}>
              本轮完成：熟练 {stats.skilled} 次 · 晋级/毕业 {stats.advanced} 词。不限每天一轮，可立即再来。
            </Alert>
          )}
          <Stack direction="row" spacing={1} justifyContent="center">
            {items.length > 0 && (
              <Button variant="contained" onClick={() => void start()}>
                再来一轮
              </Button>
            )}
            <Button variant="outlined" onClick={() => navigate('/')}>
              回阶段总览
            </Button>
          </Stack>
        </Paper>
      )}

      {phase === 'quiz' && current && (
        <Paper sx={{ mt: 3, p: 3 }}>
          <LinearProgress
            variant="determinate"
            value={(idx / Math.max(1, items.length)) * 100}
            sx={{ mb: 2 }}
          />
          {/* 题面 */}
          {stageNo === 2 && (
            <Stack alignItems="center" spacing={1} py={2}>
              <Typography variant="h6">{sense?.zh}</Typography>
              {sense?.pos && (
                <Typography variant="body2" color="text.secondary">
                  {sense.pos}
                </Typography>
              )}
            </Stack>
          )}
          {(stageNo === 3 || stageNo === 4) && (
            <Stack alignItems="center" spacing={1} py={2}>
              <Tooltip title="重听">
                <IconButton
                  size="large"
                  aria-label="replay"
                  onClick={() =>
                    speak(
                      { text: current.word.lemma, ipa: current.word.ipa, arpabet: current.word.arpabet, mode: 'word' },
                      current.word.id,
                    )
                  }
                >
                  <VolumeUpIcon fontSize="large" />
                </IconButton>
              </Tooltip>
              {stageNo === 4 && (
                <Typography variant="caption" color="text.secondary">
                  听发音，在下面拼出这个单词
                </Typography>
              )}
            </Stack>
          )}

          {/* 作答区 */}
          {stageNo === 4 ? (
            <Stack spacing={1.5} sx={{ mt: 2 }}>
              <TextField
                autoFocus
                fullWidth
                label="拼写"
                value={input}
                disabled={Boolean(spellVerdict)}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void answerSpelling();
                }}
              />
              {!spellVerdict && (
                <Button variant="contained" onClick={() => void answerSpelling()}>
                  提交
                </Button>
              )}
              {spellVerdict && (
                <Stack spacing={1} alignItems="center">
                  {spellVerdict.kind === 'correct' ? (
                    <Chip color="success" size="small" label={current.word.lemma} />
                  ) : (
                    <Typography variant="body2" color="error">
                      {spellVerdict.kind === 'wrong'
                        ? `拼写不对——${spellVerdict.hint}。正确拼写是 ${current.word.lemma}`
                        : '先听发音再拼写'}
                    </Typography>
                  )}
                  {/* 毕业线（用户 2026-10-18 v2：阶段四=写对一次即彻底毕业） */}
                  <Typography variant="caption" color={spellVerdict.kind === 'correct' ? 'success.main' : 'text.secondary'}>
                    毕业线：{spellVerdict.kind === 'correct' ? '1' : '0'}/1（写对一次即彻底毕业）
                    {spellVerdict.kind === 'correct' ? ' · 已毕业' : ''}
                  </Typography>
                  {/* 该词全部释义（用户 2026-10-15：拼写完也要看到完整释义） */}
                  <Box sx={{ width: '100%', textAlign: 'left' }}>
                    <Typography variant="caption" color="text.secondary">
                      {current.word.lemma} 的全部释义：
                    </Typography>
                    <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                      {displaySenses(current.word).map((sd, i) => (
                        <Typography key={sd.senseId} variant="body2" color="text.secondary">
                          {i + 1}. {sd.pos ? `[${sd.pos}] ` : ''}
                          {sd.zh}
                        </Typography>
                      ))}
                    </Stack>
                  </Box>
                  <Button variant="contained" onClick={next}>
                    {idx + 1 >= items.length ? '看总结' : '下一题'}
                  </Button>
                </Stack>
              )}
            </Stack>
          ) : (
            <Stack spacing={1.5} sx={{ mt: 2 }}>
              {(current.options ?? []).map((opt) => {
                const isPicked = picked === opt;
                const isCorrect = opt === current.correct;
                const showState = verdict !== null;
                const state: 'correct' | 'wrong' | 'neutral' = showState
                  ? isCorrect
                    ? 'correct'
                    : isPicked
                      ? 'wrong'
                      : 'neutral'
                  : 'neutral';
                const softStyle = {
                  correct: { bgcolor: '#e6f4ea', color: '#1b5e20', borderColor: '#a5d6a7' },
                  wrong: { bgcolor: '#fdecea', color: '#b3261e', borderColor: '#ef9a9a' },
                  neutral: { bgcolor: '#f5f5f5', color: 'rgba(0,0,0,0.38)' },
                }[state];
                return (
                  <Button
                    key={opt}
                    fullWidth
                    variant="outlined"
                    disabled={showState}
                    onClick={() => void answerChoice(opt)}
                    sx={{ justifyContent: 'flex-start', textTransform: 'none', ...softStyle }}
                  >
                    {state === 'correct' ? '✓ ' : state === 'wrong' ? '✗ ' : ''}
                    {opt}
                  </Button>
                );
              })}
              {verdict && (
                <Stack spacing={1.5} alignItems="center" sx={{ mt: 2 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Chip label={verdictLabel(verdict)} size="small" sx={verdictChipSx(verdict)} />
                    <Typography variant="body2" color="text.secondary">
                      {verdict === 'skilled' ? '继续，连对就晋级' : '这个词标记后会更频繁出现'}
                    </Typography>
                  </Stack>
                  {/* 双线进度（用户 2026-10-18 v2：紧凑格式；毕业线始终显示） */}
                  <Stack spacing={0.25} alignItems="center" sx={{ width: '100%' }}>
                    <Typography variant="body2" color="text.secondary">
                      轮标线：{current.bookWord.quizDayStreak ?? 0}/{QUIZ_DAY_PASS_COUNT}（{thresholdLineLabel(quizDayThreshold)}）
                      {current.released
                        ? current.promoted
                          ? ' · 已晋级'
                          : (current.bookWord.quizDayStreak ?? 0) >= QUIZ_DAY_PASS_COUNT
                            ? ' · 已过关，不再出现'
                            : ' · 首答即达标一遍过'
                        : ''}
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{ color: current.promoted ? 'success.main' : 'text.secondary' }}
                    >
                      毕业线：{current.bookWord.stageStreak}/{stageGraduate[stageNo]}（首见{STAGE_GRADUATE_LABEL}）
                      {current.promoted ? ' · 已晋级，进入下一阶段（打满即毕业，新阶段从 0 起计）' : ''}
                    </Typography>
                  </Stack>
                  {/* 该词全部释义（用户 2026-10-15：多义词只考一个义项，出答案必须完整显示） */}
                  <Box sx={{ width: '100%', textAlign: 'left' }}>
                    <Typography variant="caption" color="text.secondary">
                      {current.word.lemma} 的全部释义（本题考的是第 {current.senseIndex + 1} 个）：
                    </Typography>
                    <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                      {displaySenses(current.word).map((sd, i) => (
                        <LongPressSenseRow
                          key={sd.senseId}
                          sense={sd}
                          index={i}
                          isCurrent={i === current.senseIndex}
                          onLongPress={setSenseEditIdx}
                        />
                      ))}
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                      长按任一释义可编辑 / 删除（电脑上直接右键也行；改动直接写回词书）
                    </Typography>
                  </Box>
                  <Button variant="contained" onClick={next}>
                    {idx + 1 >= items.length ? '看总结' : '下一题'}
                  </Button>
                </Stack>
              )}
              {!verdict && (
                <Button color="inherit" size="small" onClick={() => void answerChoice('', true)}>
                  不会
                </Button>
              )}
            </Stack>
          )}
          {/* 题旁笔记（用户 2026-10-17）：一词一记，点开即编辑 */}
          <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="center" sx={{ mt: 2 }}>
            <Typography variant="caption" color="text.secondary">
              第 {idx + 1} / {items.length} 题 · 没到过关线的词会排到队尾重来
            </Typography>
            {/* 重新合成（用户 2026-10-17 + 长按临换 2026-10-18）：
                单击=删本地+云端缓存后重录；长按=临时换模型/音色（只固定本轮） */}
            <Tooltip
              title={
                voiceOverride
                  ? `重新合成（本轮临时：${voiceLabelOf(voiceOverride.model, voiceOverride.voice)} · ${voiceOverride.model}；长按或右键可改）`
                  : '重新合成（这个读音不对时用；长按或右键可临时换模型/音色）'
              }
            >
              <span>
                <IconButton
                  size="small"
                  disabled={ttsLoading}
                  aria-label={`resynthesize ${current.word.lemma}`}
                  onClick={() => {
                    // 长按已开临换面板——同一次手势的 click 不再触发重录
                    if (resynthLongPress.consumeFired()) return;
                    void resynthesize(
                      {
                        text: current.word.lemma,
                        ...(current.word.ipa ? { ipa: current.word.ipa } : {}),
                        ...(current.word.arpabet ? { arpabet: current.word.arpabet } : {}),
                        mode: 'word',
                      },
                      current.word.id,
                    );
                  }}
                  {...resynthLongPress}
                >
                  {ttsLoading ? <CircularProgress size={18} /> : <AutorenewIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
            {/* 本轮临时模型/音色徽标（用户 2026-10-18）：点了也能再开面板改 */}
            {voiceOverride && (
              <Chip
                size="small"
                color="secondary"
                variant="outlined"
                clickable
                label={`本轮临时：${voiceLabelOf(voiceOverride.model, voiceOverride.voice)}`}
                onClick={() => setVoicePickerOpen(true)}
              />
            )}
            <WordNoteButton
              wordId={current.bookWord.wordId}
              lemma={current.word.lemma}
              source={`stage-quiz:${stageNo}`}
              senseIndex={current.senseIndex}
            />
          </Stack>
        </Paper>
      )}

      {/* 长按释义 → 编辑/删除（写回词书；保存后换掉内存里的旧 Word，界面立即刷新） */}
      <SenseEditDialog
        word={current?.word ?? null}
        senseIndex={senseEditIdx}
        onClose={() => setSenseEditIdx(null)}
        onSaved={(w) =>
          setItems((prev) =>
            prev.map((it) =>
              it.word.id === w.id
                ? { ...it, word: w, senseIndex: clampSenseIndex(w, it.senseIndex) }
                : it,
            ),
          )
        }
      />
      {/* 模型/音色临换面板（用户 2026-10-18：长按重新合成按钮打开）。
          确定后立即用新设定重录当前词——setVoiceOverride 先写 ref，
          resynthesize 读 ref 不走旧闭包，当场就能听到新音色 */}
      <VoiceOverrideDialog
        open={voicePickerOpen}
        current={voiceOverride}
        getDefaults={getEffectiveVoiceModel}
        onClose={() => setVoicePickerOpen(false)}
        onApply={(v) => {
          setVoiceOverride(v);
          setVoicePickerOpen(false);
          if (!v || !current) return;
          void resynthesize(
            {
              text: current.word.lemma,
              ...(current.word.ipa ? { ipa: current.word.ipa } : {}),
              ...(current.word.arpabet ? { arpabet: current.word.arpabet } : {}),
              mode: 'word',
            },
            current.word.id,
          );
        }}
      />
    </Box>
  );
}
