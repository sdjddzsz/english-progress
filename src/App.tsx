import { useEffect } from 'react';
import { Box, BottomNavigation, BottomNavigationAction, Button, CircularProgress, Container, Typography } from '@mui/material';
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
import DiagReportView from './pages/DiagReportView';
import AiPlanPage from './pages/AiPlanPage';
import SettingsPage from './pages/SettingsPage';
import PlacementPage from './pages/PlacementPage';
import MockExamPage from './pages/MockExamPage';
import LoginPage from './pages/LoginPage';
import OverdueGuardRoute from './components/guards/OverdueGuardRoute';
import SyncStatusBanner from './components/offline/SyncStatusBanner';
import { useAppStore } from './store/useAppStore';

/**
 * 应用外壳（T05 集成完毕）：
 * - 顶层先跑一次 bootstrap（内含 OAuth 落地兑换 → 登录态判断）；
 * - 顶部 SyncStatusBanner：离线排队 / 联网自动补传状态；
 * - 学习类路由包 OverdueGuardRoute：mustReschedule 时路由级拦截到重排面板；
 * - /placement 摸底、/mock 模考、/dashboard/diag 诊断报告（白名单路由）；
 * - 云未配置 → 全站引导态（CloudGate）；未登录 → LoginPage。
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
  if (pathname.startsWith('/book') || pathname.startsWith('/plan-editor') || pathname.startsWith('/placement')) return 2;
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/ai-plan') || pathname.startsWith('/mock')) return 3;
  if (pathname.startsWith('/settings')) return 4;
  return 0;
}

/** 云未配置 → 全站引导态（英文错误 + 中文说明，不做静默降级） */
function CloudGate({ children }: { children: React.ReactNode }) {
  const { cloudReady, error, bootstrap } = useAppStore();
  if (!cloudReady && error) {
    return (
      <Container maxWidth="sm" sx={{ py: 8 }}>
        <Typography variant="h5" gutterBottom>
          需要先完成云服务配置
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {error}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          中文说明：把云服务控制台返回的 publicConfig（endpoint / publishableKey / oauthRelayBaseUrl）
          填入 .env（参考 .env.example），重新构建后即可进入应用。摸底、计划、学习数据均依赖云数据库与 RLS。
        </Typography>
        <Button variant="outlined" sx={{ mt: 2 }} onClick={() => void bootstrap()}>
          重新检测
        </Button>
      </Container>
    );
  }
  return <>{children}</>;
}

/** 未登录 → 登录页（RLS 之前必须先有真实登录态，否则一切写操作都会被 42501 挡下） */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { cloudReady, needsLogin, loading } = useAppStore();
  if (!cloudReady) return <>{children}</>;
  if (needsLogin) return <LoginPage />;
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }
  return <>{children}</>;
}

export default function App() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const bootstrap = useAppStore((s) => s.bootstrap);

  // 顶层只跑一次：OAuth 落地兑换 → 登录态判断 → 词书/计划装载
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <CloudGate>
      <AuthGate>
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
          <SyncStatusBanner />
          <Box sx={{ flex: 1 }}>
            <Routes>
              <Route path="/" element={<OverdueGuardRoute><TodayPage /></OverdueGuardRoute>} />
              <Route path="/study" element={<OverdueGuardRoute><StudyPage /></OverdueGuardRoute>} />
              <Route path="/training" element={<OverdueGuardRoute><TrainingPage /></OverdueGuardRoute>} />
              <Route path="/training/audio" element={<OverdueGuardRoute><AudioRecallPage /></OverdueGuardRoute>} />
              <Route path="/training/cn2en" element={<OverdueGuardRoute><CnToEnPage /></OverdueGuardRoute>} />
              <Route path="/book" element={<BookPage />} />
              <Route path="/plan-editor" element={<PlanEditorPage />} />
              <Route path="/placement" element={<PlacementPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/dashboard/diag" element={<DiagReportView />} />
              <Route path="/mock" element={<MockExamPage />} />
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
      </AuthGate>
    </CloudGate>
  );
}
