import { BottomNavigation, BottomNavigationAction, Container, Typography, Box } from '@mui/material';
import TodayIcon from '@mui/icons-material/Today';
import SchoolIcon from '@mui/icons-material/School';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import InsightsIcon from '@mui/icons-material/Insights';
import SettingsIcon from '@mui/icons-material/Settings';
import { useState } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';

/**
 * 应用外壳：底部 5 Tab（Today / 训练 / 词书 / 后台 / 设置），对应 PRD §5.1。
 * T04 批次会用真实页面替换占位组件；本文件只负责路由与布局骨架。
 */

function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Typography variant="h5" gutterBottom>
        {title}
      </Typography>
      <Box sx={{ color: 'text.secondary' }}>
        <Typography variant="body2">{hint}</Typography>
      </Box>
    </Container>
  );
}

const TAB_PATHS = ['/', '/training', '/book', '/dashboard', '/settings'] as const;

export default function App() {
  const [tab, setTab] = useState(0);
  const navigate = useNavigate();

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <Box sx={{ flex: 1 }}>
        <Routes>
          <Route path="/" element={<Placeholder title="Today" hint="今日队列 / 欠账状态 / 距出师天数（T04 实现）" />} />
          <Route path="/training" element={<Placeholder title="训练" hint="听词联想 / 中→英 / 融会贯通 / 模考（锁定态）（T04 实现）" />} />
          <Route path="/book" element={<Placeholder title="词书" hint="分层视图 / 计划编辑 / 导入（T04 实现）" />} />
          <Route path="/dashboard" element={<Placeholder title="后台" hint="各层进度 / 欠账 / 诊断（无总分正确率）（T04 实现）" />} />
          <Route path="/settings" element={<Placeholder title="设置" hint="TTS / 调度参数 / AI 端点（T04 实现）" />} />
        </Routes>
      </Box>
      <BottomNavigation
        value={tab}
        onChange={(_, newValue: number) => {
          setTab(newValue);
          navigate(TAB_PATHS[newValue]);
        }}
        sx={{ position: 'sticky', bottom: 0 }}
      >
        <BottomNavigationAction label="Today" icon={<TodayIcon />} />
        <BottomNavigationAction label="训练" icon={<SchoolIcon />} />
        <BottomNavigationAction label="词书" icon={<MenuBookIcon />} />
        <BottomNavigationAction label="后台" icon={<InsightsIcon />} />
        <BottomNavigationAction label="设置" icon={<SettingsIcon />} />
      </BottomNavigation>
    </Box>
  );
}
