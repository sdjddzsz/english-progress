/**
 * ssml.ts —— SSML 构造：IPA → <phoneme alphabet="ipa"> 注入。
 * 单词模式：音标驱动、禁连读；例句模式：自然韵律（真实考试的听觉输入，与"单词不连读"不矛盾）；
 * 逐词慢读：词间 <break>；音节单独点击：按音节切分生成独立请求（音节切分在 ipaMap.ts）。
 */
import { mapIpaToAzure, stripIpaSlashes } from './ipaMap';
import type { TTSRequest } from './types';

const SSML_LANG = 'en-US';
export const DEFAULT_VOICE = 'en-US-AriaNeural';
const WORD_BREAK_MS = 150;

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function phonemeXml(text: string, ipa: string): string {
  const ph = mapIpaToAzure(ipa);
  return `<phoneme alphabet="ipa" ph="${escapeXml(ph)}">${escapeXml(text)}</phoneme>`;
}

export function speakXml(inner: string, voice?: string): string {
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${SSML_LANG}">` +
    `<voice name="${escapeXml(voice ?? DEFAULT_VOICE)}">${inner}</voice></speak>`
  );
}

/** 构造 SSML（四种模式）。返回的字符串可直接作为 Azure TTS REST body。 */
export function buildSsml(req: TTSRequest): string {
  const voice = req.voice ?? DEFAULT_VOICE;
  switch (req.mode) {
    case 'word': {
      // 单词模式：逐词合成、音标驱动。meSpeak/Azure 不注入连读规则（SSML 层禁用弱读）。
      const ipa = req.ipa ? stripIpaSlashes(req.ipa) : '';
      const inner = ipa ? phonemeXml(req.text, ipa) : escapeXml(req.text);
      return speakXml(inner, voice);
    }
    case 'syllable': {
      // 音节单独点击：该音节独立请求
      const syl = req.syllable ?? stripIpaSlashes(req.ipa ?? '');
      const inner = syl ? phonemeXml(req.text || syl, syl) : escapeXml(req.text);
      return speakXml(inner, voice);
    }
    case 'sentence': {
      // 例句模式：自然韵律（允许连读——真实听觉输入）
      return speakXml(escapeXml(req.text), voice);
    }
    case 'word_by_word': {
      // 逐词慢读：词间 break；词级 IPA 需分词音标（P1 真题语料接入后升级为逐词 phoneme）
      const words = req.text.split(/\s+/).filter((w) => w.length > 0);
      const inner = words
        .map((w, i) => (i > 0 ? `<break time="${WORD_BREAK_MS}ms"/>` : '') + escapeXml(w))
        .join('');
      return speakXml(inner, voice);
    }
  }
}
