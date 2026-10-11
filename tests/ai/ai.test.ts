/**
 * ai.test.ts —— AI 层验收（批 2 要求）：
 * - catalog：读/写工具清单与三级风险标注（含四个指定工具）；
 * - 三级授权路由：Auto 直落 / Confirm 提案 / Require 永不自动执行；
 * - 无 reason 提案拒绝（硬约束 #6）；
 * - PlanVersion 快照与回滚；
 * - llmClient：OpenAI 兼容通道 SSE 解析 + system 首条强约束。
 */
import 'fake-indexeddb/auto'; // reschedule 链路 hitRepo→localDb(Dexie) 需要 IndexedDB API
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDb } from '../helpers/mockDb';
import { TOOL_CATALOG, getToolSpec } from '../../src/ai/tools/catalog';
import { createToolContext } from '../helpers/toolContext';
import { executeTool, decideProposal } from '../../src/ai/authz';
import { ProposalValidationError } from '../../src/ai/proposal';
import { rollbackToVersion, snapshotPlan } from '../../src/ai/planVersion';
import { chatTurn, type ChatMessage } from '../../src/ai/llmClient';
import type { AIProposal, ToolCallLog, StudyPlan } from '../../src/types/domain';

function planFixture(): StudyPlan {
  return {
    id: 'p1',
    bookId: 'b1',
    userId: 'u1',
    tierRounds: { 1: 2, 2: 2, 3: 3, 4: 3 },
    planMode: 'recommended',
    startDate: '2026-10-11',
    deadlineDate: '2026-12-05',
    sprintStartDate: '2026-12-05',
    dailyBudgetMin: 60,
    avgHitSec: 12,
    gapMinDays: 0,
    modalRatio: { 1: 0.7, 2: 0.5, 3: 0.3, 4: 0.2 },
    masteryDecayEnabled: true,
    version: 1,
    status: 'active',
    createdAt: '2026-10-11T00:00:00Z',
  };
}

describe('工具清单 catalog（PRD §7.1）', () => {
  it('读 10 + 写 15，全部有参数 schema 与风险级', () => {
    const reads = TOOL_CATALOG.filter((t) => t.category === 'read');
    const writes = TOOL_CATALOG.filter((t) => t.category === 'write');
    expect(reads.length).toBe(10);
    expect(writes.length).toBe(15);
    for (const t of TOOL_CATALOG) {
      expect(t.parameters.type).toBe('object');
      expect(['auto', 'confirm', 'require']).toContain(t.riskLevel);
      expect(t.description.length).toBeGreaterThan(4);
    }
  });

  it('指定关键工具齐备且风险级正确', () => {
    expect(getToolSpec('recompute_word_tiers')?.riskLevel).toBe('confirm');
    expect(getToolSpec('update_mock_unlock_rule')?.riskLevel).toBe('confirm');
    expect(getToolSpec('generate_sprint_pack')?.riskLevel).toBe('confirm');
    expect(getToolSpec('switch_plan_mode')?.riskLevel).toBe('require');
    expect(getToolSpec('get_tts_provider_status')?.category).toBe('read');
    expect(getToolSpec('reschedule')?.riskLevel).toBe('require');
    expect(getToolSpec('create_training_material')?.riskLevel).toBe('auto');
  });
});

describe('提案（硬约束 #6：必附 reason 与 diff）', () => {
  it('validateProposal：缺 reason / 缺 changes 均抛错', async () => {
    const { validateProposal } = await import('../../src/ai/proposal');
    expect(() => validateProposal({ reason: '', changes: { a: 1 } })).toThrow(ProposalValidationError);
    expect(() => validateProposal({ reason: '  ', changes: { a: 1 } })).toThrow(ProposalValidationError);
    expect(() => validateProposal({ reason: '因为欠账', changes: {} })).toThrow(ProposalValidationError);
    expect(() => validateProposal({ reason: '因为欠账', changes: { strategy: 'compress' } })).not.toThrow();
  });
});

describe('三级授权执行器', () => {
  let db: MockDb;
  let ctx: ReturnType<typeof createToolContext>;

  beforeEach(async () => {
    db = new MockDb();
    ctx = createToolContext(db);
    ctx.repos.plan.plans.insert(planFixture()).catch(() => undefined);
    // get_tts_provider_status 依赖 tts_provider_configs 表：先落默认配置（硬约束 #7 默认值）
    await ctx.repos.config.initDefaultTTSConfig('u1');
  });

  it('Auto：读工具直落 + ToolCallLog applied=true', async () => {
    const decision = await executeTool({ ctx }, { toolName: 'get_tts_provider_status', input: {} });
    expect(decision.kind).toBe('auto');
    if (decision.kind === 'auto') {
      expect((decision.result as { status: string }).status).toBe('pending_user_setup'); // 硬约束 #7 默认值
    }
    const logs = (db.tables.get('tool_call_logs') ?? []) as unknown as ToolCallLog[];
    expect(logs.length).toBe(1);
    expect(logs[0].applied).toBe(true);
  });

  it('Auto：低风险写工具（create_training_material）直落', async () => {
    const decision = await executeTool({ ctx }, {
      toolName: 'create_training_material',
      input: { type: 'listen_recall', targetWords: ['w1', 'w2'], content: {} },
    });
    expect(decision.kind).toBe('auto');
    expect((db.tables.get('training_items') ?? []).length).toBe(1);
  });

  it('Confirm：无 reason → 拒绝落地；有 reason → 提案待确认，未执行', async () => {
    const noReason = await executeTool({ ctx }, {
      toolName: 'update_mock_unlock_rule',
      input: { ruleJson: { overdueZeroDays: 14 } },
    });
    expect(noReason).toMatchObject({ kind: 'rejected' });
    expect((db.tables.get('mock_unlock_rules') ?? []).length).toBe(0); // 未执行

    const withReason = await executeTool({ ctx }, {
      toolName: 'update_mock_unlock_rule',
      input: { ruleJson: { overdueZeroDays: 14 } },
      reason: '欠账连续归零，听觉识别率提升',
    });
    expect(withReason).toMatchObject({ kind: 'confirm' });
    expect((db.tables.get('mock_unlock_rules') ?? []).length).toBe(0); // 仍未执行，等确认
    const proposals = (db.tables.get('ai_proposals') ?? []) as unknown as AIProposal[];
    expect(proposals.length).toBe(1);
    expect(proposals[0].reason).toContain('听觉识别率');

    // 用户确认 → 落地 + applied=true + status=applied
    const approved = await decideProposal({ ctx }, (withReason as { proposalId: string }).proposalId, true);
    expect(approved.kind).toBe('auto');
    expect((db.tables.get('mock_unlock_rules') ?? []).length).toBe(1);
    const after = (db.tables.get('ai_proposals') ?? []) as unknown as AIProposal[];
    expect(after[0].status).toBe('applied');
  });

  it('Require（reschedule）：即使配置了自动执行意图也永不自动执行，确认后才落地', async () => {
    // 制造欠账：3 条昨日 pending hit
    const hitRepo = ctx.repos.hit;
    await hitRepo.upsertHits([
      { id: 'h1', planId: 'p1', wordId: 'w1', userId: 'u1', tier: 3, roundNo: 1, listNo: 0, scheduledDate: '2026-10-11', modality: 'visual', status: 'pending', explain: { roundIdxInWindow: 0 } },
      { id: 'h2', planId: 'p1', wordId: 'w2', userId: 'u1', tier: 3, roundNo: 1, listNo: 0, scheduledDate: '2026-10-11', modality: 'audio', status: 'pending', explain: { roundIdxInWindow: 0 } },
      { id: 'h3', planId: 'p1', wordId: 'w3', userId: 'u1', tier: 3, roundNo: 1, listNo: 0, scheduledDate: '2026-10-11', modality: 'visual', status: 'pending', explain: { roundIdxInWindow: 0 } },
    ]);
    const decision = await executeTool({ ctx }, {
      toolName: 'reschedule',
      input: { strategy: 'compress', today: '2026-11-10' },
      reason: '欠账 3 条，压缩进未来窗口',
    });
    expect(decision.kind).toBe('require'); // require 级提案
    // 永不自动执行：hit 原状
    const h1 = await hitRepo.getHit('h1');
    expect(h1?.scheduledDate).toBe('2026-10-11');

    const approved = await decideProposal({ ctx }, (decision as { proposalId: string }).proposalId, true);
    expect(approved.kind).toBe('auto');
    const h1After = await hitRepo.getHit('h1');
    expect(h1After?.scheduledDate).not.toBe('2026-10-11'); // 已重排
    expect(h1After?.status).toBe('pending');
  });

  it('Require 级驳回：状态 rejected、不执行、日志记录', async () => {
    const decision = await executeTool({ ctx }, {
      toolName: 'switch_plan_mode',
      input: { planId: 'p1', planMode: 'fallback' },
      reason: '时间不够，切保底档',
    });
    expect(decision.kind).toBe('require');
    const rejected = await decideProposal({ ctx }, (decision as { proposalId: string }).proposalId, false);
    expect(rejected.kind).toBe('rejected');
    const plan = await ctx.repos.plan.getPlan('p1');
    expect(plan?.planMode).toBe('recommended'); // 未执行
  });

  it('动态风险：recompute ≤10% 自动落地，>10% 需确认', async () => {
    // 10 词词书，重分 1 词（10%）→ auto
    await ctx.repos.word.createBook({ id: 'b1', userId: 'u1', name: '六级全量', source: 'builtin', wordCount: 10, tierCount: 4, listSize: 50, status: 'active', createdAt: '2026-10-11T00:00:00Z' });
    const bws = [];
    for (let i = 0; i < 10; i++) {
      bws.push({ id: `bw${i}`, bookId: 'b1', wordId: `w${i}`, listNo: 1, orderInList: i + 1, tier: 3 as const, tierUpdatedAt: '', status: 'normal' as const });
    }
    await ctx.repos.word.upsertBookWords(bws as never);
    const auto = await executeTool({ ctx }, {
      toolName: 'recompute_word_tiers',
      input: { bookId: 'b1', assignments: [{ bookWordId: 'bw0', tier: 2 }] },
    });
    expect(auto.kind).toBe('auto');
    expect((await ctx.repos.word.bookWords.getById('bw0'))?.tier).toBe(2);

    // 重分 3 词（30%）→ confirm 提案
    const confirm = await executeTool({ ctx }, {
      toolName: 'recompute_word_tiers',
      input: { bookId: 'b1', assignments: [{ bookWordId: 'bw1', tier: 2 }, { bookWordId: 'bw2', tier: 2 }, { bookWordId: 'bw3', tier: 2 }] },
      reason: '摸底校准批量升级',
    });
    expect(confirm.kind).toBe('confirm');
  });
});

describe('PlanVersion 快照与回滚', () => {
  it('连续快照 version_no 递增；回滚恢复参数并记录新版本', async () => {
    const db = new MockDb();
    const ctx = createToolContext(db);
    const plan = await ctx.repos.plan.plans.insert(planFixture());

    const v1 = await snapshotPlan(ctx.repos.plan, plan, 'user', '初始创建', 'create');
    const updated = await ctx.repos.plan.updatePlan(plan.id, { dailyBudgetMin: 70 });
    const v2 = await snapshotPlan(ctx.repos.plan, updated!, 'user', '上调预算', '60→70');
    expect(v1.versionNo).toBe(1);
    expect(v2.versionNo).toBe(2);

    const rolled = await rollbackToVersion({ plans: ctx.repos.plan.plans, versions: ctx.repos.plan.versions }, plan.id, 1);
    expect(rolled.plan.dailyBudgetMin).toBe(60); // 恢复
    expect(rolled.newVersion.versionNo).toBe(3); // 回滚本身也记版本
    expect(rolled.newVersion.reason).toContain('rollback');
    const versions = await ctx.repos.plan.listPlanVersions(plan.id);
    expect(versions.length).toBe(3);
  });
});

describe('llmClient（OpenAI 兼容通道，mock SSE）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('system 首条强约束：非 system 开头 → 抛错', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await expect(chatTurn(messages, { model: 'm', channel: 'openai_compatible', baseUrl: 'https://x/v1' })).rejects.toThrow(/system/);
  });

  it('SSE 解析：content 累积 + tool_calls 按 index 拼装', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
      'data: {"choices":[{"delta":{"content":"分析欠账"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"reschedule","arguments":"{\\"strategy\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"compress\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ].join('\n') + '\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { status: 200 })));

    const result = await chatTurn(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: '生成本周方案' }],
      { model: 'm', channel: 'openai_compatible', baseUrl: 'https://x/v1' },
    );
    expect(result.content).toBe('分析欠账');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]).toMatchObject({ id: 't1', name: 'reschedule', arguments: '{"strategy":"compress"}' });
  });
});
