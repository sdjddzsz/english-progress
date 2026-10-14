/**
 * sfx.ts —— 答题音效（答对 / 答错），Web Audio 实时合成。
 *
 * 为什么用合成而不是音频文件：
 * - 零网络、零资源体积、零缓存问题 —— 音效必须"一定会响"，不能像 TTS 那样依赖主轨/密钥/网关；
 * - 答题音效是**反馈**，迟 200ms 就失去意义，合成是 0 延迟；
 * - 不需要入 PWA 预缓存清单（避免又多一份 1MB 资源）。
 *
 * 边界：只做反馈音，不做朗读（朗读走 useTTS）。音量刻意压得低（≈0.1），不刺耳、不盖住发音。
 */

export type SfxKind = 'correct' | 'wrong';

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const AC = w.AudioContext ?? w.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    try {
      ctx = new AC();
    } catch {
      return null; // 极少数环境构造失败：静默降级，不影响答题
    }
  }
  return ctx;
}

/** 单个音符：短促、带 12ms 淡入与指数衰减，避免爆音 */
function tone(ac: AudioContext, freq: number, startAt: number, dur: number, peak: number, type: OscillatorType = 'sine'): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(startAt);
  osc.stop(startAt + dur + 0.02);
}

/**
 * 播放答对/答错音效。
 * 答对 = 上行两音（A5 → E6，明亮）；答错 = 下行两音（Eb4 → Bb3，低沉）。
 * 浏览器自动播放策略要求先有用户手势 —— 答题本身就是点击，天然满足；
 * 若 AudioContext 处于 suspended（首次调用），先 resume 再发声。
 */
export function playSfx(kind: SfxKind): void {
  const ac = getCtx();
  if (!ac) return;
  if (ac.state === 'suspended') void ac.resume();
  const t0 = ac.currentTime + 0.01;
  if (kind === 'correct') {
    tone(ac, 880.0, t0, 0.11, 0.1);
    tone(ac, 1318.5, t0 + 0.085, 0.16, 0.09);
  } else {
    tone(ac, 311.1, t0, 0.15, 0.1, 'triangle');
    tone(ac, 233.1, t0 + 0.1, 0.22, 0.09, 'triangle');
  }
}

/** 测试用：重置单例（真实运行不需要） */
export function __resetSfxContext(): void {
  ctx = null;
}
