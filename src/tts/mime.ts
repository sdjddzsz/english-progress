/**
 * mime.ts —— 音频容器嗅探（按魔数，不信任调用方声明）。
 *
 * 为什么需要：离线兜底（mespeak/eSpeak）产的是 **WAV**，云端主轨产的是 MP3。
 * 原实现把两种都塞进 `new Blob([...], { type: 'audio/mpeg' })` ——
 * WAV 数据挂 mp3 类型，浏览器解码器直接失败，而 `<audio>.onerror` 之外没有任何可见反馈
 * ⇒ 用户看到的就是"点了发音没声音"（2026-10-13 线上问题之一）。
 */
const ASCII = (b: Uint8Array, i: number): string => String.fromCharCode(b[i] ?? 0);

export function sniffAudioMime(audio: ArrayBuffer): string {
  if (!audio || audio.byteLength < 12) return 'audio/wav';
  const h = new Uint8Array(audio.slice(0, 12));
  // RIFF....WAVE
  if (ASCII(h, 0) === 'R' && ASCII(h, 1) === 'I' && ASCII(h, 2) === 'F' && ASCII(h, 3) === 'F') return 'audio/wav';
  // ID3v2 tag
  if (ASCII(h, 0) === 'I' && ASCII(h, 1) === 'D' && ASCII(h, 2) === '3') return 'audio/mpeg';
  // MPEG 帧同步：11 位全 1
  if (h[0] === 0xff && (h[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  // ....ftyp（MP4/M4A）
  if (ASCII(h, 4) === 'f' && ASCII(h, 5) === 't' && ASCII(h, 6) === 'y' && ASCII(h, 7) === 'p') return 'audio/mp4';
  // OggS
  if (ASCII(h, 0) === 'O' && ASCII(h, 1) === 'g' && ASCII(h, 2) === 'g' && ASCII(h, 3) === 'S') return 'audio/ogg';
  return 'audio/wav'; // 兜底轨（mespeak）是本地主流情形
}
