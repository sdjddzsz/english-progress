/**
 * LongPressSenseRow.tsx —— 「全部释义」列表里的一行：长按（手机）/右键（桌面）弹出操作菜单。
 * 用户 2026-10-18：有些词的释义极其刁钻，要能就地改/删。只挂在这一行上，不挂整页（滚动误触）。
 * 2026-10-22：长按改为弹菜单（编辑义项 / 生成例句），锚点元素回传给父组件挂 Menu。
 */
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useLongPress } from '../../hooks/useLongPress';
import type { WordSense } from '../../types/domain';

interface Props {
  sense: WordSense;
  index: number;
  isCurrent: boolean;
  /** 长按/右键 → 打开操作菜单（index + 锚点元素） */
  onLongPress: (index: number, anchorEl: HTMLElement) => void;
}

export default function LongPressSenseRow({ sense, index, isCurrent, onLongPress }: Props) {
  const press = useLongPress((el) => onLongPress(index, el ?? document.body));
  return (
    <Box
      {...press}
      sx={{
        // 长按不应触发系统选中/弹出系统菜单，否则弹窗被文字选择盖住
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        cursor: 'pointer',
        borderRadius: 1,
        px: 0.5,
        mx: -0.5,
        '&:active': { bgcolor: 'action.hover' },
      }}
    >
      <Typography
        variant="body2"
        sx={{
          color: isCurrent ? 'text.primary' : 'text.secondary',
          fontWeight: isCurrent ? 600 : 400,
        }}
      >
        {index + 1}. {sense.pos ? `[${sense.pos}] ` : ''}
        {sense.zh}
        {isCurrent ? ' ← 本题' : ''}
      </Typography>
    </Box>
  );
}
