import { Box, BottomNavigation, BottomNavigationAction } from '@mui/material';
import TodayIcon from '@mui/icons-material/Today';
import SchoolIcon from '@mui/icons-material/School';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import InsightsIcon from '@mui/icons-material/Insights';
import SettingsIcon from '@mui/icons-material/Settings';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import TodayPage from './pages/TodayPage';
import StudyPage from './pages/StudyPage';
import TrainingPage from './pages/TrainingPage';
import AudioRecallPage from './pages/AudioRecallPage';
import CnToEnPage from './pages/CnToEnPage';
import BookPage from './pages/BookPage';
import PlanEditorPage from './pages/PlanEditorPage';
import DashboardPage from './pages/DashboardPage';
import AiPlanPage from './pages/AiPlanPage';
import SettingsPage from './pages/SettingsPage';

/**
 * 应用外壳：底部 5 Tab（Today / 训练 / 词书 / 后台 / 设置），对应 PRD §5.1。
 * 子路由：/study 逐 hit 学习流、/training/{audio,cn2en} 训练、/plan-editor 计划编辑、
 * /ai-plan AI 方案。欠账守卫的路由级拦截在 T05 批次接入。
 */

const TAB_DEFS = [
  { path: '/', icon: <TodayIcon />, label: 'Today' },
  { path: '/training', icon: <SchoolIcon />, label: '训练' },
  { path: '/book', icon: <MenuBookIcon />, label: '词书' },
  { path: '/dashboard', icon: <InsightsIcon />, label: '后台' },
  { path: '/settings', icon: <SettingsIcon />, label: '设置' },
] as const;

function activeTabIndex(pathname: string): number {
  if (pathname.startsWith('/study')) return 0;
  if (pathname.startsWith('/training')) return 1;
  if (pathname.startsWith('/book') || pathname.startsWith('/plan-editor')) return 2;
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/ai-plan')) return 3;
  if (pathname.startsWith('/settings')) return 4;
  return 0;
}

export default function App() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <Box sx={{ flex: 1 }}>
        <Routes>
          <Route path="/" element={<TodayPage />} />
          <Route path="/study" element={<StudyPage />} />
          <Route path="/training" element={<TrainingPage />} />
          <Route path="/training/audio" element={<AudioRecallPage />} />
          <Route path="/training/cn2en" element={<CnToEnPage />} />
          <Route path="/book" element={<BookPage />} />
          <Route path="/plan-editor" element={<PlanEditorPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/ai-plan" element={<AiPlanPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Box>
      <BottomNavigation
        value={activeTabIndex(pathname)}
        onChange={(_, newValue: number) => navigate(TAB_DEFS[newValue].path)}
        sx={{ position: 'sticky', bottom: 0 }}
      >
        {TAB_DEFS.map((t) => (
          <BottomNavigationAction key={t.path} label={t.label} icon={t.icon} />
        ))}
      </BottomNavigation>
    </Box>
  );
}
