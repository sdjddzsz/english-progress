/**
 * cmudict-module.d.ts —— `cmu-pronouncing-dictionary` 的类型声明（构建期脚本专用）。
 *
 * 该 npm 包（v3.0.0，ISC，13.4 万词条 + 编号变体）以**具名导出** `dictionary` 提供词库，
 * 并自带 `index.d.ts`。此处显式声明其形状，作为「构建期脚本对 CMUdict 的依赖契约」固化下来：
 *  - 只有具名导出 `dictionary`（**没有 default 导出**；误用 default 会在运行时报错）；
 *  - 键为小写词形（含 `word(1)` / `word(2)` … 编号变体），值为空格分隔的 ARPAbet 音素串。
 *
 * 该文件仅参与类型检查，不产生运行时代码；CMUdict 原文**不进浏览器包**（构建期脚本 `tsx` 专用）。
 */
declare module 'cmu-pronouncing-dictionary' {
  /** 词条（小写，含编号变体）→ 空格分隔的 ARPAbet 音素串（如 `'academy': 'AH0 K AE1 D AH0 M IY0'`） */
  export const dictionary: Record<string, string>;
}
