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
import { DEFAULT_STAGE_GRADUATE } from '../features/quiz/stages';
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
  /**
   * 每轮过关挡位（轮标线）：同一轮里连续 3 次达到这条线才放行。
   * 2026-10-23 起与「首答即过关挡位」解耦——本挡位只管轮标线计数，不再管首答一遍过。
   */
  quizDayThreshold: QuizDayThreshold;
  /**
   * 首答即过关挡位（用户 2026-10-23 拆线）：本轮第一次露面就达到这条线 ⇒ 「首答即达标一遍过」
   * 立即放行。默认 strict（首答熟练才算一遍过）；旧设备无此持久化字段时自动落到默认。
   */
  firstPassThreshold: QuizDayThreshold;
  /**
   * 每轮考查词量上限（用户 2026-10-15 拍板：默认 300，可调 50–1000）。
   * 只限"当天新铺的词"，答错重排不占额。
   */
  quizDailyLimit: number;
  /** 四阶段制（用户 2026-10-15）：阶段一~三毕业所需连续熟练次数（默认各 3，可 1–10）；阶段四写对一次即毕业 */
  stageGraduate: Record<1 | 2 | 3, number>;

  setDevice(device: Device): void;
  setCnToEn(enabled: boolean, dailyWords?: number): void;
  setAI(channel: LLMChannel, baseUrl: string, model: string): void;
  /** 第三参 model 可选（旧调用兼容；缺省保留当前 ttsModel） */
  setTTS(provider: TTSProviderName, voice: string, model?: string): void;
  setAutoSpeak(enabled: boolean): void;
  setSfxEnabled(enabled: boolean): void;
  setQuizAutoNext(enabled: boolean): void;
  setQuizDayThreshold(threshold: QuizDayThreshold): void;
  setFirstPassThreshold(threshold: QuizDayThreshold): void;
  setQuizDailyLimit(limit: number): void;
  setStageGraduate(stage: 1 | 2 | 3, count: number): void;
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
      firstPassThreshold: 'strict',
      quizDailyLimit: QUIZ_DAILY_LIMIT_DEFAULT,
      stageGraduate: { 1: DEFAULT_STAGE_GRADUATE[1], 2: DEFAULT_STAGE_GRADUATE[2], 3: DEFAULT_STAGE_GRADUATE[3] },

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
      setFirstPassThreshold: (firstPassThreshold) => set({ firstPassThreshold }),
      setQuizDailyLimit: (quizDailyLimit) =>
        set({
          quizDailyLimit: Math.min(
            QUIZ_DAILY_LIMIT_MAX,
            Math.max(QUIZ_DAILY_LIMIT_MIN, Math.round(quizDailyLimit)),
          ),
        }),
      setStageGraduate: (stage, count) =>
        set((s) => ({
          stageGraduate: {
            ...s.stageGraduate,
            [stage]: Math.min(10, Math.max(1, Math.round(count))),
          },
        })),
    }),
    { name: 'ep-settings' },
  ),
);
