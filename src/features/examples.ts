/**
 * examples.ts —— 例句生成的 prompt 构造与回复解析（用户 2026-10-22）。
 *
 * 纯函数、零 IO、零 React 依赖：prompt 怎么拼、模型回复怎么解析都在这里定死，
 * hook 与测试共用。每个调用只生成**一条**例句（用户：每次生成增加一个例句）。
 *
 * 输出协议：要求模型只回一行 JSON `{"en": "...", "zh": "..."}`；
 * 解析必须宽容（代码块围栏/前后废话/中文引号都要能活下来）——模型不守格式时
 * 返回 null，由调用方提示「生成失败，再试一次」，绝不把原始文本当例句存。
 */
import type { ChatMessage } from '../ai/llmClient';
import type { WordSense } from '../types/domain';

export interface GeneratedExample {
  en: string;
  zh: string;
}

/** 系统提示：一句话人设 + 硬性输出协议 */
export const EXAMPLE_SYSTEM_PROMPT =
  '你是一个英语词典编纂助手。用户会给你一个单词和它的某个义项（词性+中文释义），' +
  '你需要为这个义项写一条地道的英语例句。要求：\n' +
  '1. 例句必须体现该义项的用法，长度 8-20 个词，不要生僻词堆砌；\n' +
  '2. 附一条准确通顺的中文翻译；\n' +
  '3. 只输出一行 JSON：{"en": "英语例句", "zh": "中文翻译"}，不要任何解释、不要代码块围栏。';

/** 用户提示：词 + 义项上下文（zhOverride = 逗号拆开后的单条子义项，用户 2026-10-23） */
export function buildExampleUserPrompt(lemma: string, sense: WordSense, zhOverride?: string): string {
  const pos = sense.pos ? `（词性：${sense.pos}）` : '';
  const zh = (zhOverride ?? sense.zh) || '（未填写）';
  return `单词：${lemma}${pos}\n义项释义：${zh}\n请为这个义项生成一条例句。`;
}

/** 组装完整消息序列（messages[0] 必须是 system——SDK 强约束） */
export function buildExampleMessages(lemma: string, sense: WordSense, zhOverride?: string): ChatMessage[] {
  return [
    { role: 'system', content: EXAMPLE_SYSTEM_PROMPT },
    { role: 'user', content: buildExampleUserPrompt(lemma, sense, zhOverride) },
  ];
}

/**
 * 解析模型回复 → { en, zh }；不合规返回 null。
 * 宽容链：剥代码围栏 → 截取第一个 { 到最后一个 } → JSON.parse →
 * 字段必须都是非空字符串 → 规整首尾空白与引号。
 */
export function parseExampleReply(content: string): GeneratedExample | null {
  if (!content) return null;
  let text = content.trim();
  // 剥 ```json ... ``` 围栏
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  // 截取第一个 { 到最后一个 }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const en = typeof obj.en === 'string' ? obj.en.trim() : '';
    const zh = typeof obj.zh === 'string' ? obj.zh.trim() : '';
    if (!en || !zh) return null;
    // 中文引号/直引号统一成中文引号之外的常规形态即可，仅去首尾杂散空白
    return { en: en.replace(/\s+/g, ' '), zh };
  } catch {
    return null;
  }
}
