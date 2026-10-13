import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import ErrorBoundary from './components/guards/ErrorBoundary';
import { theme } from './app/theme';
import './styles/global.css';

// PWA Service Worker 注册（autoUpdate）
registerSW({ immediate: true });

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {/* 顶层错误边界：包住 Router + App，任何页面渲染抛错都兜住，不再整页白屏 */}
      <ErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    </ThemeProvider>
  </React.StrictMode>,
);
