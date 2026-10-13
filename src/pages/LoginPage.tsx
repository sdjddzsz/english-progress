/**
 * LoginPage.tsx —— WorkBuddy 统一登录（PKCE OAuth）。
 *
 * 为什么必须有它：所有 owner-only 表都开了 RLS，未登录时 SDK 以 anon role
 * 发请求，任何 INSERT/UPDATE 都会被挡下（42501）。此前 bootstrap 在未登录时
 * 用一个伪造的本地假身份继续跑，页面照常渲染、直到点「初始化词库」才炸——
 * 已改为未登录直接停在这里。
 */
import { useState } from 'react';
import { Alert, Box, Button, Container, Paper, Typography } from '@mui/material';
import { startWorkBuddySignIn } from '../data/cloud';

export default function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const handleSignIn = async () => {
    setBusy(true);
    setErr('');
    try {
      const url = await startWorkBuddySignIn();
      // 整页跳转（PKCE verifier 存在 sessionStorage，必须同一标签页回来）
      window.location.assign(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Container maxWidth="sm" sx={{ py: 8 }}>
      <Paper sx={{ p: 3 }}>
        <Typography variant="h5" gutterBottom>
          登录后开始
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          学习数据、词库、计划都存在你自己的云空间里（行级安全策略按账号隔离），
          所以需要先登录。用 WorkBuddy 账号即可，无需另外注册。
        </Typography>
        {err && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {err}
          </Alert>
        )}
        <Box>
          <Button variant="contained" disabled={busy} onClick={() => void handleSignIn()}>
            {busy ? '正在跳转…' : '使用 WorkBuddy 账号登录'}
          </Button>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
          授权完成后会回到本站；如果跳转后仍停在这一页，请在同一浏览器标签页内重试一次。
        </Typography>
      </Paper>
    </Container>
  );
}
