/**
 * webSpeech.ts —— 浏览器内置语音（speechSynthesis）兜底。
 *
 * 为什么要有这一层：离线 WASM 兜底（mespeak）要下载 1.7MB 引擎、且音色机械，
 * 装载失败时编排器只能抛错 ⇒ 用户"点了发音没反应"。浏览器内置语音零网络零依赖，
 * 是最后一道保证「一定会出声」的兜底。
 *
 * 边界：它**不产出音频字节**（拿不到 ArrayBuffer），所以不入音频缓存、不写用量统计；
 * 只在编排链彻底失败时直接朗读。
 */
export interface WebSpeechOptions {
  /** 语速（0.1–10，默认 0.9；单词稍慢便于听清） */
  rate?: number;
  lang?: string;
}

export function isWebSpeechAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined';
}

/** 选英文语音：优先 en-US，其次任意 en-*，再其次系统默认 */
function pickEnglishVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices?.() ?? [];
  if (voices.length === 0) return null;
  const en = voices.filter((v) => /^en/i.test(v.lang));
  return en.find((v) => /^en[-_]us/i.test(v.lang)) ?? en[0] ?? voices[0] ?? null;
}

/**
 * 朗读一段文本。
 * @returns true = 真的朗读了；false = 浏览器不支持 / 无可用语音 / 被中断
 */
export function speakWithWebSpeech(text: string, opts: WebSpeechOptions = {}): Promise<boolean> {
  if (!isWebSpeechAvailable() || !text.trim()) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickEnglishVoice();
      if (v) u.voice = v;
      u.lang = opts.lang ?? v?.lang ?? 'en-US';
      u.rate = opts.rate ?? 0.9;
      // 部分实现不触发 onend（或长文本被静默掐断）⇒ 超时兜底，避免界面一直转圈
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      u.onend = () => done(true);
      u.onerror = () => done(false);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
      // 极端兜底：30s 没结束也算结束（部分实现不触发 onend）
      window.setTimeout(() => done(true), Math.max(3000, text.length * 120) + 2000);
    } catch {
      resolve(false);
    }
  });
}

/** 正在朗读时中断（切词时用，避免上一个词的声音盖住下一个） */
export function cancelWebSpeech(): void {
  if (isWebSpeechAvailable()) window.speechSynthesis.cancel();
}
