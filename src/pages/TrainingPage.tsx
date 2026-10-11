/**
 * TrainingPage.tsx —— 训练入口（PRD §4.5 四阶训练体系）：
 * 听词联想 / 见中文联想英文（本批开放）；融会贯通与模考（后续批次）。
 * 目标词 100% 来自当前队列（今日 hit 集合）。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import HearingIcon from '@mui/icons-material/Hearing';
import TranslateIcon from '@mui/icons-material/Translate';
import AllInclusiveIcon from '@mui/icons-material/AllInclusive';
import AssignmentIcon from '@mui/icons-material/Assignment';
import LockIcon from '@mui/icons-material/Lock';
import { getRepos, useAppStore } from '../store/useAppStore';

export default function TrainingPage() {
  const navigate = useNavigate();
  const { userId, todayHits, bootstrap } = useAppStore();
  const [hasMockRule, setHasMockRule] = useState<boolean | null>(null);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const rule = await getRepos().config.getActiveMockRule(userId);
        if (!cancelled) setHasMockRule(Boolean(rule));
      } catch {
        if (!cancelled) setHasMockRule(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const queueCount = [...new Set(todayHits.map((h) => h.wordId))].length;

  const entries = [
    {
      title: '听词联想',
      desc: '听发音回想词义，单选即跳；犹豫超 3 秒自动记"没想起"。',
      icon: <HearingIcon color="primary" />,
      path: '/training/audio',
      enabled: queueCount > 0,
    },
    {
      title: '见中文联想英文',
      desc: '看中文释义回想词形，单选即跳；默认每日 15 词，可关。',
      icon: <TranslateIcon color="primary" />,
      path: '/training/cn2en',
      enabled: queueCount > 0,
    },
    {
      title: '融会贯通',
      desc: '听说读写整合训练素材（后续批次开放）。',
      icon: <AllInclusiveIcon color="disabled" />,
      path: null,
      enabled: false,
    },
  ];

  return (
    <Box p={2} pb={4}>
      <Typography variant="h5">训练</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        当前队列 {queueCount} 词——训练目标词全部来自队列，不做超纲练习。
      </Typography>

      {queueCount === 0 && (
        <Paper variant="outlined" sx={{ mt: 2, p: 2 }}>
          <Typography variant="body2" color="text.secondary">
            今日队列为空——先去 Today 完成当前任务，训练素材会随后解锁。
          </Typography>
        </Paper>
      )}

      <Stack spacing={2} sx={{ mt: 2 }}>
        {entries.map((e) => (
          <Card key={e.title} variant="outlined" sx={{ opacity: e.enabled ? 1 : 0.6 }}>
            <CardActionArea disabled={!e.enabled} onClick={() => e.path && navigate(e.path)}>
              <CardContent>
                <Stack direction="row" spacing={2} alignItems="center">
                  {e.icon}
                  <Box>
                    <Typography variant="h6">{e.title}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {e.desc}
                    </Typography>
                  </Box>
                </Stack>
              </CardContent>
            </CardActionArea>
          </Card>
        ))}

        {/* 模考：锁定态，仅有已批准的解锁规则时提示可用（诊断呈现仅后台） */}
        <Card variant="outlined" sx={{ opacity: hasMockRule ? 1 : 0.6 }}>
          <CardActionArea disabled={!hasMockRule} onClick={() => navigate('/dashboard')}>
            <CardContent>
              <Stack direction="row" spacing={2} alignItems="center">
                <AssignmentIcon color={hasMockRule ? 'primary' : 'disabled'} />
                <Box>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="h6">模考</Typography>
                    {!hasMockRule && <LockIcon fontSize="small" color="disabled" />}
                    {hasMockRule === null && <CircularProgress size={14} />}
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {hasMockRule
                      ? '已有批准的解锁规则，报告在「后台」查看。'
                      : '解锁规则由 AI 依据学习数据制定、你批准后开放；不预设固定分数线。'}
                  </Typography>
                </Box>
              </Stack>
            </CardContent>
          </CardActionArea>
        </Card>
      </Stack>
    </Box>
  );
}
