/**
 * LongPressSenseRow.tsx —— 「全部释义」列表里的一行（用户 2026-10-18：释义刁琐要能就地改/删）。
 * 2026-10-23 改造（用户：同一个词性下「放弃，抛弃」要能按单条意思分别生成例句）：
 *  - 行内每个**子义项**（逗号/分号拆开）都是独立的长按目标 ⇒ 给那一条意思生成例句；
 *  - 义项级操作（编辑/删除）从行内长按**搬进行尾的铅笔按钮**——两类手势不再互相冲突。
 * 2026-10-24（用户：fine 的音标是错的，音标也做成长按可编辑）：
 *  - 行内展示该义项自己的读音，**长按音标** ⇒ 编辑这一条读音（独立第三类手势目标，
 *    与子义项长按、铅笔菜单互不打架：音标是一片独立的小文本）。
 */
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import EditIcon from '@mui/icons-material/Edit';
import { useLongPress } from '../../hooks/useLongPress';
import type { WordSense } from '../../types/domain';

interface Props {
  sense: WordSense;
  index: number;
  isCurrent: boolean;
  /** 长按某个子义项 → 生成例句（subZh = 逗号拆开的单条意思） */
  onLongPressSub: (index: number, subZh: string, anchorEl: HTMLElement) => void;
  /** 长按音标 → 编辑这一条读音（用户 2026-10-24） */
  onEditSensePron: (index: number, anchorEl: HTMLElement) => void;
  /** 点行尾铅笔 → 义项级菜单（编辑/删除） */
  onEditSense: (index: number, anchorEl: HTMLElement) => void;
}

export default function LongPressSenseRow({ sense, index, isCurrent, onLongPressSub, onEditSensePron, onEditSense }: Props) {
  // 行内长按只挂子义项 span（不挂整行）——整行长按会让「编辑」和「生成例句」两种手势打架
  const parts = sense.zh.split(/([，,；;、])/).filter((p) => p.length > 0);
  // 音标独立长按目标（用户 2026-10-24）：与子义项长按、铅笔菜单分开
  const pronPress = useLongPress((el) => onEditSensePron(index, el ?? document.body));

  return (
    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ py: 0.25 }}>
      <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
        {index + 1}. {sense.pos ? `[${sense.pos}] ` : ''}
      </Typography>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        {parts.map((part, i) =>
          /[，,；;、]/.test(part) ? (
            <Typography key={i} component="span" variant="body2" color="text.secondary">
              {part}
            </Typography>
          ) : (
            <SubMeaning key={i} text={part} index={index} onLongPressSub={onLongPressSub} />
          ),
        )}
        {isCurrent && (
          <Typography component="span" variant="caption" color="primary" sx={{ ml: 0.5 }}>
            ← 本题
          </Typography>
        )}
      </Box>
      {/* 读音列：与该义项绑定；长按可改（2026-10-24） */}
      {sense.ipa && (
        <Tooltip title="长按修改这一条读音">
          <Box
            component="span"
            {...pronPress}
            sx={{
              cursor: 'pointer',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              WebkitTouchCallout: 'none',
              flexShrink: 0,
              borderRadius: 0.5,
              px: 0.25,
              mx: -0.25,
              overflowWrap: 'anywhere',
              '&:active': { bgcolor: 'action.hover' },
            }}
          >
            <Typography component="span" variant="caption" color="text.secondary">
              /{sense.ipa.replace(/^\/|\/$/g, '')}/
            </Typography>
          </Box>
        </Tooltip>
      )}
      <Tooltip title="编辑/删除这个义项">
        <IconButton size="small" aria-label={`编辑义项 ${index + 1}`} onClick={(e) => onEditSense(index, e.currentTarget)}>
          <EditIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

/** 单个子义项：可长按（给这一条意思生成例句）。分隔符旁也有压深反馈 */
function SubMeaning({
  text,
  index,
  onLongPressSub,
}: {
  text: string;
  index: number;
  onLongPressSub: (index: number, subZh: string, anchorEl: HTMLElement) => void;
}) {
  const press = useLongPress((el) => onLongPressSub(index, text, el ?? document.body));
  return (
    <Box
      component="span"
      {...press}
      sx={{
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        cursor: 'pointer',
        borderRadius: 0.5,
        px: 0.25,
        mx: -0.25,
        '&:active': { bgcolor: 'action.hover' },
      }}
    >
      <Typography component="span" variant="body2">
        {text}
      </Typography>
    </Box>
  );
}
