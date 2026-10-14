/**
 * PlacementPage.tsx —— 摸底向导（PRD §4.3）：
 *
 * ⚠ 交互按用户 2026-10-13 的要求重做为**两段式**（原版是"点一下即下一词"，等于逼用户凭感觉
 *   自称认识，属于自欺欺人）：
 *   第 1 步「先自己判断」：认识 / 见过想不起 / 不认识（三键，不跳页）；
 *   第 2 步「立刻揭晓正确答案」：同屏展开该义项的词性 + 释义 + 读音（多读音逐义项标出）；
 *        · 自评「认识」的 → 紧接着追问「对照答案，其实记错了吗？」→ 记错 / 没记错；
 *        · 自评「见过想不起 / 不认识」的 → 直接下一词（不可能更差，追问无意义）。
 *   记错 ⇒ 层下移（认识→见过想不起），这是"自评+核对"相对"纯自评"的唯一增量。
 *
 * 判定单位 = **义项（senseId）**：同一单词不同读音对应不同意思 ⇒ 独立摸底、独立定层。
 * 确认后写初始层（recompute_word_tiers）→ 保存 TierSnapshot → 无计划时一步生成推荐档计划。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import type { L1State, Tier, Word } from '../types/domain';
import type { PlanParams } from '../scheduler';
import { planRounds } from '../scheduler';
import {
  PLACEMENT_MAX_WORDS,
  RECOMMENDED_TIER_ROUNDS,
  DEFAULT_MODAL_RATIO,
  DEFAULT_DAILY_BUDGET_MIN,
  DEFAULT_AVG_HIT_SEC,
  DEFAULT_LIST_SIZE,
  DEFAULT_DEADLINE_DATE,
  DEFAULT_SPRINT_START_DATE,
  DEFAULT_MASTERY_DECAY_ENABLED,
} from '../config/constants';
import {
  applySelfCheck,
  estimateTierAssignments,
  pickPlacementSample,
  pickBookWordSample,
  toSenseCandidates,
  type PlacementSenseItem,
} from '../features/placement/sampling';
import {
  answeredCount,
  clearSession,
  loadSession,
  saveSession,
  type PlacementSession,
} from '../features/placement/session';
import { senseLabel } from '../features/senses';
import { snapshotPlan } from '../ai/planVersion';
import { decideProposal, executeTool } from '../ai/authz';
import type { ToolContext } from '../ai/tools/readTools';
import { getRepos, getToolCtx, todayISO, useAppStore } from '../store/useAppStore';
import { useTTS } from '../hooks/useTTS';

/** 第 1 步只有三键：原来那个「秒认」在这里没有意义（还没对答案，凭什么秒认） */
const STEP1_OPTIONS: { value: L1State; label: string; color: 'primary' | 'warning' | 'error' }[] = [
  { value: 'recognized', label: '认识这个词', color: 'primary' },
  { value: 'familiar_but_forgotten', label: '见过但想不起来', color: 'warning' },
  { value: 'unknown', label: '不认识', color: 'error' },
];

/** 兜底：把网络层原始报错转成可读指引 */
function readableError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|network ?error|load failed/i.test(raw)) {
    return `读取词书失败（网络层，非数据问题）：${raw}。多为请求过大或断网所致；请重试一次，若反复出现请把这段文案反馈。`;
  }
  return raw;
}

/** 第 2 步状态机：还没答 → 已答但无需追问 → 已答且待核对 */
type QuizState = 'answering' | 'revealed' | 'verifying';

export default function PlacementPage() {
  const { userId, books, activeBookId, bootstrap } = useAppStore();
  const { speak, speakAuto, loading: ttsLoading } = useTTS();

  const [phase, setPhase] = useState<'idle' | 'quiz' | 'review'>('idle');
  const [items, setItems] = useState<PlacementSenseItem[]>([]);
  const [idx, setIdx] = useState(0);
  /** 键为 senseId（不再按 wordId —— 同词不同读音要分开记） */
  const [responses, setResponses] = useState<Record<string, L1State>>({});
  const [selfChecked, setSelfChecked] = useState<Record<string, boolean>>({});
  const [quizState, setQuizState] = useState<QuizState>('answering');
  const [pendingL1, setPendingL1] = useState<L1State | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  /** 本机存着的未提交摸底草稿（断点续做的依据） */
  const [draft, setDraft] = useState<PlacementSession | null>(null);
  /**
   * 加载进度（用户 2026-10-12 铁律：会让用户等的操作必须配可见进度）。
   * 摸底要先读完整本词书（8296 行 = 9 个分页请求），十几秒里页面不能只转一个圈。
   */
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number } | null>(null);
  /** 当前正在做的长动作名（显示在进度条上方，避免"卡在哪一步"说不清） */
  const [loadStage, setLoadStage] = useState('');
  const startedAtRef = useRef<string>(new Date().toISOString());

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  /** 换用户/换词书时重新探一次草稿（不能拿 A 词书的进度去续 B 词书） */
  useEffect(() => {
    const bookId = activeBookId ?? books[0]?.id;
    if (!userId || !bookId) return;
    setDraft(loadSession(userId, bookId));
  }, [userId, activeBookId, books]);

  // ===== 断点续做：答题过程中每一步都落盘，退出/刷新回来接着答 =====
  useEffect(() => {
    const bookId = activeBookId ?? books[0]?.id;
    if (!userId || !bookId || phase !== 'quiz' || items.length === 0) return;
    saveSession(userId, {
      version: 1,
      bookId,
      startedAt: startedAtRef.current,
      updatedAt: new Date().toISOString(),
      items,
      idx,
      responses,
      selfChecked,
    });
    setDraft(loadSession(userId, bookId));
  }, [userId, activeBookId, books, phase, items, idx, responses, selfChecked]);

  /** 换个词就自动读一次（受设置开关控制）；听觉/视觉都读，摸底时也省一次点击 */
  const currentLemma = items[idx]?.senseId ?? '';
  useEffect(() => {
    const it = items[idx];
    if (!it || phase !== 'quiz' || quizState !== 'answering') return;
    void speakAuto({ text: it.lemma, ipa: it.ipa, arpabet: it.arpabet, mode: 'word' }, it.senseId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLemma, phase]);

  /** 拉词 + 建抽样（force=true 表示丢弃草稿重来） */
  const start = useCallback(
    async (from?: PlacementSession | null, force = false) => {
      const bookId = activeBookId ?? books[0]?.id;
      if (!userId || !bookId) {
        setError('需要先有当前词书（先到「词书」页选择）。');
        return;
      }
      // 有草稿且不是强制重来 ⇒ 直接回到中断位置，一个词都不重拉
      if (!force && from && from.items.length > 0) {
        setItems(from.items);
        setIdx(Math.min(Math.max(0, from.idx), from.items.length - 1));
        setResponses(from.responses ?? {});
        setSelfChecked(from.selfChecked ?? {});
        startedAtRef.current = from.startedAt ?? new Date().toISOString();
        setQuizState('answering');
        setPendingL1(null);
        setPhase('quiz');
        return;
      }
      setBusy(true);
      setError('');
      try {
        const repos = getRepos();
        // 可见进度：先取总数拿到分母，再按分页回调刷新已读数。
        // 这一整段要读 8296 行（9 个分页请求），十几秒里不能只给用户一个转圈。
        setLoadStage('正在读取词表');
        setLoadProgress({ loaded: 0, total: 0 });
        const total = await repos.word.countBookWords(bookId);
        setLoadProgress({ loaded: 0, total });
        const bws = await repos.word.listBookWords(bookId, {
          onPage: (loaded) => setLoadProgress({ loaded, total }),
        });
        setLoadStage('正在抽取摸底样本');
        setLoadProgress(null);
        const book = await repos.word.getBook(bookId);
        // ⚠ 先按词频序预抽，再只取这批词：摸底只要 300 个判定单位，
        //   不该把整本 8296 个词全拉下来（92 个请求 / 十几 MB ⇒ 线上 Failed to fetch）。
        const picked = pickBookWordSample(bws, book?.listSize ?? DEFAULT_LIST_SIZE, PLACEMENT_MAX_WORDS);
        setLoadStage('正在加载词条详情');
        const words: Word[] = await repos.word.listWordsByIds(picked.map((b) => b.wordId));
        const candidates = toSenseCandidates(words);
        const sample = pickPlacementSample(candidates, PLACEMENT_MAX_WORDS);
        setItems(sample);
        setResponses({});
        setSelfChecked({});
        startedAtRef.current = new Date().toISOString();
        setIdx(0);
        setQuizState('answering');
        setPhase('quiz');
        clearSession(userId, bookId);
      } catch (e) {
        setError(readableError(e));
      } finally {
        setBusy(false);
        setLoadProgress(null);
        setLoadStage('');
      }
    },
    [userId, activeBookId, books],
  );

  /** 第 1 步提交：只记初评，**立刻**切到揭晓态（不跳下一词） */
  const answerStep1 = (l1: L1State) => {
    const current = items[idx];
    if (!current) return;
    setPendingL1(l1);
    setQuizState('revealed');
  };

  const advance = useCallback(() => {
    setQuizState('answering');
    setPendingL1(null);
    if (idx + 1 >= items.length) {
      setPhase('review');
    } else {
      setIdx((i) => i + 1);
    }
  }, [idx, items.length]);

  /**
   * 上一词（防点错按钮）：回到上一条并**撤销它的判定**，重新走一遍自评。
   * 只回退一条 —— 摸底是"逐条确认"的流程，连跳会让用户失去自己在哪的方位感。
   */
  const goBack = useCallback(() => {
    if (idx <= 0) return;
    const prev = items[idx - 1];
    setIdx(idx - 1);
    setQuizState('answering');
    setPendingL1(null);
    if (prev) {
      setResponses((r) => {
        const next = { ...r };
        delete next[prev.senseId];
        return next;
      });
      setSelfChecked((r) => {
        const next = { ...r };
        delete next[prev.senseId];
        return next;
      });
    }
  }, [idx, items]);

  /** 「见过想不起 / 不认识」：初评即最终判定，直接进下一词 */
  const acceptWithoutCheck = () => {
    const current = items[idx];
    if (!current || !pendingL1) return;
    setResponses((prev) => ({ ...prev, [current.senseId]: pendingL1 }));
    setSelfChecked((prev) => ({ ...prev, [current.senseId]: false }));
    advance();
  };

  /** 「认识」→ 核对后的最终判定：记错则降层 */
  const finishSelfCheck = (actuallyWrong: boolean) => {
    const current = items[idx];
    if (!current || !pendingL1) return;
    setResponses((prev) => ({ ...prev, [current.senseId]: applySelfCheck(pendingL1, actuallyWrong) }));
    setSelfChecked((prev) => ({ ...prev, [current.senseId]: actuallyWrong }));
    advance();
  };

  const tierCounts = useMemo(() => {
    const counts: Record<Tier, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const { tier } of estimateTierAssignments(responses)) counts[tier] += 1;
    return counts;
  }, [responses]);

  /** 核对阶段改判过的词数（页面上必须可见：这就是"自评不可信"的证据） */
  const correctedCount = useMemo(
    () => Object.entries(responses).filter(([k]) => selfChecked[k]).length,
    [responses, selfChecked],
  );

  const submit = async () => {
    const bookId = activeBookId ?? books[0]?.id;
    if (!userId || !bookId) return;
    setBusy(true);
    setError('');
    try {
      const repos = getRepos();
      // ⚠ 只取本次答过的词对应的词书行（≤300），**不要 listBookWords 把整本 8296 行拉回来**：
      // 那是 2026-10-14 线上「答完 300 题点提交后卡在分层环节」的成因（9 个分页请求 + 全表载荷）。
      const neededWordIds = [...new Set(items.map((i) => `word_${i.senseId.split('#')[0]}`))];
      const bws = await repos.word.listBookWordsByWordIds(bookId, neededWordIds);
      const idByWord = new Map(bws.map((bw) => [bw.wordId, bw.id]));
      // 义项 → 词书行：同 lemma 的多个义项共享同一个 bookWord 行（层是词级属性）
      const assignments = estimateTierAssignments(responses)
        .filter((a) => idByWord.has(`word_${a.senseId.split('#')[0]}`))
        .map((a) => ({
          bookWordId: idByWord.get(`word_${a.senseId.split('#')[0]}`) as string,
          tier: a.tier,
        }));
      const ctx = getToolCtx(userId, undefined);
      const decision = await executeTool(
        { ctx },
        {
          toolName: 'recompute_word_tiers',
          input: { bookId, assignments },
          reason: `摸底分层：${assignments.length} 词按义项自评+答案核对后定层（≤${PLACEMENT_MAX_WORDS} 义项）`,
          actor: 'user',
        },
      );
      if (decision.kind === 'rejected') throw new Error(decision.reason);
      if (decision.kind === 'confirm' || decision.kind === 'require') {
        const approved = await executeDecision(decision.proposalId, ctx);
        if (!approved) throw new Error('分层写入未生效（提案未通过）');
      }
      await repos.config.saveTierSnapshot({
        userId,
        sampledWordIds: items.map((i) => i.lemma),
        responses,
        computedTiers: Object.fromEntries(
          estimateTierAssignments(responses).map((a) => [
            `word_${a.senseId.split('#')[0]}`,
            a.tier,
          ]),
        ),
        calibratedAt: new Date().toISOString(),
      });
      setMsg(`初始分层已写入（抽样 ${items.length} 个判定单位，其中 ${correctedCount} 个经核对降层）。`);
      // 已落库 ⇒ 草稿作废，否则下次进来还会提示"有未完成的摸底"
      clearSession(userId, bookId);
      setDraft(null);
      setPhase('idle');
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  };

  const executeDecision = async (proposalId: string, ctx: ToolContext): Promise<boolean> => {
    const r = await decideProposal({ ctx }, proposalId, true);
    return r.kind === 'auto';
  };

  /** 摸底完成 → 一步生成推荐档计划（无计划时） */
  const createRecommendedPlan = async () => {
    const bookId = activeBookId ?? books[0]?.id;
    if (!userId || !bookId) return;
    setBusy(true);
    setError('');
    try {
      const repos = getRepos();
      const existing = await repos.plan.getActivePlan(bookId);
      if (existing) {
        setMsg('已有生效计划，无需重复创建。');
        return;
      }
      const book = await repos.word.getBook(bookId);
      const plan = await repos.plan.createPlan({
        bookId,
        userId,
        tierRounds: { ...RECOMMENDED_TIER_ROUNDS },
        planMode: 'recommended',
        startDate: todayISO(),
        deadlineDate: DEFAULT_DEADLINE_DATE,
        sprintStartDate: DEFAULT_SPRINT_START_DATE,
        dailyBudgetMin: DEFAULT_DAILY_BUDGET_MIN,
        avgHitSec: DEFAULT_AVG_HIT_SEC,
        gapMinDays: 0,
        modalRatio: { ...DEFAULT_MODAL_RATIO },
        masteryDecayEnabled: DEFAULT_MASTERY_DECAY_ENABLED,
        version: 1,
        status: 'active',
        createdAt: new Date().toISOString(),
      });
      // 各层词量：4 个 count 并发（只回数字）—— 不要为了统计分布把整本 8296 行拉下来
      const tierCountsLocal = await repos.word.countBookWordsByTier(bookId);
      const params: PlanParams = {
        tierRounds: { ...RECOMMENDED_TIER_ROUNDS },
        planMode: 'recommended',
        startDate: plan.startDate,
        deadlineDate: plan.deadlineDate,
        sprintStartDate: plan.sprintStartDate,
        dailyBudgetMin: plan.dailyBudgetMin,
        avgHitSec: plan.avgHitSec,
        gapMinDays: plan.gapMinDays,
        modalRatio: plan.modalRatio,
        masteryDecayEnabled: plan.masteryDecayEnabled,
        listSize: book?.listSize ?? DEFAULT_LIST_SIZE,
      };
      const rounds = planRounds(params, tierCountsLocal).map((w) => ({
        planId: plan.id,
        tier: w.tier,
        roundNo: w.roundNo,
        startDate: w.startDate,
        endDate: w.endDate,
        coverageTarget: w.wordCount,
        coveredCount: 0,
        status: 'pending' as const,
      }));
      await repos.plan.replaceRounds(plan.id, rounds);
      await snapshotPlan(repos.plan, plan, 'user', '摸底后初始创建', 'create');
      setMsg(`推荐档计划已创建（${plan.startDate} → ${plan.deadlineDate}），可去「计划编辑」微调。`);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  };

  const current = items[idx] ?? null;

  return (
    <Box p={2} pb={4} maxWidth={720} mx="auto">
      <Typography variant="h5">摸底分层</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        每个词先自己判断，**立刻**给你看正确答案；选了「认识」的还要再核对一次有没有记错。
        同一个词的不同读音会分开问。
      </Typography>

      {msg && (
        <Alert severity="success" sx={{ mt: 2 }} onClose={() => setMsg('')}>
          {msg}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {phase === 'idle' && (
        <Paper sx={{ mt: 2, p: 3, textAlign: 'center' }}>
          {/* 断点续做：有未提交的草稿就先把"接着做"摆在最前面 */}
          {draft ? (
            <>
              <Alert severity="info" sx={{ mb: 2, textAlign: 'left' }}>
                有一份未提交的摸底：已答 <strong>{answeredCount(draft)}</strong> / {draft.items.length} 条，
                上次停在<strong>第 {Math.min(draft.idx + 1, draft.items.length)} 条</strong>
                （{new Date(draft.updatedAt).toLocaleString('zh-CN')}）。接着做不会重来。
              </Alert>
              <Stack direction="row" spacing={1} justifyContent="center" flexWrap="wrap" useFlexGap>
                <Button variant="contained" disabled={busy} onClick={() => void start(draft)}>
                  继续摸底（从第 {Math.min(draft.idx + 1, draft.items.length)} 条）
                </Button>
                <Button
                  variant="outlined"
                  disabled={busy}
                  onClick={() => void start(draft, true)}
                >
                  放弃草稿，重新摸底
                </Button>
              </Stack>
            </>
          ) : (
            <>
              <Typography variant="body1" gutterBottom>
                {items.length > 0
                  ? `上次抽样 ${items.length} 个判定单位，已写入 ${Object.keys(responses).length} 条。`
                  : `约 3-5 分钟，约 ${PLACEMENT_MAX_WORDS} 个判定单位。`}
              </Typography>
              <Button variant="contained" disabled={busy} onClick={() => void start(null, true)}>
                {busy ? <CircularProgress size={20} /> : items.length > 0 ? '重新摸底' : '开始摸底'}
              </Button>
            </>
          )}
          {/* 可见进度：读全表要 9 个分页请求、十几秒，必须让用户看到"读到哪了" */}
          {loadProgress && (
            <Box sx={{ mt: 2, textAlign: 'left' }}>
              <Typography variant="caption" color="text.secondary">
                {loadStage}
                {loadProgress.total > 0
                  ? ` · 已读 ${loadProgress.loaded} / ${loadProgress.total} 行`
                  : '…'}
              </Typography>
              <LinearProgress
                variant={loadProgress.total > 0 ? 'determinate' : 'indeterminate'}
                value={
                  loadProgress.total > 0
                    ? Math.min(100, (loadProgress.loaded / loadProgress.total) * 100)
                    : undefined
                }
                sx={{ mt: 0.5, borderRadius: 1 }}
              />
            </Box>
          )}
          {Object.keys(responses).length > 0 && !msg && (
            <Button sx={{ ml: 1 }} variant="outlined" onClick={() => setPhase('review')}>
              回到确认页
            </Button>
          )}
        </Paper>
      )}

      {phase === 'quiz' && current && (
        <Paper sx={{ mt: 2, p: 3 }}>
          <LinearProgress variant="determinate" value={(idx / Math.max(1, items.length)) * 100} sx={{ mb: 2 }} />
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip size="small" variant="outlined" label={`${idx + 1} / ${items.length}`} />
            {current.pronunciationCount > 1 && (
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                label={`${current.lemma} 有 ${current.pronunciationCount} 种读音/词性，现在问的是其中一种`}
              />
            )}
          </Stack>

          <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap sx={{ my: 2 }}>
            <Typography variant="h3">{current.lemma}</Typography>
            {/* 音标必须挨着词形（用户 2026-10-13）：词旁边没有音标等于让用户猜读音 */}
            {current.ipa && (
              <Typography variant="h6" color="text.secondary">
                /{current.ipa.replace(/^\/|\/$/g, '')}/
              </Typography>
            )}
            <Button
              size="small"
              startIcon={ttsLoading ? <CircularProgress size={16} /> : <VolumeUpIcon />}
              disabled={ttsLoading}
              onClick={() =>
                void speak(
                  { text: current.lemma, ipa: current.ipa, arpabet: current.arpabet, mode: 'word' },
                  current.senseId,
                )
              }
            >
              {ttsLoading ? '合成中…' : '听读音'}
            </Button>
          </Stack>

          {/* 上一词：点错了能退回去重判，不用认栽 */}
          {quizState === 'answering' && idx > 0 && (
            <Button size="small" onClick={goBack} sx={{ mb: 1 }}>
              ← 上一词（撤销上一条判定）
            </Button>
          )}

          {quizState === 'answering' && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                先自己判断——答完立刻给你看正确答案。
              </Typography>
              <Stack direction="row" spacing={1} justifyContent="center" flexWrap="wrap" useFlexGap>
                {STEP1_OPTIONS.map((b) => (
                  <Button key={b.value} variant="contained" color={b.color} onClick={() => answerStep1(b.value)}>
                    {b.label}
                  </Button>
                ))}
              </Stack>
            </>
          )}

          {quizState !== 'answering' && (
            <Box sx={{ mt: 1 }}>
              <Alert severity="info" sx={{ mb: 2 }}>
                正确答案：{current.zh || '（该义项无中文释义）'}
                {current.pos ? ` · ${current.pos}` : ''}
                {current.ipa ? ` · /${current.ipa.replace(/^\/|\/$/g, '')}/` : ''}
                {current.pronunciationCount > 1 ? ' · 该词还有别的读音/词义，稍后单独问' : ''}
              </Alert>

              {/* 核对时必须能看到全部义项：否则用户无从判断"我以为认识的是不是这一档读音" */}
              {current.pronunciationCount > 1 && (
                <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
                  <Typography variant="caption" color="text.secondary">
                    {current.lemma} 的全部读音与词性（本次问的是加粗那条）
                  </Typography>
                  <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                    {(current.senses ?? []).map((s, i) => {
                      const isThis = s.senseId === current.senseId;
                      return (
                        <Stack key={s.senseId} direction="row" spacing={1} alignItems="baseline">
                          <Typography
                            variant="body2"
                            sx={{
                              minWidth: 26,
                              fontWeight: isThis ? 700 : 400,
                              color: isThis ? 'primary.main' : 'text.secondary',
                            }}
                          >
                            {i + 1}.
                          </Typography>
                          <Typography
                            variant="body2"
                            sx={{ flex: 1, fontWeight: isThis ? 700 : 400 }}
                          >
                            {/* 词性显式标注（用户 2026-10-14）：摸底选项也要能按词性区分义项 */}
                            {s.pos ? `${s.pos} ${s.zh}`.trim() : s.zh} · {senseLabel(s)}
                            {s.ipa ? ` · /${s.ipa.replace(/^\/|\/$/g, '')}/` : ''}
                          </Typography>
                          <IconButton
                            size="small"
                            disabled={ttsLoading}
                            onClick={() =>
                              void speak(
                                { text: s.lemma, ipa: s.ipa, arpabet: s.arpabet, mode: 'word' },
                                s.senseId,
                              )
                            }
                            aria-label={`play ${s.senseId}`}
                          >
                            <VolumeUpIcon fontSize="small" />
                          </IconButton>
                        </Stack>
                      );
                    })}
                  </Stack>
                </Paper>
              )}

              {quizState === 'revealed' && pendingL1 === 'recognized' && (
                <>
                  <Typography variant="body1" sx={{ mb: 1 }}>
                    对照上面这个意思——你刚才说「认识」。实际上记错了吗？
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Button variant="contained" color="warning" onClick={() => finishSelfCheck(true)}>
                      记错了
                    </Button>
                    <Button variant="contained" color="success" onClick={() => finishSelfCheck(false)}>
                      没记错
                    </Button>
                  </Stack>
                </>
              )}

              {quizState === 'revealed' && pendingL1 !== 'recognized' && (
                <Stack direction="row" spacing={1} alignItems="center">
                  <Button variant="contained" onClick={acceptWithoutCheck}>
                    下一词
                  </Button>
                  {idx > 0 && (
                    <Button variant="text" size="small" onClick={goBack}>
                      ← 上一词（改判）
                    </Button>
                  )}
                </Stack>
              )}

              {quizState === 'verifying' && (
                <Typography variant="body2" color="text.secondary">
                  已记下，下一词…
                </Typography>
              )}
            </Box>
          )}
        </Paper>
      )}

      {phase === 'review' && (
        <Paper sx={{ mt: 2, p: 3 }}>
          <Typography variant="h6" gutterBottom>
            预估结果（可返回修改）
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {([1, 2, 3, 4] as Tier[]).map((t) => (
              <Chip key={t} label={`T${t}: ${tierCounts[t]} 词`} variant="outlined" />
            ))}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            抽样 {items.length} 个判定单位，已答 {Object.keys(responses).length}；其中{' '}
            <strong>{correctedCount}</strong> 个经核对后降层（宣称认识但对不上答案）。
            批量变动超过 10% 时系统会生成确认提案，其余直接写入。
          </Typography>
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 2 }}>
            <Button variant="outlined" onClick={() => setPhase('quiz')}>
              返回修改
            </Button>
            <Button variant="contained" disabled={busy} onClick={() => void submit()}>
              {busy ? <CircularProgress size={20} /> : '确认写入初始分层'}
            </Button>
          </Stack>
          <Button
            fullWidth
            variant="outlined"
            sx={{ mt: 2 }}
            disabled={busy}
            onClick={() => void createRecommendedPlan()}
          >
            下一步：生成推荐档计划
          </Button>
        </Paper>
      )}
    </Box>
  );
}
