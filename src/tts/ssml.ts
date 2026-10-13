/**
 * ssml.ts —— SSML 构造：
 * - azure 通道（默认）：IPA → <phoneme alphabet="ipa"> 注入（ipaMap 映射）；
 * - dashscope 通道：CMUdict ARPAbet 零转换 → <phoneme alphabet="cmu">；无 arpabet 降纯文本（P0-9）。
 * 单词模式：音标驱动、禁连读；例句模式：自然韵律（真实考试的听觉输入，与"单词不连读"不矛盾）；
 * 逐词慢读：词间 <break>；音节单独点击：按音节切分生成独立请求（音节切分在 ipaMap.ts）。
 */
import { DASHSCOPE_PHONEME_STRIP_STRESS } from '../config/constants';
import type { TTSProviderName } from '../types/domain';
import { mapIpaToAzure, stripIpaSlashes } from './ipaMap';
import { stripArpabetStress } from './arpabetToIpa';
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

/**
 * DashScope 通道 SSML（架构增量 v0.1）：根元素 <speak>（音色/语速由请求参数承载，不用 <voice> 包裹）。
 * - word：有 arpabet → <phoneme alphabet="cmu"> 零转换注入（仅 XML 转义）；无 arpabet → 纯文本降级（P0-9）；
 * - syllable：纯文本（P0 行为，P1-2 迁 ARPAbet 切分后升级）；
 * - sentence：纯文本自然韵律；word_by_word：词间 <break time="150ms"/>。
 */
function buildDashScopeSsml(req: TTSRequest): string {
  const escapedText = escapeXml(req.text);
  switch (req.mode) {
    case 'word': {
      if (!req.arpabet) return `<speak>${escapedText}</speak>`; // CMUdict 未命中（P0-9）
      // P0-7：默认保留 CMUdict 重音数字；实测不兼容时翻转换 DASHSCOPE_PHONEME_STRIP_STRESS 重新构建
      const ph = DASHSCOPE_PHONEME_STRIP_STRESS ? stripArpabetStress(req.arpabet) : req.arpabet;
      return `<speak><phoneme alphabet="cmu" ph="${escapeXml(ph)}">${escapedText}</phoneme></speak>`;
    }
    case 'syllable': {
      const syl = req.text || (req.syllable ?? stripIpaSlashes(req.ipa ?? ''));
      return `<speak>${escapeXml(syl)}</speak>`;
    }
    case 'sentence':
      return `<speak>${escapedText}</speak>`;
    case 'word_by_word': {
      const words = req.text.split(/\s+/).filter((w) => w.length > 0);
      const inner = words
        .map((w, i) => (i > 0 ? `<break time="${WORD_BREAK_MS}ms"/>` : '') + escapeXml(w))
        .join('');
      return `<speak>${inner}</speak>`;
    }
  }
}

/**
 * 构造 SSML。provider 默认 'azure'（旧调用与历史快照字节不变）；
 * 'dashscope' 走 cmu 分支；'openai_compatible' 无 SSML 能力（neuralProvider 不发 SSML，此处不分支）。
 */
export function buildSsml(req: TTSRequest, provider: TTSProviderName = 'azure'): string {
  if (provider === 'dashscope') return buildDashScopeSsml(req);
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
