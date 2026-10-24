/**
 * QuizPage —— 阶段一「由词选义」考查页（用户 2026-10-15 四阶段制）。
 *
 * 出题：单词（多义项词旁小灰字标词性）→ 4 选 1 词义（干扰项相似优先，见 features/quiz/distractors.ts）
 * 判定：按用时+对错四档（features/quiz/judging.ts）
 * 晋级：每轮首次遇见且熟练（首熟）累计 ≥ 阶段一阈值（默认 3，设置页可改）→ 进入阶段二（features/quiz/stages.ts）
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
import FormControl from '@mui/material/FormControl';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
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
import { chatTurn, listModels, type LLMModelInfo } from '../ai/llmClient';
import { clampSenseIndex, displaySenses, normalizeSenses } from '../features/senses';
import type { BookWord, Word } from '../types/domain';
import {
  judgeAnswer,
  isSameUtcDay,
  QUIZ_DAY_PASS_COUNT,
  roundRelease,
  thresholdLineLabel,
  verdictChipSx,
  verdictLabel,
  type QuizVerdict,
} from '../features/quiz/judging';import {
  optionSuffix,
  type DistractorCandidate,
} from '../features/quiz/distractors';
import { applyStageChoiceResult, enteringRound, selectStagePool, STAGE_GRADUATE_LABEL, STAGE_META } from '../features/quiz/stages';
import { buildQuestion } from '../features/quiz/question';
import { clearSession, loadSession, restoreSnapshotItem, saveSession, toSnapshots } from '../features/quiz/session';
import { runOrQueue } from '../data/queue';
import { describeWriteError } from '../data/errorText';
import { useLongPress } from '../hooks/useLongPress';
import WordNoteButton from '../components/notes/WordNoteButton';
import SenseListSection from '../components/word/SenseListSection';
import WordExamplesSection from '../components/word/WordExamplesSection';
import QuizTimerBadge from '../components/word/QuizTimerBadge';
import SenseEditDialog from '../components/word/SenseEditDialog';
import IpaEditDialog from '../components/word/IpaEditDialog';
import PressableIpa from '../components/word/PressableIpa';
import VoiceOverrideDialog from '../components/tts/VoiceOverrideDialog';
import { voiceLabelOf } from '../tts/voiceOptions';
import { useWordExamples } from '../hooks/useWordExamples';

interface QuizItem {
  bookWord: BookWord;
  word: Word;
  senseIndex: number;
  /** 本轮内第几次作答该词（1=第一次；用户 2026-10-17：首答即达标 → 一遍过，达标线=设置页「每轮过关挡位」） */
  attemptNo: number;
  /** 本次作答后该词是否已放行（一遍过/连续达标/晋级）——进度显示用 */
  released?: boolean;
  /** 本次作答是否晋级（阶段毕业）——进度显示用 */
  promoted?: boolean;
  /** 已作答缓存（回顾上一题时按原样恢复：选项不重摇、判定不重算） */
  options?: DistractorCandidate[];
  correctKey?: string;
  verdict?: QuizVerdict;
  pickedKey?: string;
  askedAt?: number;
  /** 答题那一刻的用时毫秒（用户 2026-10-19：答题后计时定格显示） */
  elapsedMs?: number;
}

type Phase = 'loading' | 'quiz' | 'between' | 'done';

export default function QuizPage() {
  const navigate = useNavigate();
  const { activeBookId, userId, todayHits, completeHit, noteQuizAnswer, patchWord } = useAppStore();
  const { aiChannel, aiBaseUrl, aiModel, quizAutoNext, quizDayThreshold, firstPassThreshold, quizDailyLimit, stageGraduate } =
    useSettingsStore();
  const graduateStreak = stageGraduate[1];
  const { speakAuto, speak, resynthesize, loading, phaseLabel, voiceOverride, setVoiceOverride, getEffectiveVoiceModel } = useTTS();
  const sfx = useSfx();
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  /** 写入被排入离线队列时的一次性轻提示（不弹红条阻断学习） */
  const [syncHint, setSyncHint] = useState('');
  // 长按释义编辑（用户 2026-10-18）：当前在编辑第几个义项
  const [senseEditIdx, setSenseEditIdx] = useState<number | null>(null);
  // 长按音标编辑读音（用户 2026-10-24）：当前在改第几个义项的读音
  const [pronEditIdx, setPronEditIdx] = useState<number | null>(null);
  // 「+ 增加词义」新增弹窗（用户 2026-10-19）：与编辑走同一个 SenseEditDialog（mode="add"）
  const [senseAddOpen, setSenseAddOpen] = useState(false);
  // 考查计时（用户 2026-10-19）：出题即走秒（useAnswerTimer），答题即定格
  const [quizStartedAt, setQuizStartedAt] = useState(0);
  // 长按「重新合成」→ 模型/音色临换面板（用户 2026-10-18）
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const resynthLongPress = useLongPress(() => setVoicePickerOpen(true));
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
  // 临时模型（用户 2026-10-17）：只在本轮生效（除非再换），不写回设置——
  // 防止某个模型宕机时临时切换应急；下次进页面仍从设置页默认模型开始
  const [sessionModel, setSessionModel] = useState('');
  const [modelOptions, setModelOptions] = useState<LLMModelInfo[]>([]);
  const [modelsErr, setModelsErr] = useState('');
  const effectiveModel = sessionModel || aiModel || 'step-5-preview';

  /** 启动：优先恢复当天会话快照（用户 2026-10-15：中途退出重进回到原进度）；无快照才新建队列 */
  const start = useCallback(async () => {
    if (!userId) return;
    // 新一轮开局：临时模型/音色覆盖复位（「临时固定本轮」——新 round 回到设置页配置）
    setVoiceOverride(null);
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
        for (const raw of snap.items) {
          const bw = bwById.get(raw.bookWordId);
          const word = wordById.get(raw.wordId);
          if (!bw || !word) continue; // 词书重建等场景：该条丢弃
          // 删释义后的坏快照净化（2026-10-18）：越界 senseIndex 收敛 + 未作答的丢旧选项重出
          const s = restoreSnapshotItem(raw, word);
          restored.push({
            bookWord: bw,
            word,
            senseIndex: s.senseIndex,
            attemptNo: s.attemptNo ?? 1,
            ...(s.released !== undefined ? { released: s.released } : {}),
            ...(s.promoted !== undefined ? { promoted: s.promoted } : {}),
            ...(s.options ? { options: s.options } : {}),
            ...(s.correctKey ? { correctKey: s.correctKey } : {}),
            ...(s.verdict ? { verdict: s.verdict } : {}),
            ...(s.pickedKey ? { pickedKey: s.pickedKey } : {}),
            ...(s.askedAt ? { askedAt: s.askedAt } : {}),
            ...(s.elapsedMs !== undefined ? { elapsedMs: s.elapsedMs } : {}),
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
          // 今日检测统计补登（用户 2026-10-23）：快照里已作答的词刷新后仍算「今天检测过」
          // （attemptNo===1 的才算第一次出现；lastQuizAt 播种只补得过词、补不了首答）
          for (const it of restored) {
            if (it.verdict !== undefined) noteQuizAnswer(it.bookWord.wordId, it.attemptNo);
          }
          return;
        }
      }

      // ===== 新建当天队列 =====
      if (stagePool.length === 0) {
        setPhase('done');
        return;
      }
      const batch = stagePool.slice(0, quizDailyLimit);
      // 新一轮开局：轮标线归零（用户 2026-10-18「进入新一轮的单词得从零开始计数」）。
      // 本地先换成 0（题旁立刻显示 0/3）；落库走离线队列——断网/云端缺列时入
      // pending_ops 补传（C1：旧实现 try/catch 静默吞，云端残留旧值、跨设备语义不一致；
      // 补传带 skipAnsweredSince，入队后又答过的词以作答写回为权威，不被归零误伤）。
      const resetOutcome = await runOrQueue(
        'bookWord.roundReset',
        { ids: batch.map((bw) => bw.id), since: new Date().toISOString() },
        async () => {
          await repos.word.resetRoundStreaks(batch.map((bw) => bw.id));
        },
      );
      if (resetOutcome === 'queued') setSyncHint('本轮过关计数归零已存本机，联网后自动同步');
      const roundBatch = batch.map(enteringRound);
      const words = await repos.word.listWordsByIds(roundBatch.map((bw) => bw.wordId));
      const wordById = new Map(words.map((w) => [w.id, w]));
      const quizItems: QuizItem[] = roundBatch
        .filter((bw) => wordById.has(bw.wordId))
        .map((bw) => {
          const word = wordById.get(bw.wordId) as Word;
          const senseIndex = Math.floor(Math.random() * normalizeSenses(word).length);
          return { bookWord: bw, word, senseIndex, attemptNo: 1 };
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

  // 刷新直接进 /quiz：子组件 effect 先于 App 顶层 bootstrap 执行，userId 还没就位。
  // 旧实现空依赖只跑一次、start 里 !userId 直接返回 ⇒ phase 永远卡 'loading'（一直转圈，
  // 去首页把 bootstrap 跑完再进来才好——用户 2026-10-18 实测）。改为就绪后再起，
  // startedRef 保证每次挂载只起一次（store 就绪前反复重跑没有意义）。
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    if (!userId || !activeBookId) return;
    startedRef.current = true;
    void start();
  }, [userId, activeBookId, start]);

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

  // 当前词的用户例句（用户 2026-10-22）：加载 / AI 生成 / 删除。
  // 生成模型跟随问答框的临时模型下拉（用户 2026-10-23：一处选择两处生效），空=设置页默认
  const examplesApi = useWordExamples(current?.bookWord.wordId ?? null, current?.word.lemma ?? '', sessionModel);

  /** 菜单「生成例句」：为第 senseIndex 个义项的第 subZh 条意思生成一条（追加，不覆盖） */
  const handleGenerateExample = async (senseIndex: number, subZh?: string): Promise<void> => {
    if (!current) return;
    const sense = displaySenses(current.word)[senseIndex];
    if (!sense) return;
    await examplesApi.generate(sense, subZh);
  };

  /** 例句朗读：走 TTS 主轨（AI 发音），与单词同一编排链 */
  const speakExample = (en: string): void => {
    if (!current) return;
    void speak({ text: en, mode: 'sentence' }, current.bookWord.wordId);
  };

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
      // 已答 ⇒ 计时徽标定格显示当时的用时（elapsedMs），不重新走秒
      setQuizStartedAt(current.askedAt ?? 0);
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
    // 新题 ⇒ 计时从出题这一刻重新走秒
    setQuizStartedAt(askedAt);
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
    // 今日检测统计（用户 2026-10-23）：答过的词都计入；attemptNo===1 = 第一次出现
    noteQuizAnswer(current.bookWord.wordId, current.attemptNo);
    const bw = current.bookWord;
    const now = new Date();
    const firstQuizOfDay = !isSameUtcDay(bw.lastQuizAt, now);
    // ★ 四阶段制（用户 2026-10-15）：阶段走向是唯一权威（晋级/特训/层升降都在 stages.ts 引擎里）
    // 毕业线判定固定「熟练」（阶段毕业设置只配次数）——绝不传每轮挡位（2026-10-18 事故）
    const sp = applyStageChoiceResult(bw, v, graduateStreak, now, current.attemptNo);
    const graduated = sp.stage !== bw.stage; // 阶段一毕业 → 晋级阶段二
    // 每轮过关计数（用户 2026-10-15）：连续达标才放行；跨天重新起算；
    // 晋级/毕业立即放行。quizDayPassed 只在真正达到过关线时才写 true
    // （旧实现答过就写 true，「今日已过关」展示名不副实）
    const { dayStreak: nextDayStreak, release } = roundRelease({
      verdict: v,
      prevStreak: bw.quizDayStreak ?? 0,
      threshold: quizDayThreshold,
      firstPassThreshold,
      lastQuizAt: bw.lastQuizAt,
      leftStage: graduated,
      attemptNo: current.attemptNo,
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
    // 作答结果先写入本题缓存（「上一题」回顾的原样恢复依赖它）；released 供进度显示；
    // elapsedMs 定格本题用时（用户 2026-10-19：答题后计时停在几秒就显示几秒）
    setItems((its) =>
      its.map((it, i) =>
        i === idx
          ? { ...it, bookWord: nextBw, verdict: v, pickedKey: key, elapsedMs: elapsed, released: release, promoted: graduated }
          : it,
      ),
    );
    // 未放行的词排到队尾重来，直到达到「每轮过关挡位」才放行；
    // 晋级/毕业的词已离开本阶段池，立即放行不再排回
    if (!release) {
      const senseIndex = Math.floor(Math.random() * normalizeSenses(current.word).length);
      setItems((its) => [
        ...its,
        { bookWord: nextBw, word: current.word, senseIndex, attemptNo: current.attemptNo + 1 },
      ]);
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
      // 本轮第一次露面（用户 2026-10-24）：写一次 firstSeenAt，之后任何作答都不覆盖
      // （bw.firstSeenAt 已有值 = 之前某轮/某设备写过）。答题写回本来就要发生，零额外请求。
      ...(current.attemptNo === 1 && !bw.firstSeenAt ? { firstSeenAt: sp.lastQuizAt } : {}),
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

  // 模型下拉选项（用户 2026-10-17）：进页面拉一次，拉不到也能用默认模型，只显示原因
  useEffect(() => {
    let alive = true;
    listModels({ channel: aiChannel, ...(aiBaseUrl ? { baseUrl: aiBaseUrl } : {}) })
      .then((ms) => {
        if (alive) setModelOptions(ms);
      })
      .catch((e) => {
        if (alive) setModelsErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [aiChannel, aiBaseUrl]);

  /**
   * AI 问答：角色 + 当前屏幕内容自动注入 system，用户只管问。
   * 2026-10-17 增强：模型可下拉临时切换（只本轮有效）；正在思考有明面状态；
   * 消息支持编辑/从某条重新问（参照主流 AI 应用）。
   */
  const askAiWith = async (
    q: string,
    history: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<void> => {
    if (!current || !senseOf || aiBusy || q.trim() === '') return;
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
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: q },
        ],
        { model: effectiveModel, channel: aiChannel, ...(aiBaseUrl ? { baseUrl: aiBaseUrl } : {}) },
      );
      setAiThread([
        ...history,
        { role: 'user', content: q },
        { role: 'assistant', content: result.content || '（模型未返回内容）' },
      ]);
    } catch (e) {
      setAiThread([
        ...history,
        { role: 'user', content: q },
        { role: 'assistant', content: `问答失败：${e instanceof Error ? e.message : String(e)}` },
      ]);
    } finally {
      setAiBusy(false);
    }
  };

  const askAi = async (): Promise<void> => {
    const q = aiInput.trim();
    if (q === '') return;
    setAiInput('');
    await askAiWith(q, aiThread);
  };

  /** 编辑已发消息：内容回输入框、对话截断到该条之前 */
  const editMsg = (i: number): void => {
    const m = aiThread[i];
    if (!m || m.role !== 'user' || aiBusy) return;
    setAiInput(m.content);
    setAiThread(aiThread.slice(0, i));
  };

  /** 从某条已发消息重新问：丢弃该条之后的全部消息再重发 */
  const regenFrom = async (i: number): Promise<void> => {
    const m = aiThread[i];
    if (!m || m.role !== 'user' || aiBusy) return;
    const history = aiThread.slice(0, i);
    setAiThread(history);
    await askAiWith(m.content, history);
  };

  /** 重新生成最后一条回答 */
  const regenLast = async (): Promise<void> => {
    if (aiBusy || aiThread.length === 0) return;
    const last = aiThread[aiThread.length - 1];
    if (last.role === 'user') {
      await regenFrom(aiThread.length - 1);
      return;
    }
    // 末尾是助手回答：找到它前面最近的一条用户消息重发
    for (let i = aiThread.length - 2; i >= 0; i--) {
      if (aiThread[i].role === 'user') {
        await regenFrom(i);
        return;
      }
    }
  };

  return (
    <Box p={2} pb={4} maxWidth={720} mx="auto">
      <Typography variant="h5">{STAGE_META[1].name}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        判定：3秒内=熟练 · 3-5秒=认识 · 5-7秒=不熟 · 超时/错=生词。放行/晋级线取设置页配置；不限每天一轮。
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
        <Paper sx={{ mt: 3, p: 2 }}>
          <LinearProgress
            variant="determinate"
            value={(idx / Math.max(1, items.length)) * 100}
            sx={{ mb: 1 }}
          />
          {/* 上一题/下一题（用户 2026-10-22：移到题卡上方——一屏能多显示内容；
              原位置（释义下方）改放「例句」区块） */}
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" sx={{ mb: 1 }}>
            {/* 上一题（用户 2026-10-15：点错时回看上一词——恢复原选项与判定，不重摇不重判） */}
            <Button
              variant="outlined"
              size="small"
              disabled={idx === 0}
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
            >
              上一题
            </Button>
            {/* 手动下一题（quizAutoNext 关时显示，默认关——答完可看清对错与正确答案再走） */}
            {!quizAutoNext && (
              <Button
                variant="contained"
                size="small"
                onClick={() => {
                  if (idx + 1 >= items.length) setPhase('done');
                  else setIdx((i) => i + 1);
                }}
              >
                {idx + 1 >= items.length ? '看总结' : '下一题'}
              </Button>
            )}
          </Stack>
          {/* 单词+计时一行，音标/喇叭/词性一行（2026-10-20：计时贴单词旁；窄屏自动换行） */}
          <Stack spacing={0.5} alignItems="center" sx={{ width: '100%' }}>
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" flexWrap="wrap" useFlexGap sx={{ maxWidth: '100%' }}>
              <Typography variant="h4" sx={{ overflowWrap: 'anywhere', textAlign: 'center', maxWidth: '100%' }}>
                {current.word.lemma}
              </Typography>
              {/* 考查计时（2026-10-20：贴单词旁，不再跟在音标后；出题即走秒，答题即停） */}
              <QuizTimerBadge startedAt={quizStartedAt} running={verdict === null} frozenMs={current?.elapsedMs ?? null} />
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" flexWrap="wrap" useFlexGap sx={{ maxWidth: '100%' }}>
              {/* 音标允许任意断行（音标是一整个无空格 token，必须 anywhere 才能换）。
                  长按可改（用户 2026-10-24：fine 的音标错了要能就地修） */}
              {senseOf.ipa && (
                <PressableIpa ipa={senseOf.ipa} onEdit={() => setPronEditIdx(current.senseIndex)} />
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
              {/* 重新合成（用户 2026-10-17）：个别词缓存读音是错的——删本地+云端缓存后重录，
                  合成成功自动回传云端，其它设备也拿到新读音。
                  长按（用户 2026-10-18）：临时换模型/音色，只固定本轮；单击照旧重录 */}
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
                    disabled={loading}
                    aria-label={`resynthesize ${current.word.lemma}`}
                    onClick={() => {
                      // 长按已开临换面板——同一次手势的 click 不再触发重录
                      if (resynthLongPress.consumeFired()) return;
                      const p = displaySenses(current.word)[current.senseIndex];
                      void resynthesize(
                        {
                          text: current.word.lemma,
                          ...(p?.ipa ? { ipa: p.ipa } : {}),
                          ...(p?.arpabet ? { arpabet: p.arpabet } : {}),
                          mode: 'word',
                        },
                        current.bookWord.wordId,
                      );
                    }}
                    {...resynthLongPress}
                  >
                    {loading ? <CircularProgress size={18} /> : <AutorenewIcon fontSize="small" />}
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
              {/* 读取中/合成中不再显示明面文字（2026-10-20：加载完成瞬间文字消失会导致
                  整行回流、选项位移，答完瞬间点击就点错）——喇叭上的转圈+悬停提示足够 */}
              {multiSense && senseOf.pos && (
                <Typography variant="body2" color="text.secondary">
                  {senseOf.pos}
                </Typography>
              )}
              {/* 题旁笔记（用户 2026-10-17）：一词一记，点开即编辑 */}
              <WordNoteButton
                wordId={current.bookWord.wordId}
                lemma={current.word.lemma}
                source="quiz:1"
                senseIndex={current.senseIndex}
              />
            </Stack>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, textAlign: 'center' }}>
            今日 {stats.total} 词 · 剩 {items.length - idx - 1} 题
          </Typography>
          <Stack spacing={1} sx={{ mt: 2 }}>
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
              </Stack>
              {/* 双线进度（2026-10-20：并成一行省屏） */}
              <Typography
                variant="body2"
                sx={{
                  width: '100%',
                  textAlign: 'center',
                  color: current.promoted ? 'success.main' : 'text.secondary',
                }}
              >
                轮线 {Math.min(current.bookWord.quizDayStreak ?? 0, QUIZ_DAY_PASS_COUNT)}/{QUIZ_DAY_PASS_COUNT}（{thresholdLineLabel(quizDayThreshold)}）
                {current.released
                  ? current.promoted
                    ? ' · 已晋级'
                    : (current.bookWord.quizDayStreak ?? 0) >= QUIZ_DAY_PASS_COUNT
                      ? ' · 已过关'
                      : ' · 首答即达标一遍过'
                  : ''}
                {' '}· 毕业线 {current.promoted ? graduateStreak : current.bookWord.stageStreak}/{graduateStreak}（首见{STAGE_GRADUATE_LABEL}）
                {current.promoted ? ' · 已晋级下一阶段' : ''}
              </Typography>
              {/* 该词全部释义（用户 2026-10-15：多义词每次只抽一个义项考，
                  出答案时必须完整显示——答对答错都一样，不然永远只看到被考的那个意思；
                  2026-10-18：长按/右键弹菜单（编辑义项/生成例句）；2026-10-19：可当场增加词义；
                  2026-10-22：菜单加「生成例句」，每次生成追加一条、可删）。
                  改动一律写回词书（SenseEditDialog → updateWordSenses 整行 upsert） */}
              <SenseListSection
                word={current.word}
                currentSenseIndex={current.senseIndex}
                onEditSense={setSenseEditIdx}
                onDeleteSense={setSenseEditIdx}
                onAdd={() => setSenseAddOpen(true)}
                onGenerateExample={(i, subZh) => void handleGenerateExample(i, subZh)}
                onEditSensePron={setPronEditIdx}
                genBusy={examplesApi.genBusy}
              />
              {/* 用户例句（用户 2026-10-22：AI 生成 / AI 朗读 / 可删）。
                  占原上/下一题按钮位置——按钮已移到题卡上方 */}
              <WordExamplesSection
                word={current.word}
                examples={examplesApi.examples}
                genBusy={examplesApi.genBusy}
                error={examplesApi.error}
                speaking={loading}
                onSpeak={speakExample}
                onRemove={(id) => void examplesApi.remove(id)}
              />
              {syncHint && (
                <Typography variant="caption" color="text.secondary">
                  {syncHint}
                </Typography>
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

      {/* AI 问答框（用户 2026-10-14 第 5 条）：随当前考查词走，模型自动知道屏幕内容。
          2026-10-17 增强：模型下拉临时切换（只本轮生效）、正在思考明面状态、
          消息编辑/重新生成（参照主流 AI 应用） */}
      {phase === 'quiz' && current && (
        <Paper sx={{ mt: 2, p: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap>
            <Typography variant="body2" color="text.secondary">
              问 AI（自动带上当前词，直接问就行）· 临时模型同时用于「生成例句」
            </Typography>
            <FormControl size="small" sx={{ minWidth: 180 }}>
              <Select
                value={sessionModel}
                displayEmpty
                onChange={(e) => setSessionModel(e.target.value)}
                aria-label="AI 模型（本轮临时选择）"
              >
                <MenuItem value="">默认模型（{effectiveModel}）</MenuItem>
                {modelOptions
                  .filter((m) => !m.disabled && m.id !== (aiModel || 'step-5-preview'))
                  .map((m) => (
                    <MenuItem key={m.id} value={m.id}>
                      {m.id}
                    </MenuItem>
                  ))}
              </Select>
            </FormControl>
          </Stack>
          {modelsErr && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              模型列表拉取失败（仍可用默认模型）：{modelsErr}
            </Typography>
          )}
          {/* 正在思考/生成中：明面显示，看得出消息已发出、模型在干活 */}
          {aiBusy && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
              <CircularProgress size={14} />
              <Typography variant="caption" color="primary">
                正在思考 / 生成中…
              </Typography>
            </Stack>
          )}
          {aiThread.length > 0 && (
            <Stack spacing={1} sx={{ mt: 1.5, mb: 1.5 }}>
              {aiThread.map((m, i) => (
                <Box key={i} sx={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '95%' }}>
                  <Typography
                    variant="body2"
                    sx={{
                      display: 'inline-block',
                      bgcolor: m.role === 'user' ? 'action.selected' : 'transparent',
                      px: 1,
                      py: 0.5,
                      borderRadius: 1,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {m.role === 'user' ? `你：${m.content}` : m.content}
                  </Typography>
                  {/* 消息操作（用户 2026-10-17）：已发消息可编辑/重新问，回答可复制/重新生成 */}
                  {!aiBusy && m.role === 'user' && (
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      <Button size="small" sx={{ minWidth: 0, px: 1 }} onClick={() => editMsg(i)}>
                        编辑
                      </Button>
                      <Button size="small" sx={{ minWidth: 0, px: 1 }} onClick={() => void regenFrom(i)}>
                        重新问
                      </Button>
                    </Stack>
                  )}
                  {!aiBusy && m.role === 'assistant' && i === aiThread.length - 1 && (
                    <Button size="small" sx={{ minWidth: 0, px: 1 }} onClick={() => void regenLast()}>
                      重新生成
                    </Button>
                  )}
                </Box>
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

      {/* 长按释义 → 编辑/删除（写回词书；保存后换掉内存里的旧 Word，界面立即刷新） */}
      <SenseEditDialog
        word={current?.word ?? null}
        senseIndex={senseEditIdx}
        mode="edit"
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
      {/* 「+ 增加词义」（用户 2026-10-19）：词书漏义项当场补，保存即写回词书。
          add 模式 open 由 word 非空推导 ⇒ 没打开时传 null，别让弹窗常驻 */}
      <SenseEditDialog
        word={senseAddOpen ? (current?.word ?? null) : null}
        senseIndex={null}
        mode="add"
        onClose={() => setSenseAddOpen(false)}
        onSaved={(w) =>
          setItems((prev) =>
            prev.map((it) => (it.word.id === w.id ? { ...it, word: w } : it)),
          )
        }
      />
      {/* 长按音标 → 编辑读音（用户 2026-10-24）：保存即写回词书，
          换掉内存里的旧 Word（界面立即刷新），并同步 store wordMap 供背词/听词联想用 */}
      <IpaEditDialog
        word={pronEditIdx !== null ? (current?.word ?? null) : null}
        senseIndex={pronEditIdx}
        onClose={() => setPronEditIdx(null)}
        onSaved={(w) => {
          setItems((prev) => prev.map((it) => (it.word.id === w.id ? { ...it, word: w } : it)));
          patchWord(w.id, w);
        }}
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
          const p = displaySenses(current.word)[current.senseIndex];
          void resynthesize(
            {
              text: current.word.lemma,
              ...(p?.ipa ? { ipa: p.ipa } : {}),
              ...(p?.arpabet ? { arpabet: p.arpabet } : {}),
              mode: 'word',
            },
            current.bookWord.wordId,
          );
        }}
      />
    </Box>
  );
}
