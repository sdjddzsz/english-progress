/**
 * voiceOptions.ts —— 模型/音色选项的纯数据助手（用户 2026-10-18 临换面板用）。
 * 音色按模型分组是官方硬约束：音色不能跨模型混用，换模型必须换到新模型的音色表内。
 * 纯函数、零依赖（只吃 constants），组件与单测共用。
 */
import { DASHSCOPE_MODEL_OPTIONS, DASHSCOPE_VOICE_OPTIONS_BY_MODEL } from '../config/constants';

/** 某模型可选音色（未知模型返回空表——调用方按空表禁用音色区） */
export function voicesForModel(model: string): readonly { voice: string; label: string }[] {
  return DASHSCOPE_VOICE_OPTIONS_BY_MODEL[model] ?? [];
}

/** 某模型的默认音色（表内第一个；未知模型回落空串） */
export function defaultVoiceForModel(model: string): string {
  return voicesForModel(model)[0]?.voice ?? '';
}

/** 音色展示名（查表回落原始 ID） */
export function voiceLabelOf(model: string, voice: string): string {
  return voicesForModel(model).find((v) => v.voice === voice)?.label ?? voice;
}

/** 全部可选模型（设置页/临换面板共用） */
export const ALL_MODELS: readonly string[] = DASHSCOPE_MODEL_OPTIONS;
