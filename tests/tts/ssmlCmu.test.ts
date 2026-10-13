/**
 * ssmlCmu.test.ts —— T4 单测：buildSsml(req, 'dashscope') cmu 分支 + azure 默认路径零回退。
 * 验收口径（架构增量 §6 T4）：
 *  ① word 有 arpabet → <phoneme alphabet="cmu">（仅 XML 转义）；无 arpabet → 纯文本（P0-9）；
 *  ② syllable → 纯文本；sentence → 纯文本；word_by_word → 词间 <break time="150ms"/>；
 *  ③ DASHSCOPE_PHONEME_STRIP_STRESS=false 时 ph 保留 CMUdict 重音数字；
 *  ④ azure 路径字节不变（tts.test.ts 四个快照原样通过的旁证）；
 *  ⑤ escapeXml 对 & < > " ' 全覆盖。
 */
import { describe, expect, it } from 'vitest';
import { buildSsml } from '../../src/tts/ssml';
import { DASHSCOPE_PHONEME_STRIP_STRESS } from '../../src/config/constants';

describe('buildSsml dashscope 分支：word 模式 cmu phoneme 注入', () => {
  it('有 arpabet：<speak><phoneme alphabet="cmu" ph="…">word</phoneme></speak>（零转换）', () => {
    const ssml = buildSsml({ text: 'academy', arpabet: 'AH0 K AE1 D AH0 M IY0', mode: 'word' }, 'dashscope');
    expect(ssml).toBe('<speak><phoneme alphabet="cmu" ph="AH0 K AE1 D AH0 M IY0">academy</phoneme></speak>');
  });

  it('无 arpabet（CMUdict 未命中）：降级纯文本，不注入 phoneme（P0-9）', () => {
    const ssml = buildSsml({ text: 'academy', ipa: '/əˈkæd.ə.mi/', mode: 'word' }, 'dashscope');
    expect(ssml).toBe('<speak>academy</speak>');
    expect(ssml).not.toContain('<phoneme');
  });

  it('默认保留重音数字（P0-7：DASHSCOPE_PHONEME_STRIP_STRESS=false）', () => {
    expect(DASHSCOPE_PHONEME_STRIP_STRESS).toBe(false);
    const ssml = buildSsml({ text: 'sin', arpabet: 'S AY1 N', mode: 'word' }, 'dashscope');
    expect(ssml).toContain('ph="S AY1 N"');
  });

  it('XML 特殊字符仅转义、不改变音素内容', () => {
    const ssml = buildSsml({ text: 'a<b>&"c\'', arpabet: 'K AE1 T', mode: 'word' }, 'dashscope');
    expect(ssml).toBe('<speak><phoneme alphabet="cmu" ph="K AE1 T">a&lt;b&gt;&amp;&quot;c&apos;</phoneme></speak>');
  });
});

describe('buildSsml dashscope 分支：其余三模式', () => {
  it('syllable 模式：纯文本（P0 行为，P1-2 升级）', () => {
    expect(buildSsml({ text: 'kɒm', syllable: 'ˈkɒm', mode: 'syllable' }, 'dashscope')).toBe('<speak>kɒm</speak>');
  });

  it('sentence 模式：纯文本自然韵律', () => {
    expect(buildSsml({ text: 'The hotel can accommodate 500 guests.', mode: 'sentence' }, 'dashscope')).toBe(
      '<speak>The hotel can accommodate 500 guests.</speak>',
    );
  });

  it('word_by_word 模式：词间 <break time="150ms"/>', () => {
    expect(buildSsml({ text: 'look after', mode: 'word_by_word' }, 'dashscope')).toBe(
      '<speak>look<break time="150ms"/>after</speak>',
    );
  });
});

describe('buildSsml azure 路径：默认 provider 字节不变（零回退）', () => {
  const req = { text: 'accommodate', ipa: '/əˈkɒm.ə.deɪt/', mode: 'word' as const };

  it('不传 provider 与显式传 azure 结果一致', () => {
    expect(buildSsml(req)).toBe(buildSsml(req, 'azure'));
  });

  it('azure 四模式产物与历史实现逐字节一致', () => {
    expect(buildSsml(req, 'azure')).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">' +
        '<voice name="en-US-AriaNeural"><phoneme alphabet="ipa" ph="əˈkɒm.ə.deɪt">accommodate</phoneme></voice></speak>',
    );
    expect(buildSsml({ text: 'kɒm', syllable: 'ˈkɒm', mode: 'syllable' }, 'azure')).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">' +
        '<voice name="en-US-AriaNeural"><phoneme alphabet="ipa" ph="ˈkɒm">kɒm</phoneme></voice></speak>',
    );
    expect(buildSsml({ text: 'The hotel can accommodate 500 guests.', mode: 'sentence' }, 'azure')).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">' +
        '<voice name="en-US-AriaNeural">The hotel can accommodate 500 guests.</voice></speak>',
    );
    expect(buildSsml({ text: 'look after', mode: 'word_by_word' }, 'azure')).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">' +
        '<voice name="en-US-AriaNeural">look<break time="150ms"/>after</voice></speak>',
    );
  });

  it('azure word 模式忽略 arpabet（只用 IPA）', () => {
    const ssml = buildSsml({ text: 'academy', ipa: '/əˈkæd.ə.mi/', arpabet: 'AH0 K AE1 D AH0 M IY0', mode: 'word' }, 'azure');
    expect(ssml).toContain('alphabet="ipa"');
    expect(ssml).not.toContain('cmu');
  });
});
