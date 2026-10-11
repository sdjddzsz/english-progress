/**
 * PlanSummaryCard.tsx —— 计划概览卡：
 * 档位 / 各层轮次 / 起止与预计完成日 / 日均任务量与时间预算校验（validatePlan 结果）。
 * 硬约束 #1 边界：只展示任务量与时间（"日均 N 个 · M 分钟"），不出现禁用词表任何概念。
 */
import { Alert, Box, Chip, LinearProgress, Stack, Typography } from '@mui/material';
import type { StudyPlan, Tier } from '../../types/domain';
import type { ValidationResult } from '../../scheduler';

export interface PlanSummaryCardProps {
  plan: StudyPlan | null;
  validation: ValidationResult | null;
  finishDate?: string | null;
  /** 剩余欠账数（>0 时提示去处理） */
  overdueCount?: number;
}

const MODE_LABEL: Record<StudyPlan['planMode'], string> = {
  recommended: '推荐档',
  fallback: '保底档',
};

const STATUS_LABEL: Record<StudyPlan['status'], string> = {
  draft: '草稿',
  active: '进行中',
  maintenance: '维持模式',
  finished: '已完成',
};

export default function PlanSummaryCard({ plan, validation, finishDate, overdueCount = 0 }: PlanSummaryCardProps) {
  if (!plan || !validation) {
    return (
      <Alert severity="info">还没有生效中的计划——去「词书」页选择词书并创建计划。</Alert>
    );
  }

  const minutesRatio = Math.min(100, (validation.dailyMinutes / Math.max(1, plan.dailyBudgetMin)) * 100);
  const roundsText = ([1, 2, 3, 4] as Tier[])
    .filter((t) => (plan.tierRounds[t] ?? 0) > 0)
    .map((t) => `T${t}×${plan.tierRounds[t]}`)
    .join(' ');

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Chip label={MODE_LABEL[plan.planMode]} color="primary" size="small" />
        <Chip label={STATUS_LABEL[plan.status]} size="small" variant="outlined" />
        {plan.masteryDecayEnabled && <Chip label="降频开启" size="small" variant="outlined" />}
        {overdueCount > 0 && <Chip label={`欠账 ${overdueCount}`} color="warning" size="small" />}
      </Stack>

      <Typography variant="body2" sx={{ mt: 1 }}>
        轮次：<strong>{roundsText}</strong> ｜ 窗口：{plan.startDate} → {plan.deadlineDate}
      </Typography>
      <Typography variant="body2">
        预计完成日：<strong>{finishDate ?? plan.deadlineDate}</strong> ｜ 距六级考试窗口{' '}
        {plan.sprintStartDate} 起为冲刺周
      </Typography>

      <Box sx={{ mt: 1.5 }}>
        <Stack direction="row" justifyContent="space-between">
          <Typography variant="body2">
            日均 {validation.dailyHits} 个 · 约 {validation.dailyMinutes.toFixed(1)} 分钟
          </Typography>
          <Typography variant="body2" color="text.secondary">
            预算 {plan.dailyBudgetMin} 分钟/天
          </Typography>
        </Stack>
        <LinearProgress
          variant="determinate"
          value={minutesRatio}
          color={validation.pass ? 'primary' : validation.critical ? 'warning' : 'error'}
          sx={{ mt: 0.5, height: 8, borderRadius: 4 }}
        />
      </Box>

      {validation.pass ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          当前参数在时间预算内可完成（余量 {(validation.marginRatio * 100).toFixed(0)}%）。
        </Typography>
      ) : validation.critical ? (
        <Alert severity="warning" sx={{ mt: 1 }}>
          余量临界（差 {(Math.abs(validation.marginRatio) * 100).toFixed(0)}%）：接近每日预算上限，建议上调预算或改保底档。
        </Alert>
      ) : (
        <Alert severity="error" sx={{ mt: 1 }}>
          按当前参数完不成：日均需 {validation.dailyMinutes.toFixed(0)} 分钟，超出预算。可在「计划编辑」里上调预算、切保底档或冻结已掌握的层。
        </Alert>
      )}
    </Box>
  );
}
