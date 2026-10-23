/**
 * PlanSummaryCard.tsx —— 计划概览卡：
 * 档位 / 状态 / 降频标签（可点有解释）+ 窗口 + **四阶段进度与真实节奏**（用户 2026-10-23 选「方案 2」）。
 *
 * 历史：本卡中段原来显示 tier 模型预估（Σ词数×轮次 ÷ 窗口 × 秒数 → 日均量/预算/红警告）——
 * 四阶段考查不计入 hits、词晋级即离池，那套数字对四阶段用户是持续误报（红线常年亮）。
 * 现改为按真实数据算：剩余词（stage≠0）+ book_words.lastQuizAt 的近 14 天节奏 →
 * 学习日均速/预计完成日/与窗口比对的速度判定。旧 validatePlan 仍供计划编辑页预览用。
 */
import { Alert, Box, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Button, LinearProgress, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import type { StudyPlan } from '../../types/domain';
import type { StageProgress, TodayQuiz } from '../../store/useAppStore';

export interface PlanSummaryCardProps {
  plan: StudyPlan | null;
  /**
   * 四阶段进度与真实节奏（store.stageProgress）。首页传；计划编辑页不传——
   * 那里的参数影响预览走自己的 tier 模型口径（预览块自带），不在这张卡上混。
   */
  progress?: StageProgress | null;
  /** 今日检测统计（store.todayQuiz；用户 2026-10-23） */
  todayQuiz?: TodayQuiz | null;
  /** 档位/参数调整入口（如跳计划编辑页） */
  onEditPlan?: () => void;
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
type HelpKey = 'mode' | 'status' | 'decay';

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

export default function PlanSummaryCard({ plan, progress, todayQuiz, onEditPlan }: PlanSummaryCardProps) {
  const [help, setHelp] = useState<HelpKey | null>(null);
  if (!plan) {
    return (
      <Alert severity="info">还没有生效中的计划——去「词书」页选择词书并创建计划。</Alert>
    );
  }

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
      </Stack>

      <Typography variant="body2" sx={{ mt: 1 }}>
        窗口：{plan.startDate} → {plan.deadlineDate}（距六级考试窗口 {plan.sprintStartDate} 起为冲刺周）
      </Typography>
      {todayQuiz && (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          今天：检测 <strong>{todayQuiz.words.length}</strong> 词（无论过没过）· 其中第一次出现{' '}
          {todayQuiz.firstSeen.length} 词
        </Typography>
      )}
      {progress && (
        <>
          <Typography variant="body2">
            剩余 <strong>{progress.remaining}</strong> 词 · 已彻底毕业 {progress.graduated} 词
          </Typography>

          <Box sx={{ mt: 1.5 }}>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2">
                近 {progress.pace.windowDays} 天：学习 {progress.pace.activeDays} 天 · 日均 {progress.pace.wordsPerDay}{' '}
                词 · 约 {progress.pace.minutesPerDay.toFixed(0)} 分钟/学习日
              </Typography>
              <Typography variant="body2" color="text.secondary">
                预算 {plan.dailyBudgetMin} 分钟/天
              </Typography>
            </Stack>
            <LinearProgress
              variant="determinate"
              value={Math.min(100, (progress.pace.minutesPerDay / Math.max(1, plan.dailyBudgetMin)) * 100)}
              color={progress.pace.minutesPerDay <= plan.dailyBudgetMin ? 'primary' : 'error'}
              sx={{ mt: 0.5, height: 8, borderRadius: 4 }}
            />
          </Box>

          {progress.verdict.kind === 'finished' ? (
            <Alert severity="success" sx={{ mt: 1 }}>
              全部词已彻底毕业——四阶段走完，不会再排新内容。
            </Alert>
          ) : progress.verdict.kind === 'insufficient' ? (
            <Alert severity="info" sx={{ mt: 1 }}>
              近 {progress.pace.windowDays} 天只学了 {progress.verdict.activeDays} 天，节奏数据还不够——再学几天，这里会按你的真实速度给出预计完成日。
            </Alert>
          ) : progress.verdict.kind === 'ontrack' ? (
            <Alert severity="success" sx={{ mt: 1 }}>
              预计完成日：<strong>{progress.verdict.finishDate}</strong>（按当前节奏）——可在窗口内完成，余量{' '}
              {progress.verdict.gapDays} 天。
            </Alert>
          ) : (
            <Alert severity="warning" sx={{ mt: 1 }}>
              预计完成日：<strong>{progress.verdict.finishDate}</strong>（按当前节奏）——超出窗口{' '}
              {progress.verdict.gapDays} 天。要按时完成需日均提到 {progress.verdict.neededPerDay} 词（约{' '}
              {progress.verdict.neededMinutes.toFixed(0)} 分钟/天）；或去「计划编辑」改窗口/目标。
            </Alert>
          )}
        </>
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
                : ''}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {help === 'mode'
              ? MODE_HELP[plan.planMode]
              : help === 'status'
                ? STATUS_HELP[plan.status]
                : help === 'decay'
                  ? '已经练熟（近 30 天反复表现稳固）的词会自动降低出现频率，把每天的份额让给还生的词。不需要你操作，练就是了。'
                  : ''}
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
