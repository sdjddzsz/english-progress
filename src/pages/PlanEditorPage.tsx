/**
 * PlanEditorPage.tsx —— 计划编辑（PRD §5.2.3 / §4.4 用户掌控）：
 * 参数表单（档位/预算/平均耗时/降频/各层轮次）→ 实时 impactPreview 影响预览
 * → 保存走 update_plan_params（require 级：确认对话框 → decideProposal 放行）
 * → PlanVersion 版本列表与一键回滚（rollbackToVersion）。
 * 调度逻辑只调用 scheduler 纯函数；数据访问全部经 getRepos()。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  MenuItem,
  Paper,
  Slider,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import UndoIcon from '@mui/icons-material/Undo';
import type { StudyPlan, Tier } from '../types/domain';
import {
  impactPreview,
  type PlanParams,
  type TierWordCounts,
  type WordSteadiness,
} from '../scheduler';
import { DAILY_BUDGET_MIN_RANGE, RECOMMENDED_TIER_ROUNDS, FALLBACK_TIER_ROUNDS } from '../config/constants';
import { decideProposal, executeTool } from '../ai/authz';
import { rollbackToVersion } from '../ai/planVersion';
import type { PlanVersion } from '../types/domain';
import { getRepos, getToolCtx, todayISO, useAppStore } from '../store/useAppStore';
import PlanSummaryCard from '../components/plan/PlanSummaryCard';

const ROUND_OPTIONS = [1, 2, 3, 4];

function toParams(plan: StudyPlan, listSize: number): PlanParams {
  return {
    tierRounds: { ...plan.tierRounds },
    planMode: plan.planMode,
    startDate: plan.startDate,
    deadlineDate: plan.deadlineDate,
    sprintStartDate: plan.sprintStartDate,
    dailyBudgetMin: plan.dailyBudgetMin,
    avgHitSec: plan.avgHitSec,
    gapMinDays: plan.gapMinDays,
    modalRatio: { ...plan.modalRatio },
    masteryDecayEnabled: plan.masteryDecayEnabled,
    tierRoundDays: plan.tierRoundDays as PlanParams['tierRoundDays'],
    listSize,
  };
}

export default function PlanEditorPage() {
  const { activePlan, bootstrap, refreshToday } = useAppStore();

  const [form, setForm] = useState<PlanParams | null>(null);
  const [tierCounts, setTierCounts] = useState<TierWordCounts>({});
  const [steady, setSteady] = useState<WordSteadiness[]>([]);
  const [versions, setVersions] = useState<PlanVersion[]>([]);
  const [baseline, setBaseline] = useState<StudyPlan | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!activePlan) return;
    let cancelled = false;
    void (async () => {
      try {
        const repos = getRepos();
        const book = await repos.word.getBook(activePlan.bookId);
        const bws = await repos.word.listBookWords(activePlan.bookId);
        const counts: TierWordCounts = {};
        for (const bw of bws) counts[bw.tier] = (counts[bw.tier] ?? 0) + 1;
        const since = new Date(Date.now() - 30 * 86400000).toISOString();
        const recent = await repos.feedback.listFeedbacksRange(since, new Date().toISOString());
        const vs = await repos.plan.listPlanVersions(activePlan.id);
        if (cancelled) return;
        setTierCounts(counts);
        setSteady(repos.feedback.aggregateSteadiness(recent));
        setVersions(vs);
        setBaseline(activePlan);
        setForm(toParams(activePlan, book?.listSize ?? 50));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePlan]);

  // 实时影响预览（改前出预览：总覆盖次数变化 / 日均分钟 / 预计完成日 / 通过判定翻转）
  const preview = useMemo(() => {
    if (!baseline || !form) return null;
    return impactPreview(toParams(baseline, form.listSize), form, tierCounts, steady);
  }, [baseline, form, tierCounts, steady]);

  const dirty = useMemo(() => {
    if (!baseline || !form) return false;
    const b = toParams(baseline, form.listSize);
    return JSON.stringify(b) !== JSON.stringify(form);
  }, [baseline, form]);

  const patchFromForm = useCallback((f: PlanParams): Partial<StudyPlan> => {
    return {
      tierRounds: f.tierRounds,
      planMode: f.planMode,
      dailyBudgetMin: f.dailyBudgetMin,
      avgHitSec: f.avgHitSec,
      masteryDecayEnabled: f.masteryDecayEnabled,
      modalRatio: f.modalRatio,
      tierRoundDays: f.tierRoundDays as StudyPlan['tierRoundDays'],
    };
  }, []);

  const handleSave = async () => {
    if (!baseline || !form || !dirty) return;
    setConfirmOpen(false);
    setBusy(true);
    setError('');
    try {
      const userId = useAppStore.getState().userId;
      if (!userId) throw new Error('not signed in');
      const ctx = getToolCtx(userId, baseline.id);
      const changed: string[] = [];
      if (form.planMode !== baseline.planMode) changed.push(`档位→${form.planMode === 'recommended' ? '推荐' : '保底'}`);
      if (form.dailyBudgetMin !== baseline.dailyBudgetMin) changed.push(`预算→${form.dailyBudgetMin}分钟`);
      if (form.avgHitSec !== baseline.avgHitSec) changed.push(`单次耗时→${form.avgHitSec}s`);
      if (form.masteryDecayEnabled !== baseline.masteryDecayEnabled) changed.push(`降频→${form.masteryDecayEnabled ? '开' : '关'}`);
      if (JSON.stringify(form.tierRounds) !== JSON.stringify(baseline.tierRounds)) changed.push('层轮次调整');
      const reason = `用户在计划编辑页调整：${changed.join('、') || '参数'}`;
      const decision = await executeTool(
        { ctx },
        { toolName: 'update_plan_params', input: { planId: baseline.id, patch: patchFromForm(form) }, reason, actor: 'user' },
      );
      if (decision.kind === 'require') {
        const approved = await decideProposal({ ctx }, decision.proposalId, true);
        if (approved.kind !== 'auto') throw new Error('保存未生效（提案未通过）');
      } else if (decision.kind === 'rejected') {
        throw new Error(decision.reason);
      }
      await refreshToday(todayISO());
      setMsg('计划已保存，参数变更已写入版本历史（可回滚）。');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRollback = async (versionNo: number) => {
    if (!baseline) return;
    setBusy(true);
    setError('');
    try {
      const repos = getRepos();
      const rolled = await rollbackToVersion(
        { plans: repos.plan.plans, versions: repos.plan.versions },
        baseline.id,
        versionNo,
      );
      await refreshToday(todayISO());
      setMsg(`已回滚到 v${versionNo}（记录为 v${rolled.newVersion.versionNo}）。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!activePlan || !form) {
    return (
      <Box p={2}>
        <Alert severity="info">没有生效中的计划——先到「词书」页设置当前词书并创建计划。</Alert>
      </Box>
    );
  }

  const [minBudget, maxBudget] = DAILY_BUDGET_MIN_RANGE;

  return (
    <Box p={2} pb={4}>
      <Typography variant="h5">计划编辑</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        所有影响进度的参数对用户开放；保存前看影响预览，保存后可一键回滚。
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

      {/* 当前生效参数概览（节奏/预估不在这张卡上——编辑器自己的影响预览在下方，走计划参数口径） */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Typography variant="h6" gutterBottom>
          当前生效
        </Typography>
        <PlanSummaryCard plan={baseline} />
      </Paper>

      {/* 参数表单 */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Typography variant="h6" gutterBottom>
          参数调整
        </Typography>
        <Stack spacing={2}>
          <TextField
            select
            label="档位"
            value={form.planMode}
            onChange={(e) => {
              const mode = e.target.value as PlanParams['planMode'];
              setForm({
                ...form,
                planMode: mode,
                tierRounds: mode === 'recommended' ? { ...RECOMMENDED_TIER_ROUNDS } : { ...FALLBACK_TIER_ROUNDS },
              });
            }}
            size="small"
          >
            <MenuItem value="recommended">推荐档（T1:2 / T2:2 / T3:3 / T4:3）</MenuItem>
            <MenuItem value="fallback">保底档（各层 2 轮）</MenuItem>
          </TextField>

          <Box>
            <Typography variant="body2">每日预算：{form.dailyBudgetMin} 分钟（{minBudget}–{maxBudget}）</Typography>
            <Slider
              min={minBudget}
              max={maxBudget}
              step={5}
              value={form.dailyBudgetMin}
              onChange={(_, v) => setForm({ ...form, dailyBudgetMin: v as number })}
              valueLabelDisplay="auto"
              marks
            />
          </Box>

          <TextField
            select
            label="单次覆盖平均耗时（秒）"
            value={form.avgHitSec}
            onChange={(e) => setForm({ ...form, avgHitSec: Number(e.target.value) })}
            size="small"
            helperText="首周后由真实反应时长校准"
          >
            {[8, 10, 12, 15, 20].map((v) => (
              <MenuItem key={v} value={v}>
                {v} 秒
              </MenuItem>
            ))}
          </TextField>

          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2">掌握度降频（稳固词首末轮必现，中间轮可跳）</Typography>
            <Switch
              checked={form.masteryDecayEnabled}
              onChange={(e) => setForm({ ...form, masteryDecayEnabled: e.target.checked })}
            />
          </Stack>

          <Box>
            <Typography variant="body2" sx={{ mb: 1 }}>
              各层轮次（切换档位会重置；也可单独微调，最低 1 轮）
            </Typography>
            <Stack direction="row" spacing={1}>
              {([1, 2, 3, 4] as Tier[]).map((t) => (
                <TextField
                  key={t}
                  select
                  size="small"
                  label={`T${t}`}
                  value={form.tierRounds[t]}
                  onChange={(e) => {
                    const r = Number(e.target.value);
                    setForm({ ...form, tierRounds: { ...form.tierRounds, [t]: r } });
                  }}
                  sx={{ width: 90 }}
                >
                  {ROUND_OPTIONS.map((r) => (
                    <MenuItem key={r} value={r}>
                      {r} 轮
                    </MenuItem>
                  ))}
                </TextField>
              ))}
            </Stack>
          </Box>
        </Stack>

        {/* 影响预览 */}
        {preview && (
          <Box sx={{ mt: 2 }}>
            <Divider />
            <Typography variant="subtitle2" sx={{ mt: 1 }}>
              影响预览（保存前看清后果）
            </Typography>
            <Typography variant="body2">
              总覆盖次数变化：<strong>{preview.totalHitsDelta >= 0 ? `+${preview.totalHitsDelta}` : preview.totalHitsDelta}</strong> ｜
              日均 {preview.dailyMinutes.dailyHits} 个 · {preview.dailyMinutes.dailyMinutes.toFixed(1)} 分钟 ｜
              预计完成 <strong>{preview.newFinishDate}</strong>
              {preview.passChanged && ' ｜ ⚠ 可行性判定将翻转'}
            </Typography>
          </Box>
        )}

        <Stack direction="row" justifyContent="flex-end" sx={{ mt: 2 }}>
          <Button variant="outlined" onClick={() => baseline && setForm(toParams(baseline, form.listSize))} disabled={!dirty || busy}>
            还原
          </Button>
          <Button variant="contained" sx={{ ml: 1 }} disabled={!dirty || busy} onClick={() => setConfirmOpen(true)}>
            {busy ? <CircularProgress size={20} /> : '保存（需确认）'}
          </Button>
        </Stack>
      </Paper>

      {/* 版本历史与回滚 */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Typography variant="h6" gutterBottom>
          版本历史（每次变更自动快照）
        </Typography>
        <Stack divider={<Divider flexItem />}>
          {versions.map((v) => (
            <Stack key={v.id} direction="row" justifyContent="space-between" alignItems="center" py={0.75}>
              <Box>
                <Typography variant="body2">
                  v{v.versionNo} · {v.changedBy === 'user' ? '用户' : v.changedBy === 'ai' ? 'AI' : '系统'} · {v.reason}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {v.diffSummary} · {new Date(v.createdAt).toLocaleString()}
                </Typography>
              </Box>
              <Button
                size="small"
                startIcon={<UndoIcon />}
                disabled={busy}
                onClick={() => void handleRollback(v.versionNo)}
              >
                回滚到此版
              </Button>
            </Stack>
          ))}
          {versions.length === 0 && (
            <Typography variant="body2" color="text.secondary" py={1}>
              暂无版本记录。
            </Typography>
          )}
        </Stack>
      </Paper>

      {/* Require 级确认对话框 */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>确认保存计划参数？</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {preview && (
              <>
                保存后：总覆盖次数 {preview.totalHitsDelta >= 0 ? `增加 ${preview.totalHitsDelta}` : `减少 ${-preview.totalHitsDelta}`} 次，
                日均 {preview.dailyMinutes.dailyMinutes.toFixed(1)} 分钟，预计完成 {preview.newFinishDate}。
                变更会写入版本历史，可随时回滚。
              </>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>再想想</Button>
          <Button variant="contained" onClick={() => void handleSave()} disabled={busy}>
            确认保存
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
