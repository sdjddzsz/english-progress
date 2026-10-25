# 英语学习进度系统（english-progress · MRCS v1.0）

> **English** — A personal CET-6 training PWA built on one principle: *the user owns the schedule, not the algorithm*.
> Vite + React 18 + TypeScript + MUI + Dexie, with a WorkBuddy-hosted cloud backend (Postgres / auth / storage / LLM).
> Four-stage vocabulary training over the full ~7,000-word CET-6 list, AI-generated example sentences,
> IPA↔ARPAbet phonetic editing with a DashScope TTS pipeline, 600+ unit tests and 42 e2e tests.
> 中文说明见下方。

一个**进度完全由用户掌控**的六级备考 PWA。产品哲学只有两条：① 所有影响进度的参数对用户开放、可改、改前有影响预览、改后可回滚，杜绝“遗忘曲线黑盒”；② 背单词不是目的，融会贯通才是——单词是输入原料，训练是出口。

**在线体验**：https://english-progress.app.workbuddy.host （PWA，可添加到手机桌面，数据云端同步）

## 功能

- **四阶段训练**：见词识意 → 听词联想 → 中→英联想 → 融会贯通，把词汇变成可使用的技能；
- **全量词书**：六级约 7000 词，按难度分 4 层；掌握度降频规则完全透明（秒认 ≥2 次且无问题标签 → 稳固），且**首轮/末轮必现**，任何词都不会“消失”；
- **计划由用户掌控**：计划参数开放编辑，首页计划卡按四阶段真实学习节奏估算剩余量与预计完成日；
- **今日检测与首页统计**：云端 PostgreSQL 聚合（RPC 函数），三处全表拉取改为服务端算好直拉；
- **AI 例句生成**：按子义项级生成（每条意思独立生成），例句模型跟随问答框临时模型；
- **音标编辑链路**：IPA 与 ARPAbet 逆向映射（1:1 同文件双向），长按音标即可编辑并实时试听；
- **TTS 双轨**：本地 mespeak 合成 + DashScope cosyvoice 云端音轨；
- **笔记与词表**：笔记金黄高亮、词表服务端分页、生词本/查词页；
- **PWA**：离线可用、7 条深链全量验证、Service Worker 指向新包旧 hash 零残留。

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vite + React 18 + TypeScript + MUI（Emotion）+ Tailwind CSS |
| 本地存储 | Dexie（IndexedDB），离线优先 |
| 图表 | Recharts |
| 云端 | WorkBuddy 云托管服务：PostgreSQL 数据库 / 用户认证 / 文件存储 / 免密钥 LLM 调用 |
| AI 能力 | DashScope（cosyvoice-v3-flash 音轨合成 + 例句生成 LLM） |
| 测试 | Vitest 600+ 单测 + Playwright e2e 42 条 |

## 开发

```bash
npm install
npm run dev         # 开发服务器
npm run build       # tsc -b && vite build
npm test            # Vitest 单测
npm run typecheck   # tsc -b
```

## 文档

`docs/` 下是完整的产品与工程档案：PRD（v1.2）、架构设计、架构增量（DashScope 音轨）、联动清单、更新日志、10-13 ~ 10-24 共 6 份交接文档、分期阈值 A/B/C 量化对比分析。

## 迭代史

本仓库即真实开发历史：**95 次提交，2026-10-11 ~ 10-24**，每次提交信息包含需求根因、文件级改动、测试与验证结论（含反证记录）。

## License

[MIT](LICENSE)
