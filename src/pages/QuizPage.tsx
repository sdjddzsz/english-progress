/**
 * QuizPage —— 阶段一「由词选义」考查页（用户 2026-10-15 四阶段制）。
 *
 * 出题：单词（多义项词旁小灰字标词性）→ 4 选 1 词义（干扰项相似优先，见 features/quiz/distractors.ts）
 * 判定：按用时+对错四档（features/quiz/judging.ts）
 * 晋级：连续熟练 ≥ 阶段一阈值（默认 3，设置页可改）→ 进入阶段二（features/quiz/stages.ts）
 * 阶段池：该阶段全部词，同日已答不再出现（selectStagePool）；
 *   特种训练优先（连续不熟/生词 ≥3）。
 * 放行（用户 2026-10-15 改）：未达到「每轮过关挡位」的词排到队尾重来——
 *   连续达标 QUIZ_DAY_PASS_COUNT 次才放行；晋级/毕业（离开本阶段）立即放行。
 *   旧规则「答对一次就放行」与设置页挡位不匹配，已废弃。
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
import { displaySenses, normalizeSenses } from '../features/senses';
import type { BookWord, Word } from '../types/domain';
import {
  judgeAnswer,
  isSameUtcDay,
  QUIZ_DAY_PASS_COUNT,
  roundRelease,
  verdictChipSx,
  verdictLabel,
  type QuizVerdict,
} from '../features/quiz/judging';import {
  optionSuffix,
  type DistractorCandidate,
} from '../features/quiz/distractors';
import { applyStageChoiceResult, selectStagePool, STAGE_META } from '../features/quiz/stages';
import { buildQuestion } from '../features/quiz/question';
import { clearSession, loadSession, saveSession, toSnapshots } from '../features/quiz/session';
import { runOrQueue } from '../data/queue';
import { describeWriteError } from '../data/errorText';

interface QuizItem {
  bookWord: BookWord;
  word: Word;
  senseIndex: number;
  /** 已作答缓存（回顾上一题时按原样恢复：选项不重摇、判定不重算） */
  options?: DistractorCandidate[];
  correctKey?: string;
  verdict?: QuizVerdict;
  pickedKey?: string;
  askedAt?: number;
}

type Phase = 'loading' | 'quiz' | 'between' | 'done';

export default function QuizPage() {
  const navigate = useNavigate();
  const { activeBookId, userId, todayHits, completeHit } = useAppStore();
  const { aiChannel, aiBaseUrl, aiModel, quizAutoNext, quizDayThreshold, quizDailyLimit, stageGraduate } =
    useSettingsStore();
  const graduateStreak = stageGraduate[1];
  const { speakAuto, speak, loading, phaseLabel } = useTTS();
  const sfx = useSfx();
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  /** 写入被排入离线队列时的一次性轻提示（不弹红条阻断学习） */
  const [syncHint, setSyncHint] = useState('');
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

  /** 启动：优先恢复当天会话快照（用户 2026-10-15：中途退出重进回到原进度）；无快照才新建队列 */
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
      // 阶段一池：该阶段全部词、同日已答不再出（features/quiz/stages.ts）
      const stagePool = selectStagePool(all, 1, now);
      setRemaining(stagePool.length);

      // ===== 会话恢复：当天有快照 → 原样续做（顺序/进度/已答缓存都不动） =====
      const snap = loadSession(userId, bookId);
      if (snap) {
        const bwById = new Map(all.map((b) => [b.id, b]));
        const words = await repos.word.listWordsByIds([...new Set(snap.items.map((s) => s.wordId))]);
        const wordById = new Map(words.map((w) => [w.id, w]));
        const restored: QuizItem[] = [];
        for (const s of snap.items) {
          const bw = bwById.get(s.bookWordId);
          const word = wordById.get(s.wordId);
          if (!bw || !word) continue; // 词书重建等场景：该条丢弃
          restored.push({
            bookWord: bw,
            word,
            senseIndex: s.senseIndex,
            ...(s.options ? { options: s.options } : {}),
            ...(s.correctKey ? { correctKey: s.correctKey } : {}),
            ...(s.verdict ? { verdict: s.verdict } : {}),
            ...(s.pickedKey ? { pickedKey: s.pickedKey } : {}),
            ...(s.askedAt ? { askedAt: s.askedAt } : {}),
          });
        }
        if (restored.length > 0) {
          // 干扰池从本批词条义项重建（与新建时同源：池本来就是本批词的义项全集）
          const poolCands: DistractorCandidate[] = [];
          for (const w of words) {
            const bws = all.filter((bw) => bw.wordId === w.id);
            const order = bws[0] ? bws[0].listNo * 1000 + bws[0].orderInList : 0;
            displaySenses(w).forEach((sd, i) => {
              poolCands.push({
                zh: sd.zh,
                pos: sd.pos,
                lemma: w.lemma,
                ...(sd.ipa ? { ipa: sd.ipa } : {}),
                ...(sd.arpabet ? { arpabet: sd.arpabet } : {}),
                order,
                key: `${w.id}#${i}`,
              });
            });
          }
          poolRef.current = poolCands;
          setItems(restored);
          setIdx(Math.min(snap.idx, restored.length - 1));
          setTodayLeft(snap.todayLeft);
          setStats(snap.stats);
          setPhase('quiz');
          return;
        }
      }

      // ===== 新建当天队列 =====
      if (stagePool.length === 0) {
        setPhase('done');
        return;
      }
      const batch = stagePool.slice(0, quizDailyLimit);
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
        displaySenses(w).forEach((s, i) => {
          poolCands.push({
            zh: s.zh,
            pos: s.pos,
            lemma: w.lemma,
            ...(s.ipa ? { ipa: s.ipa } : {}),
            ...(s.arpabet ? { arpabet: s.arpabet } : {}),
            order,
            key: `${w.id}#${i}`,
          });
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
  }, [activeBookId, userId, quizDailyLimit]);

  useEffect(() => {
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 会话快照：items/idx/stats 变化即写（当天有效，隔天作废；答完一轮/隔天自动失效）
  useEffect(() => {
    if (phase !== 'quiz' || !userId || !activeBookId || items.length === 0) return;
    saveSession(userId, activeBookId, {
      items: toSnapshots(items),
      idx,
      stats,
      todayLeft,
    });
  }, [phase, userId, activeBookId, items, idx, stats, todayLeft]);

  // 会话结束（本轮完成）→ 清快照，下次「再来一轮」重新开
  useEffect(() => {
    if (phase === 'done' && userId && activeBookId) clearSession(userId, activeBookId);
  }, [phase, userId, activeBookId]);

  const current = items[idx] ?? null;

  /** 出题：构建四选项 + 重置计时；已答过的题按原样恢复（供「上一题」回顾） */
  useEffect(() => {
    if (phase !== 'quiz' || !current) return;
    if (current.options && current.correctKey) {
      // 回顾模式：选项不重摇、判定不重算、不重新计时、不自动朗读
      setSyncHint('');
      setOptions(current.options);
      setCorrectKey(current.correctKey);
      setVerdict(current.verdict ?? null);
      setPickedKey(current.pickedKey ?? '');
      showAtRef.current = current.askedAt ?? 0;
      return;
    }
    const built = buildQuestion(current, poolRef.current);
    if (!built) return;
    const askedAt = Date.now();
    setItems((its) =>
      its.map((it, i) =>
        i === idx ? { ...it, options: built.options, correctKey: built.correctKey, askedAt } : it,
      ),
    );
    setOptions(built.options);
    setCorrectKey(built.correctKey);
    setVerdict(null);
    setPickedKey('');
    setSyncHint('');
    showAtRef.current = askedAt;
    // 自动发音（用户 2026-10-14，遵循设置页「自动发音」开关）：出题即朗读。
    // 用户 2026-10-15：发音必须按义项音标（espeak 按 arpabet 音素合成、主轨按音素注入），
    // 只传 text 会变成按词形拼读——archives 这类词就读错。
    const pronounce = displaySenses(current.word)[current.senseIndex];
    void speakAuto(
      {
        text: current.word.lemma,
        ...(pronounce?.ipa ? { ipa: pronounce.ipa } : {}),
        ...(pronounce?.arpabet ? { arpabet: pronounce.arpabet } : {}),
        mode: 'word',
      },
      current.bookWord.wordId,
    );
  }, [phase, current, idx]);

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
    const firstQuizOfDay = !isSameUtcDay(bw.lastQuizAt, now);
    // ★ 四阶段制（用户 2026-10-15）：阶段走向是唯一权威（晋级/特训/层升降都在 stages.ts 引擎里）
    const sp = applyStageChoiceResult(bw, v, graduateStreak, now);
    const graduated = sp.stage !== bw.stage; // 阶段一毕业 → 晋级阶段二
    // 每轮过关计数（用户 2026-10-15）：连续达标才放行；跨天重新起算；
    // 晋级/毕业立即放行。quizDayPassed 只在真正达到过关线时才写 true
    // （旧实现答过就写 true，「今日已过关」展示名不副实）
    const { dayStreak: nextDayStreak, release } = roundRelease({
      verdict: v,
      prevStreak: bw.quizDayStreak ?? 0,
      threshold: quizDayThreshold,
      lastQuizAt: bw.lastQuizAt,
      leftStage: graduated,
      now,
    });
    // 本地行状态同步更新（重现题/同词再次作答时用的不再是 start() 时的旧快照，
    // 否则连续达标计数会算错：错→认识→熟练 应累计 2 次，旧快照会算成 1）
    const nextBw: BookWord = {
      ...bw,
      tier: sp.tier,
      streak: sp.streak,
      failStreak: sp.failStreak,
      specialTraining: sp.specialTraining,
      lastQuizAt: sp.lastQuizAt,
      quizDayStreak: nextDayStreak,
      quizDayPassed: nextDayStreak >= QUIZ_DAY_PASS_COUNT,
      stage: sp.stage,
      stageStreak: sp.stageStreak,
    };
    // 作答结果先写入本题缓存（「上一题」回顾的原样恢复依赖它）
    setItems((its) =>
      its.map((it, i) => (i === idx ? { ...it, bookWord: nextBw, verdict: v, pickedKey: key } : it)),
    );
    // 未达过关线的词排到队尾重来，直到达到「每轮过关挡位」才放行；
    // 晋级/毕业的词已离开本阶段池，立即放行不再排回
    if (!release) {
      const senseIndex = Math.floor(Math.random() * normalizeSenses(current.word).length);
      setItems((its) => [...its, { bookWord: nextBw, word: current.word, senseIndex }]);
    }
    const quizPatch = {
      tier: sp.tier,
      streak: sp.streak,
      failStreak: sp.failStreak,
      specialTraining: sp.specialTraining,
      lastQuizAt: sp.lastQuizAt,
      quizDayStreak: nextDayStreak,
      quizDayPassed: nextDayStreak >= QUIZ_DAY_PASS_COUNT,
      stage: sp.stage,
      stageStreak: sp.stageStreak,
    };
    try {
      // 走离线队列统一入口：云端缺列（PGRST204）/ 断网时不弹红条阻断学习，
      // 失败入 pending_ops 等待补传（2026-10-15 排查：线上库缺 quizDayPassed 列，
      // 直写必失败 ⇒ 进度永不保存 ⇒ 待完成永远不降。详见 docs/交接-2026-10-15.md）。
      const outcome = await runOrQueue(
        'bookWord.quiz',
        { bookWordId: bw.id, patch: quizPatch },
        async () => {
          await getRepos().word.updateBookWordQuiz(bw.id, quizPatch);
        },
      );
      if (outcome === 'queued') setSyncHint('本条进度已存本机，联网后自动同步');
      setStats((s) => ({
        skilled: s.skilled + (v === 'skilled' ? 1 : 0),
        graduated: s.graduated + (graduated ? 1 : 0),
        special: s.special + (sp.specialTraining && !bw.specialTraining ? 1 : 0),
        dayPassed: s.dayPassed + (firstQuizOfDay ? 1 : 0),
        total: s.total,
      }));
      if (firstQuizOfDay) setRemaining((r) => Math.max(0, r - 1));
      if (firstQuizOfDay) setTodayLeft((n) => Math.max(0, n - 1));
      // 今天答过 → 同步消掉旧计划制今日队列里该词的任务（联动项见 docs/联动清单.md #5）。
      // 完成一条 pending 即可（同词在今日队列里可能被排进多个模态，消掉一条就算当天交代过了）。
      if (firstQuizOfDay) {
        const hit = todayHits.find((h) => h.wordId === bw.wordId && h.status === 'pending');
        if (hit) await completeHit(hit.id);
      }
    } catch (e) {
      setError(describeWriteError(e));
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
    return displaySenses(current.word)[current.senseIndex];
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
      const allSenses = displaySenses(current.word)
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
      <Typography variant="h5">{STAGE_META[1].name}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        看单词选词义：3 秒内选对=熟练，3-5 秒=认识，5-7 秒=不熟，超时或选错=生词。
        连续熟练 {graduateStreak} 次晋级阶段二；不限每天一轮，完成一轮可立即再来一轮；
        没达到「每轮过关挡位」的词会排到队尾重来，连续达标 {QUIZ_DAY_PASS_COUNT} 次才放行（晋级立即放行）。
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
          {/* 单词一行、音标/喇叭/词性一行（用户 2026-10-15：窄屏挤成一团，长内容必须自动换行） */}
          <Stack spacing={0.5} alignItems="center" sx={{ width: '100%' }}>
            <Typography variant="h4" sx={{ overflowWrap: 'anywhere', textAlign: 'center', maxWidth: '100%' }}>
              {current.word.lemma}
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" flexWrap="wrap" useFlexGap sx={{ maxWidth: '100%' }}>
              {/* 音标允许任意断行（音标是一整个无空格 token，必须 anywhere 才能换） */}
              {senseOf.ipa && (
                <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  /{senseOf.ipa}/
                </Typography>
              )}
              {/* 喇叭（用户 2026-10-14）：出题已自动朗读（遵循 autoSpeak 开关），这里补手动入口。
                  用户 2026-10-15：按义项音标发音，不按词形拼读 */}
              <Tooltip title={loading ? phaseLabel : '发音'}>
                <span>
                  <IconButton
                    size="small"
                    disabled={loading}
                    aria-label="play quiz word"
                    onClick={() => {
                      const p = displaySenses(current.word)[current.senseIndex];
                      void speak(
                        {
                          text: current.word.lemma,
                          ...(p?.ipa ? { ipa: p.ipa } : {}),
                          ...(p?.arpabet ? { arpabet: p.arpabet } : {}),
                          mode: 'word',
                        },
                        current.bookWord.wordId,
                      );
                    }}
                  >
                    {loading ? <CircularProgress size={18} /> : <VolumeUpIcon fontSize="small" />}
                  </IconButton>
                </span>
              </Tooltip>
              {/* 读取中/合成中只放 Tooltip 等于看不见（自动朗读时无人悬停），明面显示 */}
              {loading && (
                <Typography variant="caption" color="text.secondary">
                  {phaseLabel}
                </Typography>
              )}
              {multiSense && senseOf.pos && (
                <Typography variant="body2" color="text.secondary">
                  {senseOf.pos}
                </Typography>
              )}
            </Stack>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, textAlign: 'center' }}>
            今日考查 <strong>{stats.total}</strong> 词（按生疏度挑出，特种训练优先）
            · 答错重排 <strong>{items.length - idx - 1}</strong> 题在后面 · 不限每天一轮
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
              // 判定后点任意选项 = 朗读该选项所属单词（用户 2026-10-15：答完想听哪个就点哪个，
              // 且按该义项的音标发音，不按词形拼读）
              const playOption = (): void => {
                if (!o.lemma) return;
                void speak(
                  {
                    text: o.lemma,
                    ...(o.ipa ? { ipa: o.ipa } : {}),
                    ...(o.arpabet ? { arpabet: o.arpabet } : {}),
                    mode: 'word',
                  },
                  o.key.split('#')[0],
                );
              };
              return (
                <Tooltip
                  key={o.key}
                  title={showState ? `朗读 ${o.lemma}` : ''}
                  placement="left"
                >
                  <Button
                    fullWidth
                    // 判定后不用 disabled（MUI 的 .Mui-disabled 样式优先级高于 sx，
                    // 会把自定义绿/红底色盖成灰——2026-10-14 截图色块异常的根源）：
                    // 保持 outlined + sx 全量接管配色。判定后可点（朗读该词），不触发新判定。
                    variant="outlined"
                    disableElevation
                    onClick={showState ? playOption : () => void answer(o.key)}
                    aria-label={showState ? `朗读 ${o.lemma}` : undefined}
                    sx={{
                      justifyContent: 'flex-start',
                      textTransform: 'none',
                      py: 1.2,
                      ...(showState ? { border: '1px solid', ...softStyle } : {}),
                    }}
                  >
                    {mark}
                    {o.pos ? `${o.pos} ` : ''}
                    {o.zh}
                    {/* 判定后显示该释义所属词形（用户 2026-10-15：选错也要知道干扰项是哪个词） */}
                    {showState && optionSuffix(o, true) && (
                      <Typography
                        component="span"
                        variant="caption"
                        sx={{ ml: 1, opacity: 0.7, textTransform: 'none' }}
                      >
                        {optionSuffix(o, showState)}
                      </Typography>
                    )}
                  </Button>
                </Tooltip>
              );
            })}
          </Stack>
          {verdict && (
            <Stack spacing={1.5} alignItems="center" sx={{ mt: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip label={verdictLabel(verdict)} size="small" sx={verdictChipSx(verdict)} />
                <Typography variant="body2" color="text.secondary">
                  {verdict === 'skilled'
                    ? `继续，连对 ${graduateStreak} 次就进下一阶段`
                    : '这个词标记后会更频繁出现'}
                </Typography>
              </Stack>
              {/* 该词全部释义（用户 2026-10-15：多义词每次只抽一个义项考，
                  出答案时必须完整显示——答对答错都一样，不然永远只看到被考的那个意思） */}
              <Box sx={{ width: '100%', textAlign: 'left' }}>
                <Typography variant="caption" color="text.secondary">
                  {current.word.lemma} 的全部释义（本题考的是第 {current.senseIndex + 1} 个）：
                </Typography>
                <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                  {displaySenses(current.word).map((sd, i) => (
                    <Typography
                      key={sd.senseId}
                      variant="body2"
                      sx={{
                        color: i === current.senseIndex ? 'text.primary' : 'text.secondary',
                        fontWeight: i === current.senseIndex ? 600 : 400,
                      }}
                    >
                      {i + 1}. {sd.pos ? `[${sd.pos}] ` : ''}
                      {sd.zh}
                      {i === current.senseIndex ? ' ← 本题' : ''}
                    </Typography>
                  ))}
                </Stack>
              </Box>
              {syncHint && (
                <Typography variant="caption" color="text.secondary">
                  {syncHint}
                </Typography>
              )}
              <Stack direction="row" spacing={1} alignItems="center">
                {/* 上一题（用户 2026-10-15：点错时回看上一词——恢复原选项与判定，不重摇不重判） */}
                <Button
                  variant="outlined"
                  disabled={idx === 0}
                  onClick={() => setIdx((i) => Math.max(0, i - 1))}
                >
                  上一题
                </Button>
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
              阶段一的词这轮都过了一遍——可以立即再来一轮。
            </Alert>
          ) : (
            <Alert severity="info" sx={{ mb: 2 }}>
              还剩 <strong>{remaining}</strong> 个词在阶段一池里。
            </Alert>
          )}
          <Typography variant="body2" color="text.secondary">
            本轮：熟练 {stats.skilled} 次 · 晋级 {stats.graduated} 词 · 答过 {stats.dayPassed} 词 ·
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
