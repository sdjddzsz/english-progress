/**
 * useSettingsStore.ts —— 用户偏好（zustand persist → localStorage）。
 * 只放非敏感偏好；密钥类一律不入本 store（TTS key 仅存会话内存，见 hooks/useTTS.ts）。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Device } from '../types/domain';
import type { LLMChannel } from '../ai/llmClient';
import { CN_TO_EN_DAILY_WORDS, DEFAULT_TTS_PROVIDER } from '../config/constants';
import type { TTSProviderName } from '../types/domain';

export interface SettingsState {
  device: Device;
  /** 见中文联想英文开关与每日词数（PRD §4.5） */
  cnToEnEnabled: boolean;
  cnToEnDailyWords: number;
  /** AI 通道（workbuddy 免密钥 / openai_compatible 自备端点） */
  aiChannel: LLMChannel;
  aiBaseUrl: string;
  aiModel: string;
  /** TTS 发音人（Azure voice name；兜底轨忽略） */
  ttsProvider: TTSProviderName;
  ttsVoice: string;

  setDevice(device: Device): void;
  setCnToEn(enabled: boolean, dailyWords?: number): void;
  setAI(channel: LLMChannel, baseUrl: string, model: string): void;
  setTTS(provider: TTSProviderName, voice: string): void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      device: 'desktop',
      cnToEnEnabled: true,
      cnToEnDailyWords: CN_TO_EN_DAILY_WORDS,
      aiChannel: 'workbuddy',
      aiBaseUrl: '',
      aiModel: '',
      ttsProvider: DEFAULT_TTS_PROVIDER,
      ttsVoice: '',

      setDevice: (device) => set({ device }),
      setCnToEn: (cnToEnEnabled, dailyWords) =>
        set(dailyWords != null ? { cnToEnEnabled, cnToEnDailyWords: dailyWords } : { cnToEnEnabled }),
      setAI: (aiChannel, aiBaseUrl, aiModel) => set({ aiChannel, aiBaseUrl, aiModel }),
      setTTS: (ttsProvider, ttsVoice) => set({ ttsProvider, ttsVoice }),
    }),
    { name: 'ep-settings' },
  ),
);
