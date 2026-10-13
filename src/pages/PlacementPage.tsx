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
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  toSenseCandidates,
  type PlacementSenseItem,
} from '../features/placement/sampling';
import { snapshotPlan } from '../ai/planVersion';
import { decideProposal, executeTool } from '../ai/authz';
import type { ToolContext } from '../ai/tools/readTools';
import { getRepos, getToolCtx, todayISO, useAppStore } from '../store/useAppStore';
import { useTTS } from '../hooks/useTTS';
import { describeSenses } from '../features/senses';

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
  const { speak } = useTTS();

  const [phase, setPhase] = useState<'idle' | 'quiz' | 'review'>('idle');
  const [items, setItems] = useState<PlacementSenseItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [wordMap, setWordMap] = useState<Record<string, Word>>({});
  /** 键为 senseId（不再按 wordId —— 同词不同读音要分开记） */
  const [responses, setResponses] = useState<Record<string, L1State>>({});
  const [selfChecked, setSelfChecked] = useState<Record<string, boolean>>({});
  const [quizState, setQuizState] = useState<QuizState>('answering');
  const [pendingL1, setPendingL1] = useState<L1State | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const start = useCallback(async () => {
    const bookId = activeBookId ?? books[0]?.id;
    if (!userId || !bookId) {
      setError('需要先有当前词书（先到「词书」页选择）。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const repos = getRepos();
      const bws = await repos.word.listBookWords(bookId);
      const words: Word[] = await repos.word.listWordsByIds(bws.map((b) => b.wordId));
      const map: Record<string, Word> = {};
      for (const w of words) map[w.id] = w;
      const candidates = toSenseCandidates(words);
      setWordMap(map);
      const sample = pickPlacementSample(candidates, PLACEMENT_MAX_WORDS);
      setItems(sample);
      setResponses({});
      setSelfChecked({});
      setIdx(0);
      setQuizState('answering');
      setPhase('quiz');
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }, [userId, activeBookId, books]);

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
      const bws = await repos.word.listBookWords(bookId);
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
      const bws = await repos.word.listBookWords(bookId);
      const tierCountsLocal: Record<number, number> = {};
      for (const bw of bws) tierCountsLocal[bw.tier] = (tierCountsLocal[bw.tier] ?? 0) + 1;
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
          <Typography variant="body1" gutterBottom>
            {items.length > 0
              ? `上次抽样 ${items.length} 个判定单位，已写入 ${Object.keys(responses).length} 条。`
              : `约 3-5 分钟，约 ${PLACEMENT_MAX_WORDS} 个判定单位。`}
          </Typography>
          <Button variant="contained" disabled={busy} onClick={() => void start()}>
            {busy ? <CircularProgress size={20} /> : items.length > 0 ? '重新摸底' : '开始摸底'}
          </Button>
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

          <Stack direction="row" spacing={1} alignItems="center" sx={{ my: 2 }}>
            <Typography variant="h3">{current.lemma}</Typography>
            <Button
              size="small"
              startIcon={<VolumeUpIcon />}
              onClick={() =>
                void speak(
                  { text: current.lemma, ipa: current.ipa, arpabet: current.arpabet, mode: 'word' },
                  current.senseId,
                )
              }
            >
              听读音
            </Button>
          </Stack>

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
                    {(wordMap[`word_${current.lemma}`] ? describeSenses(wordMap[`word_${current.lemma}`]) : []).map(
                      ({ sense: s, label }, i) => (
                        <Stack key={s.senseId} direction="row" spacing={1} alignItems="baseline">
                          <Typography
                            variant="body2"
                            sx={{
                              minWidth: 26,
                              fontWeight: s.senseId === current.senseId ? 700 : 400,
                              color: s.senseId === current.senseId ? 'primary.main' : 'text.secondary',
                            }}
                          >
                            {i + 1}.
                          </Typography>
                          <Typography
                            variant="body2"
                            sx={{
                              flex: 1,
                              fontWeight: s.senseId === current.senseId ? 700 : 400,
                            }}
                          >
                            {s.zh || s.pos} · {label}
                          </Typography>
                          <IconButton
                            size="small"
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
                      ),
                    )}
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
                <Button variant="contained" onClick={acceptWithoutCheck}>
                  下一词
                </Button>
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
