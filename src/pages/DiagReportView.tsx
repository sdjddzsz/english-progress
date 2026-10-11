/**
 * DiagReportView.tsx —— 诊断报告视图（PRD §4.9，架构 T05 白名单机制）：
 * 模考 diag_report 与诊断聚合【仅】在此后台路由渲染；组件内置路由白名单自检，
 * 被挂到白名单之外的任何路由时拒绝渲染（物理防误接）。
 * 报告无总分概念：呈现分层表现、混淆对、模态差距与模考逐题诊断（外部效度例外）。
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import type { MockExamRecord } from '../types/domain';
import { getRepos, useAppStore } from '../store/useAppStore';

/** 诊断视图允许挂载的路由白名单（物理防误接机制） */
export const DIAG_REPORT_ALLOWED_PATHS: readonly string[] = ['/dashboard/diag'];

export default function DiagReportView() {
  const { pathname } = useLocation();
  const { userId, bootstrap } = useAppStore();
  const [records, setRecords] = useState<MockExamRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const whitelisted = DIAG_REPORT_ALLOWED_PATHS.includes(pathname);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!whitelisted || !userId) return;
    void (async () => {
      setLoading(true);
      try {
        const rows = await getRepos().config.mockRecords.list(
          [{ column: 'userId', op: 'eq', value: userId }],
          { orderBy: 'takenAt', ascending: false, limit: 20 },
        );
        setRecords(rows);
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [whitelisted, userId]);

  // ===== 白名单自检：非诊断路由一律拒绝渲染 =====
  if (!whitelisted) {
    return (
      <Alert severity="error">
        诊断报告仅允许在后台路由（{DIAG_REPORT_ALLOWED_PATHS.join('、')}）渲染——当前路由不在白名单内。
      </Alert>
    );
  }

  return (
    <Box p={2} pb={4}>
      <Typography variant="h5">诊断报告</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        隐式评估 + 模考诊断（唯一允许呈现外部效度信息的位置）；不含任何前台指标。
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}

      {/* 隐式评估：欠账与阈值（诊断口径） */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Typography variant="h6" gutterBottom>
          学习状态诊断
        </Typography>
        <OverdueDiagnostic />
      </Paper>

      {/* 模考记录（diag_report 原文渲染） */}
      <Paper sx={{ mt: 2, p: 2 }}>
        <Typography variant="h6" gutterBottom>
          模考记录（{records.length}）
        </Typography>
        {loading ? (
          <Box textAlign="center" py={2}>
            <CircularProgress size={24} />
          </Box>
        ) : records.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            暂无模考记录——解锁规则批准后可在「模考」页记录一次模考。
          </Typography>
        ) : (
          <Stack divider={<Divider flexItem />}>
            {records.map((r) => (
              <Box key={r.id} py={1.5}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip size="small" label={r.paperRef} variant="outlined" />
                  <Typography variant="caption" color="text.secondary">
                    {new Date(r.takenAt).toLocaleString()}
                  </Typography>
                </Stack>
                <Typography
                  variant="caption"
                  component="pre"
                  sx={{ mt: 0.5, p: 1, bgcolor: 'grey.100', borderRadius: 1, overflowX: 'auto', fontSize: 11 }}
                >
                  {JSON.stringify(r.diagReport, null, 2)}
                </Typography>
              </Box>
            ))}
          </Stack>
        )}
      </Paper>
    </Box>
  );
}

/** 欠账诊断（挂载于白名单内才渲染的子块） */
function OverdueDiagnostic() {
  const { overdue } = useAppStore();
  if (!overdue) {
    return (
      <Typography variant="body2" color="text.secondary">
        无生效计划，暂无可诊断数据。
      </Typography>
    );
  }
  return (
    <>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Chip size="small" variant="outlined" label={`欠账 ${overdue.count} / 阈值 ${overdue.threshold}`} />
        <Chip
          size="small"
          color={overdue.mustReschedule ? 'warning' : 'default'}
          variant="outlined"
          label={overdue.mustReschedule ? '需重排' : '在阈值内'}
        />
        <Chip size="small" variant="outlined" label={`距上次学习 ${overdue.idleDays} 天`} />
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
        诊断口径：欠账与轮次覆盖；前台三类记录类型物理不含评分字段（硬约束 #1）。
      </Typography>
    </>
  );
}
