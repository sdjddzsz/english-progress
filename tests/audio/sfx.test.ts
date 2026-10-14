/**
 * sfx.test.ts —— 答题音效守门用例（用户 2026-10-14 要求）。
 *
 * 音效是**反馈**，最怕两件事：① 环境不支持时抛错把答题流程带崩；② 答对/答错听起来一样。
 * 这两条都在这里钉死。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { __resetSfxContext, playSfx } from '../../src/audio/sfx';

const g = globalThis as unknown as { window?: unknown };
const savedWindow = g.window;

afterEach(() => {
  g.window = savedWindow;
  __resetSfxContext();
});

/** 最小 AudioContext 桩：记录每个音符的频率与类型 */
function installAudioContext(): { freqs: number[]; types: string[] } {
  const freqs: number[] = [];
  const types: string[] = [];
  class FakeOscillator {
    type = 'sine';
    frequency = {
      setValueAtTime: (v: number) => {
        freqs.push(v);
      },
    };
    connect(): this {
      return this;
    }
    start(): void {}
    stop(): void {}
  }
  class FakeGain {
    gain = {
      setValueAtTime: () => {},
      linearRampToValueAtTime: () => {},
      exponentialRampToValueAtTime: () => {},
    };
    connect(): this {
      return this;
    }
  }
  class FakeAudioContext {
    currentTime = 0;
    state = 'running';
    destination = {};
    createOscillator(): FakeOscillator {
      const o = new FakeOscillator();
      // 记录 type（构造后会被赋值，用 defineProperty 捕获）
      Object.defineProperty(o, 'type', {
        get: () => 'sine',
        set: (v: string) => {
          types.push(v);
        },
      });
      return o;
    }
    createGain(): FakeGain {
      return new FakeGain();
    }
    resume(): Promise<void> {
      return Promise.resolve();
    }
  }
  g.window = { AudioContext: FakeAudioContext };
  return { freqs, types };
}

describe('答题音效：环境不支持时必须静默降级', () => {
  it('没有 window（Node/SSR）时不抛错', () => {
    g.window = undefined;
    expect(() => playSfx('correct')).not.toThrow();
    expect(() => playSfx('wrong')).not.toThrow();
  });

  it('有 window 但没有 AudioContext（老浏览器）时不抛错', () => {
    g.window = {};
    expect(() => playSfx('correct')).not.toThrow();
    expect(() => playSfx('wrong')).not.toThrow();
  });
});

describe('答题音效：答对与答错必须能听出来', () => {
  it('各发两个音；答对上行、答错下行', () => {
    __resetSfxContext();
    const { freqs } = installAudioContext();

    playSfx('correct');
    const correct = [...freqs];
    freqs.length = 0;
    playSfx('wrong');
    const wrong = [...freqs];

    expect(correct.length).toBe(2);
    expect(wrong.length).toBe(2);
    // 上行 vs 下行：这是"答对/答错"能被听出来的物理依据
    expect(correct[1]).toBeGreaterThan(correct[0]);
    expect(wrong[1]).toBeLessThan(wrong[0]);
    // 两组音不能重合（否则答对答错一个声）
    expect(correct[0]).not.toBe(wrong[0]);
    expect(correct[1]).not.toBe(wrong[1]);
  });

  it('答错用 triangle 音色（比 sine 更闷，与答对区分）', () => {
    __resetSfxContext();
    const { types } = installAudioContext();
    playSfx('wrong');
    expect(types.every((t) => t === 'triangle')).toBe(true);

    __resetSfxContext();
    const second = installAudioContext();
    playSfx('correct');
    expect(second.types.every((t) => t === 'sine')).toBe(true);
  });

  it('suspended 状态下会尝试 resume（首次点击前 AudioContext 常是挂起的）', () => {
    __resetSfxContext();
    let resumed = false;
    const { freqs } = installAudioContext();
    const AC = (g.window as { AudioContext: new () => unknown }).AudioContext;
    class SuspendedAC extends (AC as new () => object) {
      state = 'suspended';
      resume(): Promise<void> {
        resumed = true;
        return Promise.resolve();
      }
    }
    g.window = { AudioContext: SuspendedAC };
    playSfx('correct');
    expect(resumed).toBe(true);
    expect(freqs.length).toBe(2);
  });
});
