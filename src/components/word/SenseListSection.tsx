/**
 * SenseListSection.tsx —— 题卡里的「全部释义」区块（2026-10-15：多义词出答案必须完整显示）。
 * 2026-10-18：长按/右键可编辑/删除；2026-10-19：可当场增加词义（写回词书）。
 * 2026-10-20：标题与「+增加词义」并一行、删掉长操作提示——一屏装下。
 * 2026-10-22：长按改为弹出菜单——「编辑义项 / 生成例句」（用户：每个释义长按后多一个生成例句选项）。
 */
import { useState } from 'react';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import LongPressSenseRow from './LongPressSenseRow';
import { displaySenses } from '../../features/senses';
import type { Word } from '../../types/domain';

interface Props {
  word: Word;
  /** 本题正在考的义项序号（标注「← 本题」；不给则不标注，如阶段四纯展示） */
  currentSenseIndex?: number;
  /** 菜单「编辑义项」→ 打开编辑弹窗 */
  onLongPress: (index: number) => void;
  /** 「+ 增加词义」→ 打开新增弹窗 */
  onAdd: () => void;
  /** 菜单「生成例句」→ 为该义项生成一条例句 */
  onGenerateExample: (index: number) => void;
  /** 例句生成中（菜单项禁用 + 文案） */
  genBusy?: boolean;
}

export default function SenseListSection({
  word,
  currentSenseIndex,
  onLongPress,
  onAdd,
  onGenerateExample,
  genBusy = false,
}: Props) {
  const [menu, setMenu] = useState<{ index: number; el: HTMLElement } | null>(null);

  return (
    <Box sx={{ width: '100%', textAlign: 'left' }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" useFlexGap sx={{ width: '100%' }}>
        <Typography variant="caption" color="text.secondary">
          {word.lemma} 的全部释义
          {currentSenseIndex != null ? `（本题考第 ${currentSenseIndex + 1} 个）` : ''}
        </Typography>
        <Button
          size="small"
          startIcon={<AddIcon fontSize="small" />}
          onClick={onAdd}
          sx={{ textTransform: 'none', minHeight: 0, py: 0.25 }}
        >
          增加词义
        </Button>
      </Stack>
      <Stack spacing={0.25} sx={{ mt: 0.25 }}>
        {displaySenses(word).map((sense, i) => (
          <LongPressSenseRow
            key={sense.senseId}
            sense={sense}
            index={i}
            isCurrent={currentSenseIndex === i}
            onLongPress={(index, el) => setMenu({ index, el })}
          />
        ))}
      </Stack>
      <Menu
        anchorEl={menu?.el ?? null}
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchorOrigin={{ vertical: 'center', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem
          onClick={() => {
            const i = menu?.index;
            setMenu(null);
            if (i != null) onLongPress(i);
          }}
        >
          编辑义项
        </MenuItem>
        <MenuItem
          disabled={genBusy}
          onClick={() => {
            const i = menu?.index;
            setMenu(null);
            if (i != null) onGenerateExample(i);
          }}
        >
          {genBusy ? '生成中…' : '生成例句'}
        </MenuItem>
      </Menu>
    </Box>
  );
}
