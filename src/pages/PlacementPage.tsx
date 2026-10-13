/**
 * PlacementPage.tsx —— 摸底向导（PRD §4.3，T05）：
 * ≤300 词词频先验分带抽样 → L1 快答（点选即下一词）→ AI 预估（l1→tier 映射）
 * → 确认后写初始层（recompute_word_tiers，>10% 由动态风险自动走 Confirm 提案）
 * → 保存 TierSnapshot → 无计划时一步生成推荐档计划（planRounds 窗口 + PlanVersion 快照）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
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
import { estimateTierAssignments, pickPlacementSample, type PlacementCandidate } from '../features/placement/sampling';
import { snapshotPlan } from '../ai/planVersion';
import { decideProposal, executeTool } from '../ai/authz';
import type { ToolContext } from '../ai/tools/readTools';
import { getRepos, getToolCtx, todayISO, useAppStore } from '../store/useAppStore';

interface SampleItem extends PlacementCandidate {
  sense: string;
}

const L1_BUTTONS: { value: L1State; label: string; color: 'success' | 'primary' | 'warning' | 'error' }[] = [
  { value: 'instant', label: '秒认', color: 'success' },
  { value: 'recognized', label: '认得', color: 'primary' },
  { value: 'familiar_but_forgotten', label: '见过想不起', color: 'warning' },
  { value: 'unknown', label: '不认识', color: 'error' },
];

/**
 * 兜底：把网络层原始报错转成可读指引。
 * 之前此处只把 `TypeError: Failed to fetch` 原样丢到界面上 —— 用户看不出是「网络/请求过大」而非数据问题。
 * （真实案例：一次 `id=in.(5407 个 id)` 的 URL ≈ 82KB，超请求行上限 ⇒ 浏览器在该文案上报错。
 *  根因已在 `wordRepo.listWordsByIds` 分片修掉；这里保证将来任何网络层失败都有可读提示。）
 */
function readableError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|network ?error|load failed/i.test(raw)) {
    return `读取词书失败（网络层，非数据问题）：${raw}。多为请求过大或断网所致；请重试一次，若反复出现请把这段文案反馈。`;
  }
  return raw;
}

export default function PlacementPage() {
  const { userId, books, activeBookId, bootstrap } = useAppStore();

  const [phase, setPhase] = useState<'idle' | 'quiz' | 'review'>('idle');
  const [items, setItems] = useState<SampleItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [responses, setResponses] = useState<Record<string, L1State>>({});
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
      // 抽样池 = 全书词（词频先验在 pickPlacementSample 内分带配比）
      const words: Word[] = await repos.word.listWordsByIds(bws.map((b) => b.wordId));
      const wordById = new Map(words.map((w) => [w.id, w]));
      const candidates: (SampleItem & { frequency: number })[] = bws
        .map((bw) => {
          const w = wordById.get(bw.wordId);
          return {
            wordId: bw.wordId,
            lemma: w?.lemma ?? bw.wordId,
            frequency: w?.frequency ?? 0,
            sense: w?.senses[0] ?? '',
          };
        })
        .filter((c) => wordById.has(c.wordId));
      const sample = pickPlacementSample(candidates, PLACEMENT_MAX_WORDS);
      setItems(sample);
      setResponses({});
      setIdx(0);
      setPhase('quiz');
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }, [userId, activeBookId, books]);

  const answer = (l1: L1State) => {
    const current = items[idx];
    if (!current) return;
    setResponses((prev) => ({ ...prev, [current.wordId]: l1 }));
    if (idx + 1 >= items.length) setPhase('review');
    else setIdx((i) => i + 1);
  };

  const tierCounts = useMemo(() => {
    const counts: Record<Tier, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const { tier } of estimateTierAssignments(responses)) counts[tier] += 1;
    return counts;
  }, [responses]);

  const submit = async () => {
    const bookId = activeBookId ?? books[0]?.id;
    if (!userId || !bookId) return;
    setBusy(true);
    setError('');
    try {
      const repos = getRepos();
      const bws = await repos.word.listBookWords(bookId);
      const idByWord = new Map(bws.map((bw) => [bw.wordId, bw.id]));
      const assignments = estimateTierAssignments(responses)
        .filter((a) => idByWord.has(a.wordId))
        .map((a) => ({ bookWordId: idByWord.get(a.wordId) as string, tier: a.tier }));
      const ctx = getToolCtx(userId, undefined);
      const decision = await executeTool(
        { ctx },
        {
          toolName: 'recompute_word_tiers',
          input: { bookId, assignments },
          reason: `摸底分层：${assignments.length} 词按词频先验抽样（≤${PLACEMENT_MAX_WORDS}）快答预估`,
          actor: 'user',
        },
      );
      if (decision.kind === 'rejected') throw new Error(decision.reason);
      if (decision.kind === 'confirm' || decision.kind === 'require') {
        // 摸底是显式用户操作：确认对话框即放行动作
        const approved = await executeDecision(decision.proposalId, ctx);
        if (!approved) throw new Error('分层写入未生效（提案未通过）');
      }
      await repos.config.saveTierSnapshot({
        userId,
        sampledWordIds: items.map((i) => i.wordId),
        responses,
        computedTiers: Object.fromEntries(estimateTierAssignments(responses).map((a) => [a.wordId, a.tier])),
        calibratedAt: new Date().toISOString(),
      });
      setMsg(`初始分层已写入（抽样 ${items.length} 词）。`);
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
      const tierCounts: Record<number, number> = {};
      for (const bw of bws) tierCounts[bw.tier] = (tierCounts[bw.tier] ?? 0) + 1;
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
      const rounds = planRounds(params, tierCounts).map((w) => ({
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

  const current = items[idx];

  return (
    <Box p={2} pb={4} maxWidth={640} mx="auto">
      <Typography variant="h5">摸底分层</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        从当前词书按词频先验抽样（最多 {PLACEMENT_MAX_WORDS} 词），快答定层；结果可在词书页随时手工修正。
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
            {items.length > 0 ? `上次抽样 ${items.length} 词，已写入 ${Object.keys(responses).length} 条答案。` : '约 3-5 分钟，快答即可，不用纠结。'}
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
        <Paper sx={{ mt: 2, p: 3, textAlign: 'center' }}>
          <LinearProgress variant="determinate" value={(idx / Math.max(1, items.length)) * 100} sx={{ mb: 2 }} />
          <Chip size="small" variant="outlined" label={`${idx + 1} / ${items.length}`} />
          <Typography variant="h3" sx={{ my: 2 }}>
            {current.lemma}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            这个词你——（点选即下一词）
          </Typography>
          <Stack direction="row" spacing={1} justifyContent="center" flexWrap="wrap" useFlexGap>
            {L1_BUTTONS.map((b) => (
              <Button key={b.value} variant="contained" color={b.color} onClick={() => answer(b.value)}>
                {b.label}
              </Button>
            ))}
          </Stack>
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
            抽样 {items.length} 词，已答 {Object.keys(responses).length}。
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
