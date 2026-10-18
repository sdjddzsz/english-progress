/**
 * DashboardPage.tsx —— 后台（PRD §5.2.4，诊断口径）：
 * 各层各轮覆盖进度（窗口 × done hits）/ 视觉-听觉差距曲线（recharts）
 * / 最新能力画像快照（词级状态计数与逐层贯通率，无总分）。
 * 后台允许呈现诊断信息；硬约束 #1 禁用词仍不出现（模考报告仅 T05 DiagReportView）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AbilitySnapshot, Feedback, Tier } from '../types/domain';
import { planRounds, type PlanRoundWindow } from '../scheduler';
import { getRepos, todayISO, useAppStore } from '../store/useAppStore';

interface CurvePoint {
  date: string;
  visual: number;
  audio: number;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { userId, activePlan, bootstrap } = useAppStore();

  const [windows, setWindows] = useState<PlanRoundWindow[]>([]);
  const [covered, setCovered] = useState<Record<string, number>>({});
  const [snapshot, setSnapshot] = useState<AbilitySnapshot | null>(null);
  const [curve, setCurve] = useState<CurvePoint[]>([]);
  const [pendingProposals, setPendingProposals] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!userId || !activePlan) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const repos = getRepos();
        const bws = await repos.word.listBookWords(activePlan.bookId);
        const counts: Record<number, number> = {};
        for (const bw of bws) counts[bw.tier] = (counts[bw.tier] ?? 0) + 1;
        const params = {
          tierRounds: activePlan.tierRounds,
          planMode: activePlan.planMode,
          startDate: activePlan.startDate,
          deadlineDate: activePlan.deadlineDate,
          sprintStartDate: activePlan.sprintStartDate,
          dailyBudgetMin: activePlan.dailyBudgetMin,
          avgHitSec: activePlan.avgHitSec,
          gapMinDays: activePlan.gapMinDays,
          modalRatio: activePlan.modalRatio,
          masteryDecayEnabled: activePlan.masteryDecayEnabled,
          tierRoundDays: activePlan.tierRoundDays,
          listSize: 50,
        };
        const wins = planRounds(params, counts);

        // 各轮覆盖进度：窗口内 done hit 数 / 应覆盖词数
        const cov: Record<string, number> = {};
        const today = todayISO();
        for (const w of wins) {
          if (w.startDate > today) continue;
          const hits = await repos.hit.getHitsRange(activePlan.id, w.startDate, w.endDate);
          cov[`${w.tier}-${w.roundNo}`] = hits.filter((h) => h.tier === w.tier && h.roundNo === w.roundNo && h.status === 'done').length;
        }

        // 视觉-听觉差距曲线（近 14 天按日聚合反馈数）
        const since = new Date(Date.now() - 14 * 86400000).toISOString();
        const feedbacks: Feedback[] = await repos.feedback.listFeedbacksRange(since, new Date().toISOString());
        const byDate = new Map<string, { visual: number; audio: number }>();
        for (const f of feedbacks) {
          const d = f.createdAt.slice(0, 10);
          const slot = byDate.get(d) ?? { visual: 0, audio: 0 };
          if (f.modality === 'audio') slot.audio += 1;
          else slot.visual += 1;
          byDate.set(d, slot);
        }
        const curveData = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, v]) => ({ date, ...v }));

        const snaps = await repos.config.listAbilitySnapshots(userId);
        const proposals = activePlan ? await repos.config.listPendingProposals(activePlan.id) : [];

        if (cancelled) return;
        setWindows(wins);
        setCovered(cov);
        setCurve(curveData);
        setSnapshot(snaps[0] ?? null);
        setPendingProposals(proposals.length);
        setError('');
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, activePlan]);

  const tiersInWindows = useMemo(() => [...new Set(windows.map((w) => w.tier))] as Tier[], [windows]);

  if (!activePlan) {
    return (
      <Box p={2}>
        <Alert severity="info">没有生效中的计划，后台暂无可统计的数据。</Alert>
      </Box>
    );
  }

  return (
    <Box p={2} pb={4}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h5">后台</Typography>
        {pendingProposals > 0 && (
          <Button variant="contained" size="small" onClick={() => navigate('/ai-plan')}>
            {pendingProposals} 条 AI 方案待处理
          </Button>
        )}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
      {loading && (
        <Box textAlign="center" py={2}>
          <CircularProgress size={24} />
        </Box>
      )}

      {/* 各层各轮覆盖进度（窗口 × done，口径=轮次覆盖而非百分比总评） */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Typography variant="h6" gutterBottom>
          各层轮次覆盖
        </Typography>
        {tiersInWindows.map((t) => (
          <Box key={t} sx={{ mb: 1.5 }}>
            <Chip size="small" label={`T${t}`} sx={{ mr: 1 }} />
            {windows
              .filter((w) => w.tier === t)
              .map((w) => {
                const done = covered[`${w.tier}-${w.roundNo}`] ?? 0;
                const ratio = Math.min(100, (done / Math.max(1, w.wordCount)) * 100);
                return (
                  <Box key={`${w.tier}-${w.roundNo}`} sx={{ mb: 0.75 }}>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="caption">
                        第 {w.roundNo} 轮（{w.startDate} ~ {w.endDate}）
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {done} / {w.wordCount}
                      </Typography>
                    </Stack>
                    <LinearProgress
                      variant="determinate"
                      value={ratio}
                      sx={{ height: 6, borderRadius: 3 }}
                      color={ratio >= 100 ? 'success' : 'primary'}
                    />
                  </Box>
                );
              })}
          </Box>
        ))}
      </Paper>

      {/* 视觉-听觉差距曲线（v1.0 核心观察项） */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Typography variant="h6" gutterBottom>
          视觉 / 听觉覆盖趋势（近 14 天）
        </Typography>
        {curve.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            暂无反馈数据。
          </Typography>
        ) : (
          <Box sx={{ width: '100%', height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={curve} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <ChartTooltip />
                <Legend />
                <Line type="monotone" dataKey="visual" name="视觉" stroke="#1976d2" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="audio" name="听觉" stroke="#9c27b0" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Paper>

      {/* 能力画像快照（词级状态计数，无总分） */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Typography variant="h6" gutterBottom>
          能力画像（周度快照 · 隐式评估）
        </Typography>
        {!snapshot ? (
          <Typography variant="body2" color="text.secondary">
            首份快照在积累一周数据后生成。
          </Typography>
        ) : (
          <>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {Object.entries(snapshot.wordStatesSummary).map(([state, count]) => (
                <Chip key={state} size="small" variant="outlined" label={`${state}: ${count}`} />
              ))}
            </Stack>
            <Divider sx={{ my: 1.5 }} />
            <Typography variant="body2">
              逐层贯通率：
              {([1, 2, 3, 4] as Tier[])
                .map((t) => `T${t} ${(snapshot.tierPassRates[t] != null ? Math.round(snapshot.tierPassRates[t] * 100) : 0)}%`)
                .join(' · ')}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              快照周起点 {snapshot.weekStart} · 混淆对 Top：{snapshot.weakPoints.topConfusionPairs.slice(0, 3).map((p) => `${p.wordA}↔${p.wordB}`).join('、') || '无'}
            </Typography>
          </>
        )}
      </Paper>
    </Box>
  );
}
