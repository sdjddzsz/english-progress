/**
 * PressableIpa.tsx —— 可长按的音标文本（用户 2026-10-24：音标要做成长按可编辑）。
 * 长按（桌面端顺手支持右键）→ 回调打开音标编辑弹窗；悬停 Tooltip 说明手势，
 * 免得用户不知道这一片小字还能按（联动：与释义长按同一套 useLongPress）。
 */
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useLongPress } from '../../hooks/useLongPress';

interface Props {
  ipa: string;
  /** 长按/右键触发（参数 = 触发节点，调用方不需要可忽略） */
  onEdit: (el?: HTMLElement) => void;
  color?: string;
  variant?: 'body1' | 'body2' | 'caption';
  /** Tooltip 文案（说明改的是哪一条读音；缺省给通用文案） */
  hint?: string;
}

export default function PressableIpa({
  ipa,
  onEdit,
  color = 'text.secondary',
  variant = 'body2',
  hint,
}: Props) {
  const press = useLongPress(onEdit);
  return (
    <Tooltip title={hint ?? '长按修改音标（读音与合成音频一起改）'}>
      <Box
        component="span"
        {...press}
        sx={{
          cursor: 'pointer',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
          borderRadius: 0.5,
          px: 0.25,
          mx: -0.25,
          // 音标是一整个无空格 token，必须 anywhere 才能换行
          overflowWrap: 'anywhere',
          '&:active': { bgcolor: 'action.hover' },
        }}
      >
        <Typography variant={variant} color={color} component="span">
          /{ipa.replace(/^\/|\/$/g, '')}/
        </Typography>
      </Box>
    </Tooltip>
  );
}
