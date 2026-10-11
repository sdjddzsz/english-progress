/**
 * AiPlanPage.tsx —— AI 方案页（PRD §5.2.5）：
 * 待处理提案列表（reason + changes diff + 风险级）→ 确认执行 / 驳回（decideProposal）
 * → 请求 AI 建议（buildFeedbackReviewRequest + chatTurn，workbuddy/openai_compatible 双通道）。
 * Require 级提案永不自动执行：本页的确认按钮是唯一放行通道。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import type { AIProposal } from '../types/domain';
import { buildFeedbackReviewRequest, buildSystemPrompt } from '../ai/prompts';
import { chatTurn } from '../ai/llmClient';
import { getRepos, useAppStore } from '../store/useAppStore';
import { useSettingsStore } from '../store/useSettingsStore';

const RISK_LABEL: Record<AIProposal['riskLevel'], string> = {
  auto: '自动级',
  confirm: '确认级',
  require: '受控级（永不自动）',
};

const RISK_COLOR: Record<AIProposal['riskLevel'], 'default' | 'warning' | 'error'> = {
  auto: 'default',
  confirm: 'warning',
  require: 'error',
};

export default function AiPlanPage() {
  const { userId, activePlan, bootstrap, decideProposalAction } = useAppStore();
  const { aiChannel, aiBaseUrl, aiModel } = useSettingsStore();

  const [proposals, setProposals] = useState<AIProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiReply, setAiReply] = useState('');

  const load = useCallback(async () => {
    if (!userId || !activePlan) return;
    setLoading(true);
    try {
      const rows = await getRepos().config.listPendingProposals(activePlan.id);
      setProposals(rows);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [userId, activePlan]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (proposalId: string, approve: boolean) => {
    setBusyId(proposalId);
    setMsg('');
    setError('');
    const r = await decideProposalAction(proposalId, approve);
    setBusyId(null);
    setMsg(r.ok ? (approve ? '已执行。' : '已驳回。') : `未生效：${r.message}`);
    await load();
  };

  const askAi = async () => {
    if (!userId || !activePlan) return;
    setAiBusy(true);
    setAiReply('');
    setError('');
    try {
      const repos = getRepos();
      const today = new Date().toISOString().slice(0, 10);
      const overdueHits = await repos.hit.getOverdueHits(activePlan.id, today);
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const feedbacks = await repos.feedback.listFeedbacksRange(since, new Date().toISOString());
      const l1Count: Record<string, number> = {};
      for (const f of feedbacks) l1Count[f.l1State] = (l1Count[f.l1State] ?? 0) + 1;
      const confusions = await repos.feedback.listTopConfusionPairs(userId, 5);
      const summary = [
        `- 欠账：${overdueHits.length} 条（阈值 2× 日均）`,
        `- 近 30 天反馈：${feedbacks.length} 条；L1 分布 ${JSON.stringify(l1Count)}`,
        `- Top 混淆对：${confusions.map((c) => `${c.wordA}↔${c.wordB}(×${c.count})`).join('、') || '无'}`,
        `- 计划：${activePlan.planMode === 'recommended' ? '推荐档' : '保底档'} · 预算 ${activePlan.dailyBudgetMin} 分钟`,
      ].join('\n');
      const result = await chatTurn(
        [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildFeedbackReviewRequest(summary) },
        ],
        { model: aiModel || 'default', channel: aiChannel, ...(aiBaseUrl ? { baseUrl: aiBaseUrl } : {}) },
      );
      setAiReply(result.content || '（模型未返回文本内容）');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(false);
    }
  };

  if (!activePlan) {
    return (
      <Box p={2}>
        <Alert severity="info">没有生效中的计划，AI 方案功能需要计划上下文。</Alert>
      </Box>
    );
  }

  return (
    <Box p={2} pb={4}>
      <Typography variant="h5">AI 方案</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        AI 的每个写操作都带理由（reason）与变更内容；受控级操作必须在此由你放行。
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

      {/* 请求 AI 建议 */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h6">让 AI 看看最近的数据</Typography>
          <Button
            variant="outlined"
            startIcon={aiBusy ? <CircularProgress size={16} /> : <SmartToyIcon />}
            disabled={aiBusy}
            onClick={() => void askAi()}
          >
            请求建议
          </Button>
        </Stack>
        {aiReply && (
          <Typography variant="body2" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>
            {aiReply}
          </Typography>
        )}
      </Paper>

      {/* 待处理提案 */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Typography variant="h6" gutterBottom>
          待处理提案
        </Typography>
        {loading ? (
          <Box textAlign="center" py={2}>
            <CircularProgress size={24} />
          </Box>
        ) : proposals.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            暂无待处理提案。
          </Typography>
        ) : (
          <Stack divider={<Divider flexItem />}>
            {proposals.map((p) => {
              const changes = p.changes as { toolName?: string; input?: Record<string, unknown> };
              return (
                <Box key={p.id} py={1.5}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Chip size="small" color={RISK_COLOR[p.riskLevel]} label={RISK_LABEL[p.riskLevel]} />
                    <Typography variant="body2" fontWeight={600}>
                      {changes.toolName ?? '未知工具'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {new Date(p.createdAt).toLocaleString()}
                    </Typography>
                  </Stack>
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    理由：{p.reason}
                  </Typography>
                  <Typography
                    variant="caption"
                    component="pre"
                    sx={{
                      mt: 0.5,
                      p: 1,
                      bgcolor: 'grey.100',
                      borderRadius: 1,
                      overflowX: 'auto',
                      fontSize: 11,
                    }}
                  >
                    {JSON.stringify(changes.input ?? {}, null, 2)}
                  </Typography>
                  <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
                    <Button
                      size="small"
                      color="inherit"
                      disabled={busyId === p.id}
                      onClick={() => void decide(p.id, false)}
                    >
                      驳回
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      disabled={busyId === p.id}
                      onClick={() => void decide(p.id, true)}
                    >
                      {busyId === p.id ? <CircularProgress size={18} /> : '确认执行'}
                    </Button>
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        )}
      </Paper>
    </Box>
  );
}
