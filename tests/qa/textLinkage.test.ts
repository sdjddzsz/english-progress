/**
 * textLinkage.test.ts —— 文本/名称联动护栏（docs/联动清单.md #12f 名称联动 / #12u 文本联动）。
 *
 * 背景（用户 2026-10-18 晚间定）：轮标线首过术语**统一为「首答即达标」**
 * （首答达到设置页「每轮过关挡位」标准）。旧术语「首答即熟练」是挡位写死时代的遗留——
 * 当天 QuizPage 题旁文案已随挡位化改过，StageQuizPage 同款漏改（设置「适当」时
 * 显示「首答即熟练一遍过」但判定按「认识」放行，正是当天毕业线事故的同款文本偏差）。
 * 本测试把这类漏改变成红灯：
 *
 * 1. 前台源码（pages/components/hooks/features）不许出现旧术语字面；
 * 2. 三处面向用户的文案位点（两考查页题旁 + 设置页规则说明）都必须用统一术语；
 * 3. 两处考查页规则文案必须插值 thresholdLineLabel(quizDayThreshold)——写死挡位词=骗人文本；
 * 4. 毕业线措辞只来自 STAGE_GRADUATE_LABEL（固定「熟练」，不随每轮挡位变）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const SRC = join(ROOT, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** 轮标线首过术语（用户 2026-10-18 统一） */
const UNIFIED_TERM = '首答即达标';
/** 旧术语字面（挡位写死时代遗留，出现即回潮） */
const STALE_TERMS = ['首答即熟练', '首见即达标'];

/** 题旁/规则文案位点：两处考查页 + 设置页挡位说明 */
const TEXT_SITES = ['pages/QuizPage.tsx', 'pages/StageQuizPage.tsx', 'pages/SettingsPage.tsx'];

describe('文本联动：轮标线首过术语统一「首答即达标」', () => {
  it('前台源码无旧术语字面（首答即熟练/首见即达标均为挡位写死时代遗留）', () => {
    const files = [
      ...TEXT_SITES.map((rel) => join(SRC, rel)),
      ...['components', 'hooks', 'features'].flatMap((d) => walk(join(SRC, d))),
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const term of STALE_TERMS) {
        expect(text.includes(term), `${file} 含旧术语「${term}」`).toBe(false);
      }
    }
  });

  it('三处文案位点都使用统一术语「首答即达标」', () => {
    for (const rel of TEXT_SITES) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      expect(text.includes(UNIFIED_TERM), `${rel} 缺统一术语「${UNIFIED_TERM}」`).toBe(true);
    }
  });

  it('两处考查页题旁放行文案用完整统一句式「首答即达标一遍过」', () => {
    for (const rel of ['pages/QuizPage.tsx', 'pages/StageQuizPage.tsx']) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      expect(text.includes('首答即达标一遍过'), `${rel} 题旁文案缺统一句式`).toBe(true);
    }
  });

  it('两处考查页规则文案插值 thresholdLineLabel（挡位名不许写死）', () => {
    for (const rel of ['pages/QuizPage.tsx', 'pages/StageQuizPage.tsx']) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      expect(text.includes('thresholdLineLabel(quizDayThreshold)'), `${rel} 规则文案未插值挡位名`).toBe(true);
    }
  });

  it('两处考查页毕业线措辞来自 STAGE_GRADUATE_LABEL（固定「熟练」）', () => {
    for (const rel of ['pages/QuizPage.tsx', 'pages/StageQuizPage.tsx']) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      expect(text.includes('STAGE_GRADUATE_LABEL'), `${rel} 毕业线未用 STAGE_GRADUATE_LABEL`).toBe(true);
    }
  });
});
