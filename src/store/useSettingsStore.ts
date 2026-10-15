/**
 * useSettingsStore.ts —— 用户偏好（zustand persist → localStorage）。
 * 只放非敏感偏好；密钥类一律不入本 store（TTS key 仅存会话内存，见 hooks/useTTS.ts）。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { QuizDayThreshold } from '../features/quiz/judging';
import type { Device } from '../types/domain';
import type { LLMChannel } from '../ai/llmClient';
import { CN_TO_EN_DAILY_WORDS, DASHSCOPE_DEFAULT_MODEL, DEFAULT_TTS_PROVIDER, QUIZ_DAILY_LIMIT_DEFAULT, QUIZ_DAILY_LIMIT_MAX, QUIZ_DAILY_LIMIT_MIN } from '../config/constants';
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
  /** TTS 模型名（dashscope：cosyvoice-v2 等）。默认取 DashScope 常量 */
  ttsModel: string;
  /**
   * 自动发音：进入/揭晓当前词时自动朗读一次（用户 2026-10-13 要求）。
   * 只作用于"当前词"场景（学习/摸底/拼写/听音），列表页不自动朗读。
   */
  autoSpeak: boolean;
  /**
   * 答题音效：答对/答错时播放短促提示音（用户 2026-10-14 要求，可关闭）。
   * 只作用于有客观对错的环节（拼写/听音选词/中译英），自评式环节（摸底、背词）不播。
   */
  sfxEnabled: boolean;
  /** 考查答完是否自动进入下一题（用户 2026-10-14：默认关=手动点下一题） */
  quizAutoNext: boolean;
  /** 当天过关档位（用户 2026-10-14：宽松/适当/严格） */
  quizDayThreshold: QuizDayThreshold;
  /**
   * 每轮考查词量上限（用户 2026-10-15 拍板：默认 300，可调 50–1000）。
   * 只限"当天新铺的词"，答错重排不占额。
   */
  quizDailyLimit: number;

  setDevice(device: Device): void;
  setCnToEn(enabled: boolean, dailyWords?: number): void;
  setAI(channel: LLMChannel, baseUrl: string, model: string): void;
  /** 第三参 model 可选（旧调用兼容；缺省保留当前 ttsModel） */
  setTTS(provider: TTSProviderName, voice: string, model?: string): void;
  setAutoSpeak(enabled: boolean): void;
  setSfxEnabled(enabled: boolean): void;
  setQuizAutoNext(enabled: boolean): void;
  setQuizDayThreshold(threshold: QuizDayThreshold): void;
  setQuizDailyLimit(limit: number): void;
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
      ttsModel: DASHSCOPE_DEFAULT_MODEL,
      autoSpeak: true,
      sfxEnabled: true,
      quizAutoNext: false,
      quizDayThreshold: 'standard',
      quizDailyLimit: QUIZ_DAILY_LIMIT_DEFAULT,

      setDevice: (device) => set({ device }),
      setCnToEn: (cnToEnEnabled, dailyWords) =>
        set(dailyWords != null ? { cnToEnEnabled, cnToEnDailyWords: dailyWords } : { cnToEnEnabled }),
      setAI: (aiChannel, aiBaseUrl, aiModel) => set({ aiChannel, aiBaseUrl, aiModel }),
      setTTS: (ttsProvider, ttsVoice, ttsModel) =>
        set({ ttsProvider, ttsVoice, ...(ttsModel != null ? { ttsModel } : {}) }),
      setAutoSpeak: (autoSpeak) => set({ autoSpeak }),
      setSfxEnabled: (sfxEnabled) => set({ sfxEnabled }),
      setQuizAutoNext: (quizAutoNext) => set({ quizAutoNext }),
      setQuizDayThreshold: (quizDayThreshold) => set({ quizDayThreshold }),
      setQuizDailyLimit: (quizDailyLimit) =>
        set({
          quizDailyLimit: Math.min(
            QUIZ_DAILY_LIMIT_MAX,
            Math.max(QUIZ_DAILY_LIMIT_MIN, Math.round(quizDailyLimit)),
          ),
        }),
    }),
    { name: 'ep-settings' },
  ),
);
