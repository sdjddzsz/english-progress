/**
 * TTS 层类型定义（架构文档 §1.6）。Provider 插拔：神经主轨（Azure / OpenAI 兼容）+ espeak 兜底轨。
 */
import type { TTSEngine, TTSProviderConfig } from '../types/domain';

export type TTSMode = 'word' | 'sentence' | 'syllable' | 'word_by_word';

/** 音素来源：cmu=dashscope phoneme 注入；ipa=azure phoneme；text=纯文本降级（P0-9） */
export type PhonemeSource = 'cmu' | 'ipa' | 'text';

export interface TTSRequest {
  /** 单词/例句原文 */
  text: string;
  /** 完整 IPA（可含 /…/ 斜杠），单词模式必填；展示与 espeak 兜底用 */
  ipa?: string;
  /**
   * CMUdict ARPAbet（空格分隔，可带 0/1/2 重音数字，如 "AH0 K AE1 D AH0 M IY0"）。
   * dashscope 通道 <phoneme alphabet="cmu"> 零转换直用；缺省 = CMUdict 未命中，
   * word/syllable 模式降级纯文本（P0-9）。azure / openai_compatible 通道忽略本字段。
   */
  arpabet?: string;
  /** mode='syllable' 时该音节的 IPA（不含斜杠） */
  syllable?: string;
  mode: TTSMode;
  voice?: string;
}

export interface TTSResult {
  audio: ArrayBuffer;
  engine: TTSEngine;
  fromCache: boolean;
  /** 实际发送的 SSML（诊断用） */
  ssml?: string;
  /** 音素来源（PronunciationLog.phonemeSource 透传） */
  phonemeSource?: PhonemeSource;
  /** DashScope usage.characters（P1-1 成本卡精确口径） */
  usageChars?: number;
}

/** 运行时上下文：key 从云端配置文档取入内存（架构已声明例外），不入 localStorage/代码 */
export interface TTSContext {
  config: TTSProviderConfig;
  apiKey?: string;
  signal?: AbortSignal;
}

export interface TTSProvider {
  readonly id: string;
  /** ctx 可省略：espeak 兜底轨不依赖云端配置 */
  synthesize(req: TTSRequest, ctx?: TTSContext): Promise<TTSResult>;
}
