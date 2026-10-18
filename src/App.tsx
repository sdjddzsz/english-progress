import { useEffect } from 'react';
import { Box, BottomNavigation, BottomNavigationAction, Button, CircularProgress, Container, Typography } from '@mui/material';
import TodayIcon from '@mui/icons-material/Today';
import SchoolIcon from '@mui/icons-material/School';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import SettingsIcon from '@mui/icons-material/Settings';
import SearchIcon from '@mui/icons-material/Search';
import EditNoteIcon from '@mui/icons-material/EditNote';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import StagePage from './pages/StagePage';
import StageDetailPage from './pages/StageDetailPage';
import StageQuizPage from './pages/StageQuizPage';
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
import MockExamPage from './pages/MockExamPage';
import QuizPage from './pages/QuizPage';
import LoginPage from './pages/LoginPage';
import SearchPage from './pages/SearchPage';
import BookmarkPage from './pages/BookmarkPage';
import NotesPage from './pages/NotesPage';
import SpellingPage from './pages/SpellingPage';
import SyncStatusBanner from './components/offline/SyncStatusBanner';
import { useAppStore } from './store/useAppStore';

/**
 * 应用外壳（T05 集成完毕）：
 * - 顶层先跑一次 bootstrap（内含 OAuth 落地兑换 → 登录态判断）；
 * - 顶部 SyncStatusBanner：离线排队 / 联网自动补传状态；
 * - /placement 摸底、/mock 模考、/dashboard/diag 诊断报告（白名单路由）；
 * - 云未配置 → 全站引导态（CloudGate）；未登录 → LoginPage。
 */

const TAB_DEFS = [
  { path: '/', icon: <TodayIcon />, label: '阶段' },
  { path: '/training', icon: <SchoolIcon />, label: '训练' },
  { path: '/book', icon: <MenuBookIcon />, label: '词书' },
  { path: '/search', icon: <SearchIcon />, label: '查词' },
  { path: '/notes', icon: <EditNoteIcon />, label: '笔记' },
  { path: '/settings', icon: <SettingsIcon />, label: '设置' },
] as const;

function activeTabIndex(pathname: string): number {
  if (pathname.startsWith('/study') || pathname.startsWith('/stage') || pathname === '/' || pathname.startsWith('/quiz')) return 0;
  if (pathname.startsWith('/training')) return 1;
  if (pathname.startsWith('/book') || pathname.startsWith('/plan-editor')) return 2;
  if (pathname.startsWith('/search')) return 3;
  // 生词本归属「查词」Tab：它是查词/收藏这条线的延续
  if (pathname.startsWith('/bookmarks')) return 3;
  // 笔记独立 Tab（用户 2026-10-17：专门页面查看）
  if (pathname.startsWith('/notes')) return 4;
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/ai-plan') || pathname.startsWith('/mock')) return 5;
  if (pathname.startsWith('/settings')) return 5;
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
        <Button variant="outlined" sx={{ mt: 2 }} onClick={() => void bootstrap({ force: true })}>
          重新检测
        </Button>
      </Container>
    );
  }
  return <>{children}</>;
}

/**
 * 未登录 → 登录页（RLS 之前必须先有真实登录态，否则一切写操作都会被 42501 挡下）。
 *
 * ⚠ 整屏 spinner 只在**首次** bootstrap（bootstrapped=false）期间出现：
 *   路由页面 mount 时也会调 bootstrap()，若此处按 loading 无条件整屏替换 children，
 *   会把刚挂载的路由页连底部导航一起卸载 → 重挂 → 再 bootstrap → 无限卸载/重挂
 *   （表现：从首页切任意 Tab 永久转圈「打不开」，直开 URL 却正常）。
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { cloudReady, needsLogin, loading, bootstrapped } = useAppStore();
  if (!cloudReady) return <>{children}</>;
  if (needsLogin) return <LoginPage />;
  if (loading && !bootstrapped) {
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
              {/* 四阶段制（用户 2026-10-15）：首页=阶段总览。
                  注（2026-10-18）：欠账守卫/重排面板已整体删除——四阶段制「不限每天一轮、
                  无 deadline」与「计划到期旧账」范式冲突，1899 条陈旧欠账对学习无意义。 */}
              <Route path="/" element={<StagePage />} />
              <Route path="/stage/:stage" element={<StageDetailPage />} />
              <Route path="/stage-quiz/:stage" element={<StageQuizPage />} />
              {/* 阶段一「由词选义」考查页（复用原考查主循环） */}
              <Route path="/quiz" element={<QuizPage />} />
              <Route path="/study" element={<StudyPage />} />
              <Route path="/training" element={<TrainingPage />} />
              <Route path="/training/audio" element={<AudioRecallPage />} />
              <Route path="/training/cn2en" element={<CnToEnPage />} />
              <Route path="/training/spelling" element={<SpellingPage />} />
              <Route path="/search" element={<SearchPage />} />
              {/* 笔记页（用户 2026-10-17：题旁笔记按钮 + 专门页面查看） */}
              <Route path="/notes" element={<NotesPage />} />
              <Route path="/bookmarks" element={<BookmarkPage />} />
              <Route path="/book" element={<BookPage />} />
              <Route path="/plan-editor" element={<PlanEditorPage />} />
              {/* 摸底已砍（用户 2026-10-14：「把这狗屁摸底给清除了，功能砍掉」）：
                  判定改为考查制（计时选择题，连续熟练 5 次毕业），见 QuizPage。 */}
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/dashboard/diag" element={<DiagReportView />} />
              <Route path="/mock" element={<MockExamPage />} />
              <Route path="/ai-plan" element={<AiPlanPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </Box>
          {/* 底部导航（用户 2026-10-18）：手机窄屏 6 个 tab 放不下 ⇒ 横向可滑 + 标签/图标自动缩小。
              滚动条隐藏（各浏览器内核都要），滑动用触摸/触控板惯性。 */}
          <BottomNavigation
            value={activeTabIndex(pathname)}
            onChange={(_, newValue: number) => navigate(TAB_DEFS[newValue].path)}
            sx={{
              position: 'sticky',
              bottom: 0,
              overflowX: 'auto',
              overflowY: 'hidden',
              scrollbarWidth: 'none', // Firefox
              '&::-webkit-scrollbar': { display: 'none' }, // Chrome / Edge / Safari
              '& .MuiBottomNavigationAction-root': {
                minWidth: 0,
                flex: '1 0 auto', // 不压缩：放不下就横向滑，绝不挤成半截字
                px: { xs: 0.5, sm: 1.5 },
              },
              '& .MuiBottomNavigationAction-label': {
                fontSize: { xs: '0.62rem', sm: '0.75rem' },
                whiteSpace: 'nowrap',
                '&.Mui-selected': { fontSize: { xs: '0.66rem', sm: '0.75rem' } },
              },
              '& .MuiBottomNavigationAction-root .MuiSvgIcon-root': {
                fontSize: { xs: 20, sm: 24 },
              },
            }}
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
