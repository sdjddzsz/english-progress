/**
 * qa/aiAuthzAdversarial.test.ts —— QA 独立对抗性验证：AI 授权三级防线（PRD §7.2 / §7.6，硬约束 #6）。
 * 对抗目标：构造恶意/越权提案，验证 Require 级没有任何跳过确认直接落地的代码路径。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MockDb } from '../helpers/mockDb';
import { createToolContext } from '../helpers/toolContext';
import { executeTool, decideProposal, effectiveRiskLevel } from '../../src/ai/authz';
import { ProposalValidationError, validateProposal } from '../../src/ai/proposal';
import { TOOL_CATALOG, getToolSpec } from '../../src/ai/tools/catalog';
import type { AIProposal, StudyPlan, ToolCallLog } from '../../src/types/domain';

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

describe('对抗：reason 缺失 / 空白 / 超长（硬约束 #6）', () => {
  let db: MockDb;
  let ctx: ReturnType<typeof createToolContext>;

  beforeEach(async () => {
    db = new MockDb();
    ctx = createToolContext(db);
    await db.from('study_plans').insert({ ...planFixture() });
  });

  const CASES: [string, string | undefined][] = [
    ['空串', ''],
    ['纯空白（空格）', '   '],
    ['纯空白（制表/换行）', ' \t\n\r '],
  ];

  for (const [label, reason] of CASES) {
    it(`Confirm 级（batch_defer_words）reason=${label} → 拒绝且不产生提案`, async () => {
      const d = await executeTool({ ctx }, { toolName: 'batch_defer_words', input: { hitIds: ['h1'] }, reason });
      expect(d.kind).toBe('rejected');
      if (d.kind === 'rejected') expect(d.reason).toContain('reason is required');
      const proposals = (await db.from('ai_proposals').select()) as unknown as { data: AIProposal[] };
      expect(proposals.data.length).toBe(0);
    });

    it(`Require 级（switch_plan_mode）reason=${label} → 拒绝且计划无任何变化`, async () => {
      const d = await executeTool({ ctx }, { toolName: 'switch_plan_mode', input: { planMode: 'fallback' }, reason });
      expect(d.kind).toBe('rejected');
      const plans = (await db.from('study_plans').select()) as unknown as { data: StudyPlan[] };
      expect(plans.data[0].planMode).toBe('recommended');
      expect(plans.data[0].tierRounds).toEqual({ 1: 2, 2: 2, 3: 3, 4: 3 });
    });
  }

  it('undefined reason → 拒绝', async () => {
    const d = await executeTool({ ctx }, { toolName: 'update_plan_params', input: { patch: { dailyBudgetMin: 90 } } });
    expect(d.kind).toBe('rejected');
  });

  it('超长 reason（100KB）：不被静默执行——仍走提案通道（Require 级不落地）', async () => {
    const d = await executeTool({ ctx }, {
      toolName: 'switch_plan_mode',
      input: { planMode: 'fallback' },
      reason: 'r'.repeat(100_000),
    });
    expect(d.kind).toBe('require'); // 只创建提案，不直接落地
    const plans = (await db.from('study_plans').select()) as unknown as { data: StudyPlan[] };
    expect(plans.data[0].planMode).toBe('recommended'); // 数据未变
  });

  it('validateProposal：缺 reason / 空白 reason / 缺 changes / 空 changes 全部拒绝', () => {
    expect(() => validateProposal({ reason: '', changes: { a: 1 } })).toThrow(ProposalValidationError);
    expect(() => validateProposal({ reason: ' \n', changes: { a: 1 } })).toThrow(ProposalValidationError);
    expect(() => validateProposal({ reason: 'ok' })).toThrow(ProposalValidationError);
    expect(() => validateProposal({ reason: 'ok', changes: {} })).toThrow(ProposalValidationError);
    expect(() => validateProposal({ reason: 'ok', changes: { x: 1 } })).not.toThrow();
  });
});

describe('对抗：Require 级穷举——不存在跳过确认直接落地的路径', () => {
  let db: MockDb;
  let ctx: ReturnType<typeof createToolContext>;

  beforeEach(async () => {
    db = new MockDb();
    ctx = createToolContext(db);
    await db.from('study_plans').insert({ ...planFixture() });
  });

  const REQUIRE_TOOLS = TOOL_CATALOG.filter((t) => t.riskLevel === 'require');
  const REQUIRE_INPUTS: Record<string, Record<string, unknown>> = {
    update_plan_params: { patch: { dailyBudgetMin: 120 } },
    reschedule: { strategy: 'compress' },
    switch_plan_mode: { planMode: 'fallback' },
  };

  it('目录中 Require 级工具恰为 3 个且都有穷举输入', () => {
    expect(REQUIRE_TOOLS.map((t) => t.name).sort()).toEqual(
      ['reschedule', 'switch_plan_mode', 'update_plan_params'],
    );
  });

  it('每个 Require 工具：合法 reason 也只产提案、kind=require、数据零变化、日志 applied=false', async () => {
    for (const spec of REQUIRE_TOOLS) {
      const d = await executeTool({ ctx }, { toolName: spec.name, input: REQUIRE_INPUTS[spec.name], reason: `用户确认必要性说明-${spec.name}` });
      expect(d.kind, spec.name).toBe('require');
      const plans = (await db.from('study_plans').select()) as unknown as { data: StudyPlan[] };
      expect(plans.data[0].dailyBudgetMin, spec.name).toBe(60);
      expect(plans.data[0].planMode, spec.name).toBe('recommended');
      const logs = (await db.from('tool_call_logs').select()) as unknown as { data: ToolCallLog[] };
      const entry = logs.data.find((l) => l.toolName === spec.name);
      expect(entry?.applied, spec.name).toBe(false);
      expect(entry?.proposalId, spec.name).toBeTruthy();
    }
  });

  it('动态风险升级不能把 Require 降级（update_plan_params/reschedule/switch_plan_mode 任意输入恒 require）', async () => {
    for (const name of ['update_plan_params', 'reschedule', 'switch_plan_mode']) {
      const spec = getToolSpec(name)!;
      const risk = await effectiveRiskLevel({ ctx }, name, spec.riskLevel, { hitIds: Array(999), assignments: Array(999) });
      expect(risk, name).toBe('require');
    }
  });

  it('actor 伪装成 user 不能绕过风险分级（仍走提案）', async () => {
    const d = await executeTool({ ctx }, {
      toolName: 'switch_plan_mode',
      input: { planMode: 'fallback' },
      reason: '伪装 user',
      actor: 'user',
    });
    expect(d.kind).toBe('require');
  });

  it('提案只有 decideProposal(approve=true) 一条落地通道；被驳回后数据确实无变化', async () => {
    // 预置 10 条活跃 hit（2/10=20% 不触发 >20% 动态升级，保持 Confirm 基线）
    for (let i = 0; i < 10; i++) {
      await db.from('hits').insert({ id: `h${i}`, planId: 'p1', wordId: `w${i}`, status: 'pending', scheduledDate: '2026-10-10' });
    }
    const d = await executeTool({ ctx }, { toolName: 'batch_defer_words', input: { hitIds: ['h1', 'h2'] }, reason: '用户旅行一周' });
    expect(d.kind).toBe('confirm');
    if (d.kind !== 'confirm') return;
    // 驳回
    const r = await decideProposal({ ctx }, d.proposalId, false);
    expect(r.kind).toBe('rejected');
    const rows = (await db.from('hits').select()) as unknown as { data: { id: string; status: string }[] };
    expect(rows.data.find((x) => x.id === 'h1')?.status).toBe('pending');
    expect(rows.data.find((x) => x.id === 'h2')?.status).toBe('pending');
    // 驳回后不可二次决定（防重放）
    const again = await decideProposal({ ctx }, d.proposalId, true);
    expect(again.kind).toBe('rejected');
    expect(rows.data.find((x) => x.id === 'h1')?.status).toBe('pending');
    // 批准后才落地
    const d2 = await executeTool({ ctx }, { toolName: 'batch_defer_words', input: { hitIds: ['h1'] }, reason: '再次提案' });
    expect(d2.kind).toBe('confirm');
    if (d2.kind === 'confirm') {
      const ok = await decideProposal({ ctx }, d2.proposalId, true);
      expect(ok.kind).toBe('auto');
      const rows2 = (await db.from('hits').select()) as unknown as { data: { id: string; status: string }[] };
      expect(rows2.data.find((x) => x.id === 'h1')?.status).toBe('deferred');
      expect(rows2.data.find((x) => x.id === 'h2')?.status).toBe('pending');
    }
  });

  it('未知工具名（含大小写欺骗 Reschedule / 注入名）→ 拒绝且无提案', async () => {
    for (const name of ['Reschedule', 'RESCHEDULE', 'reschedule; DROP TABLE', '__proto__', '']) {
      const d = await executeTool({ ctx }, { toolName: name, input: {}, reason: 'x' });
      expect(d.kind, name).toBe('rejected');
    }
    const proposals = (await db.from('ai_proposals').select()) as unknown as { data: AIProposal[] };
    expect(proposals.data.length).toBe(0);
  });

  it('提案不存在 / 非 pending 状态时 decideProposal 拒绝', async () => {
    expect((await decideProposal({ ctx }, 'no-such-id', true)).kind).toBe('rejected');
  });
});

describe('对抗：动态风险阈值（PRD §7.1）', () => {
  let db: MockDb;
  let ctx: ReturnType<typeof createToolContext>;

  beforeEach(async () => {
    db = new MockDb();
    ctx = createToolContext(db);
    await db.from('study_plans').insert({ ...planFixture() });
  });

  it('batch_defer_words：>20% 升级 Require', async () => {
    // 预置 100 条活跃 hit
    for (let i = 0; i < 100; i++) {
      await db.from('hits').insert({
        id: `h${i}`,
        planId: 'p1',
        wordId: `w${i}`,
        status: i < 30 ? 'overdue' : 'pending',
        scheduledDate: '2026-10-10',
      });
    }
    const d21 = await executeTool({ ctx }, { toolName: 'batch_defer_words', input: { hitIds: Array.from({ length: 21 }, (_, i) => `h${i}`) }, reason: '批量' });
    expect(d21.kind).toBe('require');
    const d20 = await executeTool({ ctx }, { toolName: 'batch_defer_words', input: { hitIds: Array.from({ length: 20 }, (_, i) => `h${i}`) }, reason: '批量' });
    expect(d20.kind).toBe('confirm');
  });

  it('recompute_word_tiers：>10% 升级 Confirm，≤10% Auto 直落', async () => {
    for (let i = 0; i < 100; i++) {
      await db.from('book_words').insert({ id: `bw${i}`, bookId: 'b1', wordId: `w${i}`, tier: 3 });
    }
    const d11 = await executeTool({ ctx }, { toolName: 'recompute_word_tiers', input: { bookId: 'b1', assignments: Array.from({ length: 11 }, (_, i) => ({ bookWordId: `bw${i}`, tier: 2 })) }, reason: '摸底校准重分层' });
    expect(d11.kind).toBe('confirm');
    const d10 = await executeTool({ ctx }, { toolName: 'recompute_word_tiers', input: { bookId: 'b1', assignments: Array.from({ length: 10 }, (_, i) => ({ bookWordId: `bw${i + 50}`, tier: 2 })) } });
    expect(d10.kind).toBe('auto');
  });
});
