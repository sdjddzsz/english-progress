/**
 * 2026-10-13 晚间三项用户诉求的守门用例：
 *  ① 摸底断点续做（退出/刷新不能从头开始）
 *  ② 音频容器嗅探（WAV 不能挂 mp3 的 MIME）
 *  ③ espeak 兜底轨就绪判据（config 装了但没 voice ⇒ 必须判为未就绪）
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  answeredCount,
  clearSession,
  loadSession,
  saveSession,
  sessionKey,
  type PlacementSession,
} from '../../src/features/placement/session';
import { sniffAudioMime } from '../../src/tts/mime';
import { isMespeakReady } from '../../src/tts/espeakProvider';
import type { L1State } from '../../src/types/domain';

// ===== ① 摸底草稿持久化 =====

function makeSession(over: Partial<PlacementSession> = {}): PlacementSession {
  return {
    version: 1,
    bookId: 'book_cet6_full',
    startedAt: '2026-10-13T23:00:00.000Z',
    updatedAt: '2026-10-13T23:20:00.000Z',
    items: [
      {
        senseId: 'abandon#0',
        lemma: 'abandon',
        frequency: 1,
        pos: 'v.',
        zh: '放弃',
        ipa: '/əˈbændən/',
        arpabet: 'AH0 B AE1 N D AH0 N',
        pronunciationCount: 1,
        senses: [],
      },
    ] as PlacementSession['items'],
    idx: 0,
    responses: { 'abandon#0': 'recognized' as L1State },
    selfChecked: { 'abandon#0': false },
    ...over,
  };
}

/** 极简 localStorage 桩（node 环境无 localStorage） */
function installStorage(): void {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

describe('摸底断点续做（退出后回到中断位置）', () => {
  beforeEach(() => {
    installStorage();
  });

  it('存了就能取回：items / idx / responses 原样', () => {
    const s = makeSession({ idx: 137, responses: { 'abandon#0': 'unknown' } });
    saveSession('u1', s);
    const back = loadSession('u1', 'book_cet6_full');
    expect(back).not.toBeNull();
    expect(back?.idx).toBe(137);
    expect(back?.items.length).toBe(1);
    expect(back?.responses).toEqual({ 'abandon#0': 'unknown' });
  });

  it('按 bookId 隔离：换词书拿不到别的词书草稿（不能拿 A 的进度续 B）', () => {
    saveSession('u1', makeSession());
    expect(loadSession('u1', 'book_other')).toBeNull();
  });

  it('按 userId 隔离', () => {
    saveSession('u1', makeSession());
    expect(loadSession('u2', 'book_cet6_full')).toBeNull();
  });

  it('提交后清掉，不会残留"有未完成摸底"的假提示', () => {
    saveSession('u1', makeSession());
    clearSession('u1', 'book_cet6_full');
    expect(loadSession('u1', 'book_cet6_full')).toBeNull();
  });

  it('版本/结构不匹配的老数据直接作废（返回 null，不炸）', () => {
    localStorage.setItem(sessionKey('u1', 'book_cet6_full'), JSON.stringify({ version: 0, items: [1] }));
    expect(loadSession('u1', 'book_cet6_full')).toBeNull();
    localStorage.setItem(sessionKey('u1', 'book_cet6_full'), 'not-json{');
    expect(loadSession('u1', 'book_cet6_full')).toBeNull();
  });

  it('空 items 的草稿不算草稿（避免空进度卡住入口）', () => {
    saveSession('u1', makeSession({ items: [] }));
    expect(loadSession('u1', 'book_cet6_full')).toBeNull();
  });

  it('answeredCount 只数已答的判定单位', () => {
    expect(answeredCount(makeSession({ responses: { a: 'unknown', b: 'recognized' } }))).toBe(2);
    expect(answeredCount(makeSession({ responses: {} }))).toBe(0);
  });

  it('saveSession 会刷新 updatedAt（界面要显示"上次停在什么时候"）', () => {
    const s = makeSession({ updatedAt: '2020-01-01T00:00:00.000Z' });
    saveSession('u1', s);
    expect(loadSession('u1', 'book_cet6_full')?.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });
});

// ===== ② 音频容器嗅探 =====

function buf(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

describe('sniffAudioMime（WAV 不能挂 mp3 的 MIME）', () => {
  it('RIFF/WAVE → audio/wav（mespeak 兜底轨的真实产物）', () => {
    const head = [...'RIFF'.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...'WAVE'.split('').map((c) => c.charCodeAt(0))];
    expect(sniffAudioMime(buf(head))).toBe('audio/wav');
  });

  it('ID3 头 → audio/mpeg', () => {
    expect(sniffAudioMime(buf([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('audio/mpeg');
  });

  it('MPEG 帧同步 0xFFEx → audio/mpeg', () => {
    expect(sniffAudioMime(buf([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('audio/mpeg');
  });

  it('ftyp → audio/mp4', () => {
    expect(sniffAudioMime(buf([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]))).toBe('audio/mp4');
  });

  it('OggS → audio/ogg', () => {
    expect(sniffAudioMime(buf([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0]))).toBe('audio/ogg');
  });

  it('空/过短输入不炸，回落 wav', () => {
    expect(sniffAudioMime(new ArrayBuffer(0))).toBe('audio/wav');
    expect(sniffAudioMime(buf([1, 2, 3]))).toBe('audio/wav');
  });
});

// ===== ③ espeak 就绪判据 =====

describe('isMespeakReady（config 装了但没 voice 必须判未就绪）', () => {
  it('config + 默认语音都在 ⇒ 就绪', () => {
    expect(isMespeakReady({ isConfigLoaded: () => true, getDefaultVoice: () => 'en/en-us' } as never)).toBe(true);
  });

  it('config 装了、defaultVoice 为空 ⇒ 未就绪（这就是"永远无声"的根因形态）', () => {
    expect(isMespeakReady({ isConfigLoaded: () => true, getDefaultVoice: () => '' } as never)).toBe(false);
  });

  it('config 没装 ⇒ 未就绪', () => {
    expect(isMespeakReady({ isConfigLoaded: () => false, getDefaultVoice: () => 'en/en-us' } as never)).toBe(false);
  });
});
