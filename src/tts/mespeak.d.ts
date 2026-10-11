/** meSpeak.js 类型声明（无官方 @types） */
declare module 'mespeak' {
  export interface MeSpeakOptions {
    amplitude?: number;
    pitch?: number;
    speed?: number;
    wordgap?: number;
    variant?: string;
    utf16?: boolean;
    /** true/Uint8Array 输出；或 'mime'/'base64'/'arraybuffer' */
    rawdata?: boolean | string;
  }
  export interface MeSpeak {
    loadConfig(config: unknown): void;
    speak(text: string, options?: MeSpeakOptions): ArrayBuffer | Uint8Array | string | boolean;
  }
  const mespeak: MeSpeak;
  export default mespeak;
}

declare module 'mespeak/src/mespeak_config.json' {
  const config: Record<string, unknown>;
  export default config;
}
