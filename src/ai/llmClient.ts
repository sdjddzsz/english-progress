/**
 * llmClient.ts —— 双通道 LLM 客户端（架构 §1.5）：
 * 默认 WorkBuddy 免密钥通道（cloud.llm.chat.completions，仅支持流式，SDK 语义）；
 * 可切换 OpenAI 兼容端点（含本机网关），仅切换 baseUrl/model/可选 key。
 * 统一返回结构化消息（content + toolCalls）。
 */
import { getCloud, isCloudConfigured } from '../data/cloud';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串（调用方解析）
}

export interface LLMTurnResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

export type LLMChannel = 'workbuddy' | 'openai_compatible';

export interface LLMOptions {
  model: string;
  channel?: LLMChannel;
  /** openai_compatible 必填，形如 https://host/v1 */
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  signal?: AbortSignal;
}

interface StreamChunk {
  choices: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] | null;
    } | null;
    finish_reason?: string | null;
  }[];
}

/** 统一入口：messages[0] 必须是 system（WorkBuddy SDK 强约束，兼容通道同样遵守） */
export async function chatTurn(messages: ChatMessage[], opts: LLMOptions): Promise<LLMTurnResult> {
  if (!messages[0] || messages[0].role !== 'system') {
    throw new Error('chatTurn: messages[0] must be a system message');
  }
  if (opts.channel === 'openai_compatible') return chatOpenAICompatible(messages, opts);
  return chatWorkBuddy(messages, opts);
}

/** 通道可用性（设置页测试按钮用） */
export function isLLMChannelReady(opts: Pick<LLMOptions, 'channel' | 'baseUrl'>): boolean {
  if (opts.channel === 'openai_compatible') return Boolean(opts.baseUrl);
  return isCloudConfigured();
}

function accumulate(chunk: StreamChunk, acc: { content: string; toolCalls: Map<number, ToolCall> }): string | null {
  const choice = chunk.choices[0];
  const delta = choice?.delta;
  if (delta?.content) acc.content += delta.content;
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const existing = acc.toolCalls.get(tc.index) ?? { id: '', name: '', arguments: '' };
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.arguments += tc.function.arguments;
      acc.toolCalls.set(tc.index, existing);
    }
  }
  return choice?.finish_reason ?? null;
}

function finalize(acc: { content: string; toolCalls: Map<number, ToolCall> }, finish: string | null): LLMTurnResult {
  return {
    content: acc.content,
    toolCalls: [...acc.toolCalls.values()].filter((t) => t.name),
    finishReason: finish,
  };
}

async function chatWorkBuddy(messages: ChatMessage[], opts: LLMOptions): Promise<LLMTurnResult> {
  const cloud = getCloud();
  const create = cloud.llm.chat.completions.create.bind(cloud.llm.chat.completions) as unknown as (
    input: Record<string, unknown>,
  ) => AsyncIterable<StreamChunk>;
  // 2026-10-15 修「问答失败：流式响应中断」：SDK 在流正常结束但未收到 [DONE] 帧时抛错
  // （网关掐流/服务端不发 DONE）。处置：已收到部分内容 → 直接采用；空内容 → 自动重试一次。
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const acc = { content: '', toolCalls: new Map<number, ToolCall>() };
    let finish: string | null = null;
    try {
      for await (const chunk of create({
        model: opts.model,
        messages,
        stream: true,
        temperature: opts.temperature,
        signal: opts.signal,
      })) {
        finish = accumulate(chunk, acc) ?? finish;
      }
      return finalize(acc, finish);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const interrupted = msg.includes('流式响应中断') || /stream.*(interrupt|abort)|interrupt.*stream/i.test(msg);
      if (!interrupted) throw err;
      if (acc.content.trim()) return finalize(acc, finish ?? 'interrupted');
      // 空内容且已重试过 → 抛出（调用方有中文兜底文案）
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function chatOpenAICompatible(messages: ChatMessage[], opts: LLMOptions): Promise<LLMTurnResult> {
  const base = (opts.baseUrl ?? '').replace(/\/$/, '');
  if (!base) throw new Error('openai_compatible channel requires baseUrl');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: opts.model,
      messages,
      stream: true,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(`OpenAI-compatible LLM HTTP ${res.status}`);

  // 手工解析 SSE data: 帧（OpenAI 兼容格式）
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const acc = { content: '', toolCalls: new Map<number, ToolCall>() };
  let finish: string | null = null;
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        finish = accumulate(JSON.parse(payload) as StreamChunk, acc) ?? finish;
      } catch {
        // 跳过无法解析的帧
      }
    }
  }
  return finalize(acc, finish);
}

// ===== 模型列表（设置页测试连通性）=====

export interface LLMModelInfo {
  id: string;
  name?: string;
  disabled?: boolean;
}

export async function listModels(opts: Pick<LLMOptions, 'channel' | 'baseUrl' | 'apiKey'>): Promise<LLMModelInfo[]> {
  if (opts.channel === 'openai_compatible') {
    const base = (opts.baseUrl ?? '').replace(/\/$/, '');
    if (!base) throw new Error('openai_compatible channel requires baseUrl');
    const res = await fetch(`${base}/models`, {
      headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`models list HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => ({ id: m.id }));
  }
  const cloud = getCloud();
  const models = (await cloud.llm.models.list()) as unknown as LLMModelInfo[];
  return models.map((m) => ({
    id: m.id,
    ...(m.name ? { name: m.name } : {}),
    ...(m.disabled !== undefined ? { disabled: m.disabled } : {}),
  }));
}
