/**
 * PlanSummaryCard.tsx —— 计划概览卡：
 * 档位 / 各层轮次 / 起止与预计完成日 / 日均任务量与时间预算校验（validatePlan 结果）。
 * 硬约束 #1 边界：只展示任务量与时间（"日均 N 个 · M 分钟"），不出现禁用词表任何概念。
 *
 * 用户 2026-10-15：四个标签（档位 / 状态 / 降频 / 欠账）必须可点、点了要有解释——
 * "看起来能点的就必须能点，点了就知道它是干嘛的"。故每个 chip 都接 Dialog 说明，
 * 档位与欠账还给到明确去向（计划编辑 / 欠账重排）。
 */
import { Alert, Box, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Button, LinearProgress, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import type { StudyPlan } from '../../types/domain';
import type { ValidationResult } from '../../scheduler';

export interface PlanSummaryCardProps {
  plan: StudyPlan | null;
  validation: ValidationResult | null;
  finishDate?: string | null;
  /** 剩余欠账数（>0 时提示去处理） */
  overdueCount?: number;
  /** 档位/参数调整入口（如跳计划编辑页） */
  onEditPlan?: () => void;
  /** 欠账处理入口（如打开重排弹窗） */
  onOpenReschedule?: () => void;
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

/** 各标签的说明弹窗 key */
type HelpKey = 'mode' | 'status' | 'decay' | 'overdue';

const MODE_HELP: Record<StudyPlan['planMode'], string> = {
  recommended:
    '推荐档：按"越生疏的词轮次越多"分配（生词比熟词多安排几轮），同样的时间里覆盖更多薄弱词。适合大多数情况。',
  fallback:
    '保底档：所有层统一 2 轮。每天任务量更小、更稳，适合时间紧或想先保完成率的阶段。',
};

const STATUS_HELP: Record<StudyPlan['status'], string> = {
  draft: '草稿：还没生效，不会排任务。去「计划编辑」确认后生效。',
  active: '进行中：正在按这个计划每天排考查任务。',
  maintenance: '维持模式：主体已完成，只对残余词做维持性复习。',
  finished: '已完成：全部词都已过完，不会再排新任务。',
};

export default function PlanSummaryCard({ plan, validation, finishDate, overdueCount = 0, onEditPlan, onOpenReschedule }: PlanSummaryCardProps) {
  const [help, setHelp] = useState<HelpKey | null>(null);
  if (!plan || !validation) {
    return (
      <Alert severity="info">还没有生效中的计划——去「词书」页选择词书并创建计划。</Alert>
    );
  }

  const minutesRatio = Math.min(100, (validation.dailyMinutes / Math.max(1, plan.dailyBudgetMin)) * 100);

  const close = () => setHelp(null);

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Chip
          label={MODE_LABEL[plan.planMode]}
          color="primary"
          size="small"
          onClick={() => setHelp('mode')}
          sx={{ cursor: 'pointer' }}
        />
        <Chip
          label={STATUS_LABEL[plan.status]}
          size="small"
          variant="outlined"
          onClick={() => setHelp('status')}
          sx={{ cursor: 'pointer' }}
        />
        {plan.masteryDecayEnabled && (
          <Chip
            label="降频开启"
            size="small"
            variant="outlined"
            onClick={() => setHelp('decay')}
            sx={{ cursor: 'pointer' }}
          />
        )}
        {overdueCount > 0 && (
          <Chip
            label={`欠账 ${overdueCount}`}
            color="warning"
            size="small"
            onClick={() => setHelp('overdue')}
            sx={{ cursor: 'pointer' }}
          />
        )}
      </Stack>

      <Typography variant="body2" sx={{ mt: 1 }}>
        窗口：{plan.startDate} → {plan.deadlineDate}
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

      {/* 标签说明弹窗（用户 2026-10-15：能点的都要有解释） */}
      <Dialog open={help !== null} onClose={close} maxWidth="xs" fullWidth>
        <DialogTitle>
          {help === 'mode'
            ? `档位：${MODE_LABEL[plan.planMode]}`
            : help === 'status'
              ? `计划状态：${STATUS_LABEL[plan.status]}`
              : help === 'decay'
                ? '降频开启'
                : `欠账 ${overdueCount} 条`}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {help === 'mode'
              ? MODE_HELP[plan.planMode]
              : help === 'status'
                ? STATUS_HELP[plan.status]
                : help === 'decay'
                  ? '已经练熟（近 30 天反复表现稳固）的词会自动降低出现频率，把每天的份额让给还生的词。不需要你操作，练就是了。'
                  : '有到期的任务没做完。欠账会累积，超过阈值就需要先重排（把旧账并进新计划）再继续，否则队列会越拖越长。'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>知道了</Button>
          {help === 'mode' && onEditPlan && (
            <Button
              variant="contained"
              onClick={() => {
                close();
                onEditPlan();
              }}
            >
              去调整参数
            </Button>
          )}
          {help === 'overdue' && onOpenReschedule && (
            <Button
              variant="contained"
              onClick={() => {
                close();
                onOpenReschedule();
              }}
            >
              去处理欠账
            </Button>
          )}
          {help === 'decay' && onEditPlan && (
            <Button
              onClick={() => {
                close();
                onEditPlan();
              }}
            >
              在计划编辑里调整
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  );
}
