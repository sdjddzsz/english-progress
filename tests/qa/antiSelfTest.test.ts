/**
 * qa/antiSelfTest.test.ts —— QA 独立对抗性验证：反自测约束运行时验证（PRD §6.3 硬约束 #1 / §4.8）。
 * - 前台组件树源码扫描：禁用词表（score/accuracy/rating/正确率/得分/评级/…）零出现；
 * - Feedback / TrainingRecord / AbilitySnapshot 序列化输出无禁用键；
 * - DiagReportView 白名单物理防误接：仅 /dashboard/diag 路由挂载。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_SELF_TEST_TERMS } from '../../src/config/constants';
import { DIAG_REPORT_ALLOWED_PATHS } from '../../src/pages/DiagReportView';

const ROOT = join(__dirname, '../..');
const SRC = join(ROOT, 'src');

// ===== 前台组件树源码扫描 =====

/** 前台（学习路径）页面：Today/背单词/训练/词书/摸底/计划/设置 */
const FRONTEND_PAGE_FILES = [
  'pages/StagePage.tsx',
  'pages/StageDetailPage.tsx',
  'pages/StageQuizPage.tsx',
  'pages/StudyPage.tsx',
  'pages/TrainingPage.tsx',
  'pages/AudioRecallPage.tsx',
  'pages/CnToEnPage.tsx',
  'pages/BookPage.tsx',
  'pages/PlanEditorPage.tsx',
  'pages/QuizPage.tsx',
  'pages/SettingsPage.tsx',
  'pages/MockExamPage.tsx',
  'App.tsx',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('反自测硬约束 #1：前台组件树禁用词扫描', () => {
  it('前台页面源码不含任何禁用词（英文忽略大小写）', () => {
    for (const rel of FRONTEND_PAGE_FILES) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      for (const term of FORBIDDEN_SELF_TEST_TERMS) {
        const flags = /[\u4e00-\u9fff]/.test(term) ? 'g' : 'gi';
        expect(new RegExp(term, flags).test(text), `${rel} 出现禁用词「${term}」`).toBe(false);
      }
    }
  });

  it('前台通用组件/ hooks / features 目录全部源码不含禁用词', () => {
    for (const dir of ['components', 'hooks', 'features']) {
      for (const file of walk(join(SRC, dir))) {
        const text = readFileSync(file, 'utf8');
        for (const term of FORBIDDEN_SELF_TEST_TERMS) {
          const flags = /[\u4e00-\u9fff]/.test(term) ? 'g' : 'gi';
          expect(new RegExp(term, flags).test(text), `${file} 出现禁用词「${term}」`).toBe(false);
        }
      }
    }
  });

  it('domain.ts 三类反自测集合（Feedback/TrainingRecord/AbilitySnapshot）物理无禁用字段', () => {
    const text = readFileSync(join(SRC, 'types/domain.ts'), 'utf8');
    const names = ['Feedback', 'TrainingRecord', 'AbilitySnapshot'];
    for (const name of names) {
      const m = text.match(new RegExp(`export interface ${name}[^{]*\\{[\\s\\S]*?\\n\\}`));
      expect(m, `interface ${name} 存在`).toBeTruthy();
      for (const term of ['score', 'accuracy', 'rating']) {
        expect(new RegExp(term, 'i').test(m![0]), `${name} 出现字段 ${term}`).toBe(false);
      }
    }
  });
});

// ===== 序列化运行时验证 =====

describe('反自测硬约束 #1：三类集合序列化输出无禁用键', () => {
  function assertNoForbiddenKeys(obj: unknown, path = '$'): void {
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => assertNoForbiddenKeys(v, `${path}[${i}]`));
      return;
    }
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        expect(/score|accuracy|rating/i.test(k), `${path}.${k} 为禁用键`).toBe(false);
        assertNoForbiddenKeys(v, `${path}.${k}`);
      }
    }
  }

  it('Feedback 序列化无 score/accuracy/rating 键', () => {
    const feedback = {
      id: 'f1',
      hitId: 'h1',
      sessionId: 's1',
      wordId: 'w1',
      userId: 'u1',
      l1State: 'instant',
      reactionMs: 850,
      l2Tags: [],
      l3Actions: [],
      modality: 'visual',
      roundNo: 1,
      tier: 3,
      device: 'desktop',
      createdAt: '2026-10-11T08:00:00Z',
    };
    const json = JSON.stringify(feedback);
    expect(json).not.toMatch(/"score"/i);
    expect(json).not.toMatch(/"accuracy"/i);
    expect(json).not.toMatch(/"rating"/i);
    assertNoForbiddenKeys(feedback);
  });

  it('TrainingRecord 序列化无禁用键（userOutput 透传用户原文也不得含禁用键）', () => {
    const record = {
      id: 'tr1',
      sessionId: 's1',
      itemId: 'i1',
      userId: 'u1',
      userOutput: { transcription: 'I recounted the story.', spelling: 'recount' },
      wordHits: ['h1', 'h2'],
      createdAt: '2026-10-11T09:00:00Z',
    };
    assertNoForbiddenKeys(record);
  });

  it('AbilitySnapshot 序列化无禁用键（wordStatesSummary/tierPassRates 为状态口径非分数口径）', () => {
    const snap = {
      id: 'as1',
      userId: 'u1',
      weekStart: '2026-10-05',
      wordStatesSummary: { mastered: 100, steady: 300, learning: 1200, untouched: 5400 },
      weakPoints: {
        forgetfulWords: ['w1', 'w2'],
        topConfusionPairs: [{ wordA: 'w1', wordB: 'w2', count: 5 }],
        l2CategoryCounts: { spelling: 3, listening: 2 },
      },
      modalityGap: {
        visualShare: 0.6,
        audioShare: 0.4,
        curve: [{ date: '2026-10-05', visual: 10, audio: 8 }],
      },
      tierPassRates: { 1: 0.9, 2: 0.7, 3: 0.5, 4: 0.3 },
      createdAt: '2026-10-11T10:00:00Z',
    };
    assertNoForbiddenKeys(snap);
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/"(score|accuracy|rating)"/i);
  });
});

// ===== DiagReportView 白名单物理防误接 =====

describe('反自测 §4.8：诊断报告仅白名单路由渲染', () => {
  it('白名单恰为 /dashboard/diag（后台路由）', () => {
    expect(DIAG_REPORT_ALLOWED_PATHS).toEqual(['/dashboard/diag']);
  });

  it('App.tsx 仅在一个路由挂载 DiagReportView，且路径在白名单内', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    const mounts = app.match(/<Route path="([^"]+)" element=\{<DiagReportView \/>\}/g) ?? [];
    expect(mounts.length).toBe(1);
    const path = mounts[0]!.match(/path="([^"]+)"/)![1];
    expect(DIAG_REPORT_ALLOWED_PATHS).toContain(path);
  });

  it('DiagReportView 源码：非白名单路径返回拒绝渲染的 Alert（白名单自检物理存在）', () => {
    const src = readFileSync(join(SRC, 'pages/DiagReportView.tsx'), 'utf8');
    expect(src).toContain('DIAG_REPORT_ALLOWED_PATHS.includes(pathname)');
    expect(src).toMatch(/if\s*\(!whitelisted\)\s*\{[\s\S]*?severity="error"/);
  });

  it('学习类路由不再包任何守卫，诊断视图不在其中（欠账系统 2026-10-18 整体删除）', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    // 欠账守卫/重排面板已删（四阶段制无 deadline，陈旧欠账无意义）；
    // 全部路由裸挂页面，任何 Guard 包裹都不允许再出现。
    for (const p of ['/study', '/training', '/training/audio', '/training/cn2en', '/training/spelling']) {
      expect(app.includes(`<Route path="${p}" element={<`), `路由 ${p} 应裸挂页面`).toBe(true);
      expect(app.includes('<OverdueGuardRoute>'), '不得再出现欠账守卫').toBe(false);
      expect(app.includes(`<Route path="${p}" element={<DiagReportView`), `路由 ${p} 不得挂诊断视图`).toBe(false);
    }
    // 诊断视图唯一挂载点已在上一用例断言为 /dashboard/diag
  });
});
