/**
 * toolContext.ts —— AI 工具测试上下文（mock 云数据库注入）。
 */
import type { MockDb } from './mockDb';
import { createWordRepo } from '../../src/data/repos/wordRepo';
import { createPlanRepo } from '../../src/data/repos/planRepo';
import { createHitRepo } from '../../src/data/repos/hitRepo';
import { createFeedbackRepo } from '../../src/data/repos/feedbackRepo';
import { createConfigRepo } from '../../src/data/repos/configRepo';
import { createTrainingRepo } from '../../src/data/repos/trainingRepo';
import type { ToolContext } from '../../src/ai/tools/readTools';

export function createToolContext(db: MockDb, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'u1',
    repos: {
      word: createWordRepo(db),
      plan: createPlanRepo(db),
      hit: createHitRepo(db),
      feedback: createFeedbackRepo(db),
      config: createConfigRepo(db),
      training: createTrainingRepo(db),
    },
    actor: 'ai',
    planId: 'p1',
    ...overrides,
  };
}
