/**
 * TTS 层类型定义（架构文档 §1.6）。Provider 插拔：神经主轨（Azure / OpenAI 兼容）+ espeak 兜底轨。
 */
import type { TTSEngine, TTSProviderConfig } from '../types/domain';

export type TTSMode = 'word' | 'sentence' | 'syllable' | 'word_by_word';

export interface TTSRequest {
  /** 单词/例句原文 */
  text: string;
  /** 完整 IPA（可含 /…/ 斜杠），单词模式必填 */
  ipa?: string;
  /** mode='syllable' 时该音节的 IPA（不含斜杠） */
  syllable?: string;
  mode: TTSMode;
  voice?: string;
}

export interface TTSResult {
  audio: ArrayBuffer;
  engine: TTSEngine;
  fromCache: boolean;
  /** 实际发送的 SSML（Azure 通道；诊断用） */
  ssml?: string;
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
