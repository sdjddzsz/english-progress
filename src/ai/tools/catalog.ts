/**
 * catalog.ts —— AI 工具机器可读清单（PRD §7.1 全量 + §7.2 三级风险标注）。
 * 直接序列化进 LLM 的 tool-calling 请求；执行器按 riskLevel 分发（authz.ts）。
 */
import type { RiskLevel } from '../../types/domain';

export type ToolCategory = 'read' | 'write';

export interface ToolSpec {
  name: string;
  category: ToolCategory;
  riskLevel: RiskLevel;
  description: string;
  /** JSON Schema（简化形） */
  parameters: Record<string, unknown>;
}

function objProps(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties: props, required };
}
const str = { type: 'string' };
const num = { type: 'number' };
const arr = { type: 'array', items: str };

// ===== 读类（10 个，PRD §7.1；全部 Auto 直落）=====

export const READ_TOOLS: ToolSpec[] = [
  { name: 'get_study_records', category: 'read', riskLevel: 'auto', description: '查询学习记录（hits，含模态/轮次/日期）', parameters: objProps({ planId: str, fromDate: str, toDate: str }) },
  { name: 'get_feedback_stats', category: 'read', riskLevel: 'auto', description: '统计反馈标签分布（L1/L2/模态，含反应时长）', parameters: objProps({ fromIso: str, toIso: str }) },
  { name: 'get_overdue_stats', category: 'read', riskLevel: 'auto', description: '欠账统计与重排阈值判定', parameters: objProps({ today: str }) },
  { name: 'get_word_stats', category: 'read', riskLevel: 'auto', description: '单词级双模态表现（视觉/听觉 L1 分布）', parameters: objProps({ wordIds: arr }) },
  { name: 'get_book_progress', category: 'read', riskLevel: 'auto', description: '词书各层进度与当前轮次', parameters: objProps({ bookId: str }) },
  { name: 'get_training_records', category: 'read', riskLevel: 'auto', description: '查询训练记录（四阶）', parameters: objProps({ sessionId: str }) },
  { name: 'get_pronunciation_issues', category: 'read', riskLevel: 'auto', description: '发音存疑/错误清单与回退率', parameters: objProps({ status: str }) },
  { name: 'get_tts_provider_status', category: 'read', riskLevel: 'auto', description: 'TTS 供应商配置状态', parameters: objProps({}) },
  { name: 'get_ability_snapshot', category: 'read', riskLevel: 'auto', description: '最新能力画像快照（隐式评估，无总分）', parameters: objProps({}) },
  { name: 'query_words', category: 'read', riskLevel: 'auto', description: '按层/状态/前缀筛选词（含音标释义）', parameters: objProps({ bookId: str, tier: num, status: str, prefix: str, limit: num }) },
];

// ===== 写类（15 个，PRD §7.1；风险分级照 §7.2）=====

export const WRITE_TOOLS: ToolSpec[] = [
  { name: 'update_plan_params', category: 'write', riskLevel: 'require', description: '修改计划参数（层轮次/截止日/日预算/模态比例/降频开关）', parameters: objProps({ planId: str, patch: { type: 'object' }, reason: str }, ['patch', 'reason']) },
  { name: 'reschedule', category: 'write', riskLevel: 'require', description: '执行欠账重排（extend/compress/drop_round/freeze，含整层冻结）', parameters: objProps({ strategy: { type: 'string', enum: ['extend', 'compress', 'drop_round', 'freeze'] }, deferredIds: arr, today: str, reason: str }, ['strategy', 'reason']) },
  { name: 'switch_plan_mode', category: 'write', riskLevel: 'require', description: '推荐↔保底档位切换', parameters: objProps({ planId: str, planMode: { type: 'string', enum: ['recommended', 'fallback'] }, reason: str }, ['planMode', 'reason']) },
  { name: 'batch_defer_words', category: 'write', riskLevel: 'confirm', description: '批量跳过本轮（>20% 升级为 Require）', parameters: objProps({ hitIds: arr, reason: str }, ['hitIds', 'reason']) },
  { name: 'adjust_word_frequency', category: 'write', riskLevel: 'confirm', description: '单词加练/降频', parameters: objProps({ wordId: str, action: { type: 'string', enum: ['extra_practice', 'reduce'] }, planId: str, reason: str }, ['wordId', 'action', 'reason']) },
  { name: 'recompute_word_tiers', category: 'write', riskLevel: 'confirm', description: '重分层（≤10% 自动，>10% 需确认）', parameters: objProps({ bookId: str, assignments: { type: 'array', items: { type: 'object', properties: { bookWordId: str, tier: num } } }, reason: str }, ['bookId', 'assignments', 'reason']) },
  { name: 'move_words_between_lists', category: 'write', riskLevel: 'confirm', description: '调 List 归属', parameters: objProps({ moves: { type: 'array', items: { type: 'object', properties: { bookWordId: str, listNo: num, orderInList: num } } }, reason: str }, ['moves', 'reason']) },
  { name: 'update_mock_unlock_rule', category: 'write', riskLevel: 'confirm', description: '制定/修改模考解锁规则（基于学习数据，不预设分数线）', parameters: objProps({ ruleJson: { type: 'object' }, reason: str }, ['ruleJson', 'reason']) },
  { name: 'mark_word_status', category: 'write', riskLevel: 'confirm', description: '标记词状态（mastered/steady/deferred/重点）', parameters: objProps({ bookWordId: str, status: str, reason: str }, ['bookWordId', 'status', 'reason']) },
  { name: 'create_training_material', category: 'write', riskLevel: 'auto', description: '生成训练素材（必须绑定当前队列词）', parameters: objProps({ type: str, targetWords: arr, content: { type: 'object' } }, ['type', 'targetWords']) },
  { name: 'generate_sprint_pack', category: 'write', riskLevel: 'confirm', description: '生成冲刺周作文模板包（确认后入日程）', parameters: objProps({ paperRefs: arr, content: { type: 'object' }, reason: str }, ['content', 'reason']) },
  { name: 'upsert_pronunciation', category: 'write', riskLevel: 'auto', description: '补充/替换发音音标', parameters: objProps({ wordId: str, ipa: str }) },
  { name: 'resolve_issue', category: 'write', riskLevel: 'auto', description: '处理存疑清单', parameters: objProps({ issueId: str }) },
  { name: 'create_ability_snapshot', category: 'write', riskLevel: 'auto', description: '生成能力画像快照（无总分）', parameters: objProps({ snapshot: { type: 'object' } }, ['snapshot']) },
  { name: 'annotate_word', category: 'write', riskLevel: 'auto', description: '补释义/例句/助记', parameters: objProps({ wordId: str, sense: str }) },
];

export const TOOL_CATALOG: ToolSpec[] = [...READ_TOOLS, ...WRITE_TOOLS];

export function getToolSpec(name: string): ToolSpec | undefined {
  return TOOL_CATALOG.find((t) => t.name === name);
}

/** 序列化进 LLM tool-calling 请求（OpenAI tools 格式） */
export function toolCatalogJson(): unknown[] {
  return TOOL_CATALOG.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
