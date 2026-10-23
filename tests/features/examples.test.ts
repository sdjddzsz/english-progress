/**
 * examples.test.ts —— 例句生成的 prompt 构造与回复解析（用户 2026-10-22）。
 *
 * 锚点：
 * 1. messages[0] 必须是 system（WorkBuddy SDK 强约束）；
 * 2. 解析必须宽容——代码围栏 / 前后废话 / 中文引号都要能活；
 * 3. 不合规（空字段/无 JSON/非字符串）一律返回 null——绝不把模型废话当例句存。
 */
import { describe, expect, it } from 'vitest';
import { buildExampleMessages, buildExampleUserPrompt, parseExampleReply } from '../../src/features/examples';
import { splitSenseZh } from '../../src/features/senses';
import type { WordSense } from '../../src/types/domain';

const sense: WordSense = {
  senseId: 'abandon#0',
  lemma: 'abandon',
  pos: 'v.',
  zh: '放弃，抛弃',
  pronunciationKey: 'abandon#0',
  arpabet: 'AH0 B AE1 N D AH0 N',
  ipa: '/əˈbændən/',
};

describe('buildExampleMessages', () => {
  it('messages[0] 是 system，第二条 user 带词与义项上下文', () => {
    const msgs = buildExampleMessages('abandon', sense);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('abandon');
    expect(msgs[1].content).toContain('放弃，抛弃');
  });

  it('无词性时不出现空括号', () => {
    const prompt = buildExampleUserPrompt('abandon', { ...sense, pos: '' });
    expect(prompt).not.toContain('词性：');
    expect(prompt).toContain('abandon');
  });
});

describe('parseExampleReply', () => {
  it('标准一行 JSON', () => {
    expect(parseExampleReply('{"en": "They had to abandon the plan.", "zh": "他们不得不放弃这个计划。"}')).toEqual({
      en: 'They had to abandon the plan.',
      zh: '他们不得不放弃这个计划。',
    });
  });

  it('带代码围栏也能解析', () => {
    const raw = '```json\n{"en": "She abandoned hope.", "zh": "她放弃了希望。"}\n```';
    expect(parseExampleReply(raw)).toEqual({ en: 'She abandoned hope.', zh: '她放弃了希望。' });
  });

  it('JSON 前后有废话也能解析（截取第一个 { 到最后一个 }）', () => {
    const raw = '好的，这是例句：\n{"en": "He abandoned his post.", "zh": "他离开了岗位。"}\n希望有用！';
    expect(parseExampleReply(raw)).toEqual({ en: 'He abandoned his post.', zh: '他离开了岗位。' });
  });

  it('多行 JSON 字段也能解析', () => {
    const raw = '{\n  "en": "Never abandon your dream.",\n  "zh": "永远不要放弃你的梦想。"\n}';
    expect(parseExampleReply(raw)).toEqual({ en: 'Never abandon your dream.', zh: '永远不要放弃你的梦想。' });
  });

  it('缺字段 / 空字段 / 非字符串 → null', () => {
    expect(parseExampleReply('{"en": "Only en."}')).toBeNull();
    expect(parseExampleReply('{"en": "", "zh": "有空串"}')).toBeNull();
    expect(parseExampleReply('{"en": 42, "zh": 42}')).toBeNull();
  });

  it('完全不是 JSON / 空内容 → null', () => {
    expect(parseExampleReply('Sorry, I cannot help.')).toBeNull();
    expect(parseExampleReply('')).toBeNull();
  });

  it('英文内部多余空白被压成单空格', () => {
    const raw = '{"en": "They  had   to abandon it.", "zh": "他们不得不放弃它。"}';
    expect(parseExampleReply(raw)?.en).toBe('They had to abandon it.');
  });

  it('子义项提示词：zhOverride 只带单条意思（用户 2026-10-23 逗号拆分）', () => {
    const msgs = buildExampleMessages('abandon', sense, '放弃');
    expect(msgs[1].content).toContain('义项释义：放弃');
    expect(msgs[1].content).not.toContain('抛弃'); // 不带兄弟义项
  });

  it('不传 zhOverride 时仍用整条释义（兼容旧调用）', () => {
    const msgs = buildExampleMessages('abandon', sense);
    expect(msgs[1].content).toContain('义项释义：放弃，抛弃');
  });
});

describe('splitSenseZh（义项按逗号/分号/顿号拆子义项）', () => {
  it('中文逗号拆开并去空白', () => {
    expect(splitSenseZh('放弃，抛弃')).toEqual(['放弃', '抛弃']);
  });

  it('中英逗号/分号/顿号混用也拆', () => {
    expect(splitSenseZh('放弃, 抛弃；离弃、遗弃')).toEqual(['放弃', '抛弃', '离弃', '遗弃']);
  });

  it('单条意思原样返回（拆不出多条时长度 1，调用方按整条处理）', () => {
    expect(splitSenseZh('放弃')).toEqual(['放弃']);
  });

  it('空串/纯分隔符 ⇒ 空数组', () => {
    expect(splitSenseZh('')).toEqual([]);
    expect(splitSenseZh('，；、')).toEqual([]);
  });
});
