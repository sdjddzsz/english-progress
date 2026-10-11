/**
 * SyncStatusBanner.tsx —— 离线队列状态横幅（T05 离线补传 UI）：
 * 离线：提示"离线 · N 条待联网补传"；有积压且在线：一键补传 + 恢复自动补传结果提示。
 * 挂在 App 外壳顶部，全站可见。
 */
import { Alert, Button, Collapse } from '@mui/material';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import SyncIcon from '@mui/icons-material/Sync';
import { useOfflineSync } from '../../hooks/useOfflineSync';

export default function SyncStatusBanner() {
  const { online, pending, replaying, lastResult, replayNow } = useOfflineSync();
  const show = !online || pending > 0 || Boolean(lastResult && lastResult.done > 0);

  return (
    <Collapse in={show}>
      {!online ? (
        <Alert icon={<CloudOffIcon fontSize="inherit" />} severity="warning" sx={{ borderRadius: 0 }}>
          当前离线——可以继续学习，写操作会本地排队（{pending} 条待补传），联网后自动补上。
        </Alert>
      ) : (
        <Alert
          icon={<SyncIcon fontSize="inherit" />}
          severity={pending > 0 ? 'info' : 'success'}
          sx={{ borderRadius: 0 }}
          action={
            pending > 0 ? (
              <Button color="inherit" size="small" disabled={replaying} onClick={() => void replayNow()}>
                {replaying ? '补传中…' : '立即补传'}
              </Button>
            ) : undefined
          }
        >
          {pending > 0
            ? `有 ${pending} 条本地变更待同步${lastResult && lastResult.failed > 0 ? `（上次 ${lastResult.failed} 条失败将自动重试）` : ''}。`
            : lastResult && lastResult.done > 0
              ? `已同步 ${lastResult.done} 条本地变更。`
              : '本地数据与云端已同步。'}
        </Alert>
      )}
    </Collapse>
  );
}
