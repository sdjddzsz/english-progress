/**
 * QuizPage —— 考查制主循环（用户 2026-10-14 定案，摸底已砍）。
 *
 * 出题：单词（多义项词旁小灰字标词性）→ 4 选 1 词义（干扰项相似优先，见 features/quiz/distractors.ts）
 * 判定：按用时+对错四档（features/quiz/judging.ts）：
 *   ≤1s 选对=熟练（连续 5 次毕业出池）；1-3s=认识；3-5s=不熟；>5s 或选错=生词
 *   连续 3 次不熟/生词 → 特种训练（每天必考直到毕业）
 * 频率：越生疏考得越勤（T4 每天 / T3 隔天 / T2 两天 / T1 三天）
 * 本轮结束条件：全部词连续熟练 ≥5 次。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { getRepos, useAppStore } from '../store/useAppStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTTS } from '../hooks/useTTS';
import { useSfx } from '../hooks/useSfx';
import { chatTurn } from '../ai/llmClient';
import { normalizeSenses } from '../features/senses';
import type { BookWord, Word } from '../types/domain';
import {
  QUIZ_GRADUATE_STREAK,
  judgeAnswer,
  specialTrainingAfter,
  streakAfterVerdict,
  failStreakAfterVerdict,
  shouldQuizToday,
  tierAfterQuiz,
  isDayPassedToday,
  isSameUtcDay,
  quizDayStreakAfter,
  QUIZ_DAY_PASS_COUNT,
  verdictChipSx,
  verdictLabel,
  type QuizVerdict,
  type QuizDayThreshold,
} from '../features/quiz/judging';
import {
  buildOptions,
  type DistractorCandidate,
} from '../features/quiz/distractors';

/** 单日考查上限（特种训练词不计入此限——必考） */
const QUIZ_DAILY_LIMIT = 50;

/** 当天过关档位的中文名（展示用） */
const DAY_THRESHOLD_LABEL: Record<QuizDayThreshold, string> = {
  lenient: '宽松',
  standard: '适当',
  strict: '严格',
};

interface QuizItem {
  bookWord: BookWord;
  word: Word;
  senseIndex: number;
}

type Phase = 'loading' | 'quiz' | 'between' | 'done';

export default function QuizPage() {
  const navigate = useNavigate();
  const { activeBookId, userId } = useAppStore();
  const { aiChannel, aiBaseUrl, aiModel, quizAutoNext, quizDayThreshold } = useSettingsStore();
  const { speakAuto, speak, loading, phaseLabel } = useTTS();
  const sfx = useSfx();
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [items, setItems] = useState<QuizItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [options, setOptions] = useState<DistractorCandidate[]>([]);
  const [correctKey, setCorrectKey] = useState('');
  const [verdict, setVerdict] = useState<QuizVerdict | null>(null);
  const [pickedKey, setPickedKey] = useState('');
  const [stats, setStats] = useState({ skilled: 0, graduated: 0, special: 0, dayPassed: 0, total: 0 });
  const [todayLeft, setTodayLeft] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const showAtRef = useRef(0);
  const poolRef = useRef<DistractorCandidate[]>([]);
  // AI 问答框（用户 2026-10-14 第 5 条）：直接和接入的模型提问/交流，
  // 模型自动获得角色 + 当前屏幕内容（当前考查词/词性/释义），无需另写提示词。
  const [aiInput, setAiInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiThread, setAiThread] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);

  /** 启动：拉词书行 → 过滤该考的 → 批量拉词条 → 建队列 */
  const start = useCallback(async () => {
    if (!userId) return;
    setPhase('loading');
    setError('');
    try {
      const repos = getRepos();
      const bookId = activeBookId;
      if (!bookId) throw new Error('没有生效词书');
      const all = await repos.word.listBookWords(bookId);
      const now = new Date();
      // 当天小循环（用户 2026-10-14）：该考的 && 当天还没过关的才进队。
      // 已过关的词当天不再出现，隔夜 quizDayPassed 自动失效（isDayPassedToday 判同日）。
      const pool = all.filter((bw) => shouldQuizToday(bw) && !isDayPassedToday(bw, now));
      const graduated = all.length - all.filter((bw) => bw.streak < QUIZ_GRADUATE_STREAK).length;
      setRemaining(Math.max(0, all.length - graduated));
      if (pool.length === 0) {
        setPhase('done');
        return;
      }
      const specialFirst = [...pool].sort((a, b) => {
        if (a.specialTraining !== b.specialTraining) return a.specialTraining ? -1 : 1;
        if (a.tier !== b.tier) return b.tier - a.tier; // 越生疏越靠前
        return (a.lastQuizAt ?? '').localeCompare(b.lastQuizAt ?? '');
      });
      const batch = specialFirst.slice(0, QUIZ_DAILY_LIMIT);
      const words = await repos.word.listWordsByIds(batch.map((bw) => bw.wordId));
      const wordById = new Map(words.map((w) => [w.id, w]));
      const quizItems: QuizItem[] = batch
        .filter((bw) => wordById.has(bw.wordId))
        .map((bw) => {
          const word = wordById.get(bw.wordId) as Word;
          const senseIndex = Math.floor(Math.random() * normalizeSenses(word).length);
          return { bookWord: bw, word, senseIndex };
        });
      // 干扰池：本次全部词条的全部义项展开
      const poolCands: DistractorCandidate[] = [];
      for (const w of words) {
        const bws = all.filter((bw) => bw.wordId === w.id);
        const order = bws[0] ? bws[0].listNo * 1000 + bws[0].orderInList : 0;
        normalizeSenses(w).forEach((s, i) => {
          poolCands.push({ zh: s.zh, pos: s.pos, order, key: `${w.id}#${i}` });
        });
      }
      poolRef.current = poolCands;
      setItems(quizItems);
      setIdx(0);
      setTodayLeft(quizItems.length);
      setStats({ skilled: 0, graduated: 0, special: 0, dayPassed: 0, total: quizItems.length });
      setPhase('quiz');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('done');
    }
  }, [activeBookId, userId]);

  useEffect(() => {
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = items[idx] ?? null;

  /** 出题：构建四选项 + 重置计时 */
  useEffect(() => {
    if (phase !== 'quiz' || !current) return;
    const sense = normalizeSenses(current.word)[current.senseIndex];
    const bw = current.bookWord;
    const correct: DistractorCandidate = {
      zh: sense.zh,
      pos: sense.pos,
      order: bw.listNo * 1000 + bw.orderInList,
      key: `${bw.wordId}#${current.senseIndex}`,
    };
    setOptions(buildOptions(correct, poolRef.current));
    setCorrectKey(correct.key);
    setVerdict(null);
    setPickedKey('');
    showAtRef.current = Date.now();
    // 自动发音（用户 2026-10-14，遵循设置页「自动发音」开关）：出题即朗读单词
    void speakAuto({ text: current.word.lemma, mode: 'word' }, current.bookWord.wordId);
  }, [phase, current]);

  /** 答题 → 判定 → 落库 → 反馈 → 下一题 */
  const answer = async (key: string, forceUnknown = false): Promise<void> => {
    if (!current || verdict) return;
    const elapsed = Date.now() - showAtRef.current;
    const correct = key === correctKey;
    // 不会/想不起/不确定三按钮（用户 2026-10-14）：点击即判生词，不进入计时判定
    const v: QuizVerdict = forceUnknown ? 'unknown' : judgeAnswer(elapsed, correct);
    // 答题音效（用户 2026-10-14，遵循设置页「答题音效」开关）：
    // 熟练/认识=对音，不熟/生词/三按钮=错音（考查有客观对错，接音效合理）
    sfx(v === 'skilled' || v === 'recognized' ? 'correct' : 'wrong');
    setPickedKey(key);
    setVerdict(v);
    const bw = current.bookWord;
    const now = new Date();
    const nowIso = now.toISOString();
    // 当天小循环：按设置档位（宽松/适当/严格）累计连续达标，3 次当天过关
    const firstQuizOfDay = !isSameUtcDay(bw.lastQuizAt, now);
    const nextDayStreak = quizDayStreakAfter(bw.quizDayStreak ?? 0, v, quizDayThreshold);
    const nextDayPassed = nextDayStreak >= QUIZ_DAY_PASS_COUNT;
    // 总计划排次：tier 只在当天第一次判定时更新（不被当天最终熟悉度影响）
    const nextTier = tierAfterQuiz(bw.tier, v, firstQuizOfDay);
    const nextStreak = streakAfterVerdict(bw.streak, v);
    const nextFail = failStreakAfterVerdict(bw.failStreak, v);
    const nextSpecial = specialTrainingAfter(nextFail, nextStreak, bw.specialTraining);
    const graduated = nextStreak >= QUIZ_GRADUATE_STREAK && !bw.specialTraining;
    try {
      await getRepos().word.updateBookWordQuiz(bw.id, {
        tier: nextTier,
        streak: nextStreak,
        failStreak: nextFail,
        specialTraining: nextSpecial,
        lastQuizAt: nowIso,
        quizDayStreak: nextDayStreak,
        quizDayPassed: nextDayPassed,
      });
      setStats((s) => ({
        skilled: s.skilled + (v === 'skilled' ? 1 : 0),
        graduated: s.graduated + (graduated ? 1 : 0),
        special: s.special + (nextSpecial && !bw.specialTraining ? 1 : 0),
        dayPassed: s.dayPassed + (nextDayPassed && !isDayPassedToday(bw) ? 1 : 0),
        total: s.total,
      }));
      if (graduated) setRemaining((r) => Math.max(0, r - 1));
      if (nextDayPassed) setTodayLeft((n) => Math.max(0, n - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // 自动下一题（设置开关，默认关=手动点「下一题」，用户 2026-10-14：答完要能看清对错与正确答案）
    if (quizAutoNext) {
      setTimeout(() => {
        if (idx + 1 >= items.length) setPhase('done');
        else setIdx((i) => i + 1);
      }, 950);
    }
  };

  const senseOf = useMemo(() => {
    if (!current) return null;
    return normalizeSenses(current.word)[current.senseIndex];
  }, [current]);
  const multiSense = current ? normalizeSenses(current.word).length > 1 : false;

  /** 换词即清空 AI 对话：上下文跟着当前屏幕走 */
  useEffect(() => {
    setAiThread([]);
  }, [idx]);

  /** AI 问答：角色 + 当前屏幕内容自动注入 system，用户只管问 */
  const askAi = async (): Promise<void> => {
    if (!current || !senseOf || aiBusy || !aiInput.trim()) return;
    const q = aiInput.trim();
    setAiInput('');
    setAiThread((t) => [...t, { role: 'user', content: q }]);
    setAiBusy(true);
    try {
      const allSenses = normalizeSenses(current.word)
        .map((s, i) => `${i + 1}. [${s.pos}] ${s.zh} /${s.ipa ?? ''}/`)
        .join('\n');
      const screen =
        `当前考查屏幕内容：\n` +
        `- 单词：${current.word.lemma}${senseOf.pos ? `（本义项词性 ${senseOf.pos}）` : ''}\n` +
        `- 本义项释义：${senseOf.zh}\n` +
        `- 音标：/${senseOf.ipa ?? ''}/\n` +
        `- 该词全部义项：\n${allSenses}\n` +
        `- 用户刚${verdict ? `被判定为「${verdictLabel(verdict)}」` : '还在作答'}`;
      const result = await chatTurn(
        [
          {
            role: 'system',
            content:
              '你是一位英语助教，正在英语学习应用的考查页里回答学习者关于当前单词的问题。' +
              '回答要简短、口语化、直接可用，优先讲该词在当前义项下的用法，需要时给一两个短例句。' +
              '不要重复罗列屏幕上已有的信息，除非用户要求。\n\n' +
              screen,
          },
          ...aiThread.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: q },
        ],
        { model: aiModel || 'step-5-preview', channel: aiChannel, ...(aiBaseUrl ? { baseUrl: aiBaseUrl } : {}) },
      );
      setAiThread((t) => [...t, { role: 'assistant', content: result.content || '（模型未返回内容）' }]);
    } catch (e) {
      setAiThread((t) => [...t, { role: 'assistant', content: `问答失败：${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <Box p={2} pb={4} maxWidth={720} mx="auto">
      <Typography variant="h5">单词考查</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        看单词选词义：1 秒内选对=熟练，1-3 秒=认识，3-5 秒=不熟，超时或选错=生词。
        连续熟练 {QUIZ_GRADUATE_STREAK} 次的词本轮不再出现；越生疏的词考得越勤。
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {phase === 'loading' && (
        <Stack alignItems="center" sx={{ mt: 6 }}>
          <CircularProgress />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            正在生成今日考查队列…
          </Typography>
        </Stack>
      )}

      {phase === 'quiz' && current && senseOf && (
        <Paper sx={{ mt: 3, p: 3 }}>
          <LinearProgress
            variant="determinate"
            value={(idx / Math.max(1, items.length)) * 100}
            sx={{ mb: 3 }}
          />
          <Stack direction="row" spacing={1} alignItems="baseline" justifyContent="center">
            <Typography variant="h4">{current.word.lemma}</Typography>
            {/* ★ 音标 + 词性小灰字（用户 2026-10-14 第 1 条：音标放单词旁边）：
                同一单词不同义项词性/发音可能不同，出题时必须标注本义项 */}
            {senseOf.ipa && (
              <Typography variant="body2" color="text.secondary">
                /{senseOf.ipa}/
              </Typography>
            )}
            {/* 音标旁喇叭（用户 2026-10-14：考查页也要能手动点发音）：
                出题已自动朗读（遵循 autoSpeak 开关），这里补手动入口，读当前义项的单词 */}
            <Tooltip title={loading ? phaseLabel : '发音'}>
              <span>
                <IconButton
                  size="small"
                  disabled={loading}
                  aria-label="play quiz word"
                  onClick={() =>
                    void speak({ text: current.word.lemma, mode: 'word' }, current.bookWord.wordId)
                  }
                >
                  {loading ? <CircularProgress size={18} /> : <VolumeUpIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
            {multiSense && senseOf.pos && (
              <Typography variant="body2" color="text.secondary">
                {senseOf.pos}
              </Typography>
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, textAlign: 'center' }}>
            今天还剩 <strong>{todayLeft}</strong> 个词待过关（连续达标 {QUIZ_DAY_PASS_COUNT} 次）·
            当前档位「{DAY_THRESHOLD_LABEL[quizDayThreshold]}」· 总计划剩 {remaining} 词未毕业
          </Typography>
          <Stack spacing={1.5} sx={{ mt: 3 }}>
            {options.map((o) => {
              const isPicked = pickedKey === o.key;
              const isCorrect = o.key === correctKey;
              const showState = verdict !== null;
              // 判定后（用户 2026-10-14 第 4 次反馈）：柔和平权——
              // 选对=所选条浅绿底深绿字带 ✓；选错=所选条浅红底深红字带 ✗、正确条浅绿带 ✓；
              // 其余未选项浅灰禁用。不用实心艳色块。
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
              const mark = state === 'correct' ? '✓ ' : state === 'wrong' ? '✗ ' : '';
              return (
                <Button
                  key={o.key}
                  fullWidth
                  // 判定后不用 disabled（MUI 的 .Mui-disabled 样式优先级高于 sx，
                  // 会把自定义绿/红底色盖成灰——2026-10-14 截图色块异常的根源）：
                  // 保持 outlined + sx 全量接管配色，用 pointerEvents 挡点击。
                  variant="outlined"
                  disableElevation
                  onClick={showState ? undefined : () => void answer(o.key)}
                  sx={{
                    justifyContent: 'flex-start',
                    textTransform: 'none',
                    py: 1.2,
                    ...(showState ? { border: '1px solid', pointerEvents: 'none', ...softStyle } : {}),
                  }}
                >
                  {mark}
                  {o.pos ? `${o.pos} ` : ''}
                  {o.zh}
                </Button>
              );
            })}
          </Stack>
          {verdict && (
            <Stack spacing={1.5} alignItems="center" sx={{ mt: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip label={verdictLabel(verdict)} size="small" sx={verdictChipSx(verdict)} />
                <Typography variant="body2" color="text.secondary">
                  {verdict === 'skilled' ? '继续，连对 5 次就毕业' : '这个词标记后会更频繁出现'}
                </Typography>
              </Stack>
              {/* 手动下一题（quizAutoNext 关时显示，默认关——答完可看清对错与正确答案再走） */}
              {!quizAutoNext && (
                <Button
                  variant="contained"
                  onClick={() => {
                    if (idx + 1 >= items.length) setPhase('done');
                    else setIdx((i) => i + 1);
                  }}
                >
                  {idx + 1 >= items.length ? '看总结' : '下一题'}
                </Button>
              )}
            </Stack>
          )}
          {/* 不会/想不起/不确定（用户 2026-10-14 第 2 次反馈：三个合成一个）：
              点击即判生词、展示正确答案，再手动进下一题 */}
          {verdict === null && (
            <Stack sx={{ mt: 2 }} alignItems="center">
              <Button size="small" variant="text" color="error" onClick={() => void answer('', true)}>
                不会 / 想不起 / 不确定
              </Button>
            </Stack>
          )}
        </Paper>
      )}

      {/* AI 问答框（用户 2026-10-14 第 5 条）：随当前考查词走，模型自动知道屏幕内容 */}
      {phase === 'quiz' && current && (
        <Paper sx={{ mt: 2, p: 2 }}>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            问 AI（已带上当前单词「{current.word.lemma}」与释义上下文，直接问就行）
          </Typography>
          {aiThread.length > 0 && (
            <Stack spacing={1} sx={{ mb: 1.5 }}>
              {aiThread.map((m, i) => (
                <Typography
                  key={i}
                  variant="body2"
                  sx={{
                    alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                    bgcolor: m.role === 'user' ? 'action.selected' : 'transparent',
                    px: 1,
                    py: 0.5,
                    borderRadius: 1,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {m.role === 'user' ? `你：${m.content}` : m.content}
                </Typography>
              ))}
            </Stack>
          )}
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              fullWidth
              placeholder="例如：这个词在口语里怎么用？"
              value={aiInput}
              onChange={(e) => setAiInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void askAi();
                }
              }}
              disabled={aiBusy}
            />
            <Button variant="outlined" disabled={aiBusy || !aiInput.trim()} onClick={() => void askAi()}>
              {aiBusy ? <CircularProgress size={18} /> : '问'}
            </Button>
          </Stack>
        </Paper>
      )}

      {phase === 'done' && (
        <Paper sx={{ mt: 3, p: 3, textAlign: 'center' }}>
          {remaining === 0 && !error ? (
            <Alert severity="success" sx={{ mb: 2 }}>
              全部词都连续熟练 {QUIZ_GRADUATE_STREAK} 次以上——本轮计划完成！
            </Alert>
          ) : (
            <Alert severity="info" sx={{ mb: 2 }}>
              还剩 <strong>{remaining}</strong> 个词未毕业（连续熟练 {QUIZ_GRADUATE_STREAK} 次）。
              全部毕业即本轮计划结束。
            </Alert>
          )}
          <Typography variant="body2" color="text.secondary">
            本轮：熟练 {stats.skilled} 次 · 毕业 {stats.graduated} 词 · 今天过关 {stats.dayPassed} 词 ·
            新进特种训练 {stats.special} 词
          </Typography>
          <Stack direction="row" spacing={1} justifyContent="center" sx={{ mt: 2 }}>
            <Button variant="outlined" onClick={() => void start()}>
              再来一轮
            </Button>
            <Button variant="text" onClick={() => navigate('/')}>
              回首页
            </Button>
          </Stack>
        </Paper>
      )}
    </Box>
  );
}
