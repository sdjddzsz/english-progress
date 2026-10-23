/**
 * SenseListSection.tsx —— 题卡里的「全部释义」区块（2026-10-15：多义词出答案必须完整显示）。
 * 2026-10-18：义项可编辑/删除；2026-10-19：可当场增加词义（写回词书）。
 * 2026-10-20：标题与「+增加词义」并一行、删掉长操作提示——一屏装下。
 * 2026-10-22：长按释义弹「生成例句」；2026-10-23（用户：同一个词性写了多条意思，
 * 每条都要能单独生成例句）：每个**子义项**（逗号/分号拆开）独立长按 ⇒ 给那一条意思
 * 生成例句；义项的编辑/删除搬进行尾铅笔按钮的菜单——两类手势分开，不再冲突。
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
  /** 铅笔菜单「编辑义项」→ 打开编辑弹窗 */
  onEditSense: (index: number) => void;
  /** 铅笔菜单「删除义项」→ 打开编辑弹窗（删除在弹窗内确认） */
  onDeleteSense: (index: number) => void;
  /** 「+ 增加词义」→ 打开新增弹窗 */
  onAdd: () => void;
  /** 子义项长按「生成例句」→ 为该条意思生成一条例句 */
  onGenerateExample: (senseIndex: number, subZh: string) => void;
  /** 例句生成中（菜单项禁用 + 文案） */
  genBusy?: boolean;
}

export default function SenseListSection({
  word,
  currentSenseIndex,
  onEditSense,
  onDeleteSense,
  onAdd,
  onGenerateExample,
  genBusy = false,
}: Props) {
  const [subMenu, setSubMenu] = useState<{ index: number; subZh: string; el: HTMLElement } | null>(null);
  const [senseMenu, setSenseMenu] = useState<{ index: number; el: HTMLElement } | null>(null);

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
            onLongPressSub={(index, subZh, el) => setSubMenu({ index, subZh, el })}
            onEditSense={(index, el) => setSenseMenu({ index, el })}
          />
        ))}
      </Stack>
      {/* 子义项菜单：只做一件事——给这一条意思生成例句 */}
      <Menu
        anchorEl={subMenu?.el ?? null}
        open={subMenu !== null}
        onClose={() => setSubMenu(null)}
        anchorOrigin={{ vertical: 'center', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem
          disabled={genBusy}
          onClick={() => {
            const m = subMenu;
            setSubMenu(null);
            if (m) onGenerateExample(m.index, m.subZh);
          }}
        >
          {genBusy ? '生成中…' : `生成例句（${subMenu?.subZh ?? ''}）`}
        </MenuItem>
      </Menu>
      {/* 义项级菜单：编辑 / 删除 */}
      <Menu
        anchorEl={senseMenu?.el ?? null}
        open={senseMenu !== null}
        onClose={() => setSenseMenu(null)}
        anchorOrigin={{ vertical: 'center', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem
          onClick={() => {
            const i = senseMenu?.index;
            setSenseMenu(null);
            if (i != null) onEditSense(i);
          }}
        >
          编辑义项
        </MenuItem>
        <MenuItem
          onClick={() => {
            const i = senseMenu?.index;
            setSenseMenu(null);
            if (i != null) onDeleteSense(i);
          }}
        >
          删除义项
        </MenuItem>
      </Menu>
    </Box>
  );
}
