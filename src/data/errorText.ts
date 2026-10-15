/**
 * errorText.ts —— 云端错误 → 用户可读中文（用户 2026-10-15：界面不许甩英文 PGRST 原句）。
 *
 * PGRST204（schema cache 里找不到列）通常意味着**云端表缺字段**：
 * 前端发出了代码里存在、但表里还没 ALTER 的列。本函数把它翻成
 * 「缺哪个字段 + 影响 + 去哪找升级 SQL」的可执行提示。
 */

/** 从 PGRST204 报文里抽列名：`Could not find the 'quizDayPassed' column of ...` */
const MISSING_COLUMN_RE = /Could not find the ['"]([^'"]+)['"] column/i;

export function describeWriteError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = MISSING_COLUMN_RE.exec(msg);
  if (m) {
    return (
      `云端数据表缺少字段「${m[1]}」：本次进度没有保存成功（已存档本机，联网后会重试）。` +
      `这是数据库缺列，不是网络问题——升级 SQL 见交接文档「云端待执行迁移」。`
    );
  }
  return msg;
}
