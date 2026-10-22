/**
 * QuizTimerBadge.tsx —— 考查计时徽标（用户 2026-10-19：每个单词考查时显示计时，答题后停止计时；
 * 2026-10-20：简化——只在单词旁边显示一个小 chip，不再占整行。档位说明移入 hover 提示，
 * 页面顶部说明里也有同一口径）。
 *
 * running 进行中：⏱ 计时 12.3s；已停止（答题/回顾已答题）：⏱ 用时 4.8s（定格）；
 * frozenMs=null（旧会话快照没记用时）⇒ 显示「用时未记录」，不编造 0.0s。
 */
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import TimerIcon from '@mui/icons-material/Timer';
import { useAnswerTimer } from '../../hooks/useAnswerTimer';
import { formatElapsedMs, TIMING_HINT } from '../../features/quiz/timing';

interface Props {
  /** 本题出题时间戳（Date.now()；未出题传 0） */
  startedAt: number;
  /** 是否正在计时（未答才 true） */
  running: boolean;
  /** 停止时定格的毫秒数；null=没有用时记录 */
  frozenMs: number | null;
}

export default function QuizTimerBadge({ startedAt, running, frozenMs }: Props) {
  const ms = useAnswerTimer(startedAt, running, frozenMs);
  const label = running
    ? `计时 ${formatElapsedMs(ms)}`
    : frozenMs == null
      ? '用时未记录'
      : `用时 ${formatElapsedMs(ms)}`;
  return (
    <Tooltip title={TIMING_HINT}>
      <Chip
        size="small"
        variant="outlined"
        color={running ? 'primary' : 'default'}
        icon={<TimerIcon fontSize="small" />}
        label={label}
      />
    </Tooltip>
  );
}
