/**
 * MockExamPage.tsx —— 模考页（PRD §4.9，T05）：
 * 锁定态 → AI 制定解锁规则（update_mock_unlock_rule，Confirm 提案）→ 用户批准
 * （updateMockRuleStatus → approved）→ 解锁「记录一次模考」→ saveMockRecord
 * → 结果只在后台诊断路由（DiagReportView 白名单）呈现。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { MockUnlockRule } from '../types/domain';
import { decideProposal, executeTool } from '../ai/authz';
import { getRepos, getToolCtx, useAppStore } from '../store/useAppStore';

export default function MockExamPage() {
  const navigate = useNavigate();
  const { userId, activePlan, bootstrap } = useAppStore();

  const [rule, setRule] = useState<MockUnlockRule | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [paperRef, setPaperRef] = useState('');
  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const active = await getRepos().config.getActiveMockRule(userId);
      setRule(active);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 请求 AI 制定解锁规则（Confirm 提案 → 页面内确认即放行） */
  const requestRule = async () => {
    if (!userId) return;
    setBusy(true);
    setError('');
    try {
      const ctx = getToolCtx(userId, activePlan?.id);
      const decision = await executeTool(
        { ctx },
        {
          toolName: 'update_mock_unlock_rule',
          input: { ruleJson: { trigger: 'weekly-review' }, reason: '用户在模考页请求制定解锁规则' },
          actor: 'user',
        },
      );
      if (decision.kind === 'rejected') throw new Error(decision.reason);
      if (decision.kind === 'confirm' || decision.kind === 'require') {
        const approved = await decideProposal({ ctx }, decision.proposalId, true);
        if (approved.kind !== 'auto') throw new Error('规则草案未生效');
      }
      setMsg('解锁规则草案已生成（状态 draft），批准后解锁模考记录。');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 批准草案 → approved（之后即可记录模考） */
  const approveRule = async () => {
    if (!rule) return;
    setBusy(true);
    try {
      await getRepos().config.updateMockRuleStatus(rule.id, 'approved', new Date().toISOString());
      setMsg('解锁规则已批准。');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 记录一次模考（diagReport 仅进后台诊断路由） */
  const saveRecord = async () => {
    if (!userId || !paperRef.trim()) return;
    setBusy(true);
    try {
      let diag: Record<string, unknown> = {};
      try {
        diag = JSON.parse(notes) as Record<string, unknown>;
      } catch {
        diag = { notes };
      }
      await getRepos().config.saveMockRecord({
        userId,
        paperRef: paperRef.trim(),
        takenAt: new Date().toISOString(),
        ...(rule?.id ? { unlockRuleId: rule.id } : {}),
        diagReport: diag,
        createdAt: new Date().toISOString(),
      });
      setPaperRef('');
      setNotes('');
      setMsg('模考记录已保存——诊断内容仅在后台「诊断报告」呈现。');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const STATUS_LABEL: Record<MockUnlockRule['status'], string> = {
    draft: '草案（待批准）',
    approved: '已批准',
    active: '生效中',
    revoked: '已撤销',
  };

  return (
    <Box p={2} pb={4} maxWidth={640} mx="auto">
      <Typography variant="h5">模考</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        模考是有外部效度的唯一例外：解锁规则由 AI 依据学习数据制定、你批准后开放；结果只在后台诊断报告呈现。
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

      {loading ? (
        <Box textAlign="center" py={4}>
          <CircularProgress />
        </Box>
      ) : !rule ? (
        <Paper sx={{ mt: 2, p: 3, textAlign: 'center' }}>
          <Typography variant="body1">暂无解锁规则</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            学习数据积累一段时间后，AI 会基于稳固信号给出规则草案；也可现在就请求一份。
          </Typography>
          <Button variant="contained" sx={{ mt: 2 }} disabled={busy} onClick={() => void requestRule()}>
            {busy ? <CircularProgress size={20} /> : '请求 AI 制定解锁规则'}
          </Button>
        </Paper>
      ) : (
        <>
          <Paper sx={{ mt: 2, p: 2 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Chip
                size="small"
                color={rule.status === 'draft' ? 'warning' : 'success'}
                label={STATUS_LABEL[rule.status]}
              />
              {rule.status === 'draft' && (
                <Button size="small" variant="contained" disabled={busy} onClick={() => void approveRule()}>
                  批准此规则
                </Button>
              )}
            </Stack>
            <Typography variant="body2" sx={{ mt: 1 }}>
              规则依据：{rule.reason}
            </Typography>
            <Typography
              variant="caption"
              component="pre"
              sx={{ mt: 1, p: 1, bgcolor: 'grey.100', borderRadius: 1, overflowX: 'auto', fontSize: 11 }}
            >
              {JSON.stringify(rule.ruleJson, null, 2)}
            </Typography>
          </Paper>

          {rule.status !== 'draft' && (
            <Paper sx={{ mt: 2, p: 2 }}>
              <Typography variant="h6" gutterBottom>
                记录一次模考
              </Typography>
              <Stack spacing={2}>
                <TextField
                  label="试卷编号（如 2023-12 六级真题一）"
                  value={paperRef}
                  onChange={(e) => setPaperRef(e.target.value)}
                  size="small"
                />
                <TextField
                  label="诊断数据（JSON 或文字备注）"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  size="small"
                  multiline
                  minRows={3}
                />
                <Stack direction="row" justifyContent="flex-end">
                  <Button variant="contained" disabled={busy || !paperRef.trim()} onClick={() => void saveRecord()}>
                    保存记录
                  </Button>
                  <Button sx={{ ml: 1 }} onClick={() => navigate('/dashboard/diag')}>
                    查看诊断报告
                  </Button>
                </Stack>
              </Stack>
            </Paper>
          )}
        </>
      )}
    </Box>
  );
}
