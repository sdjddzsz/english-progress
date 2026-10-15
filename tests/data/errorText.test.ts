/**
 * errorText.test.ts —— 云端错误 → 中文可读提示（用户 2026-10-15：界面不许甩英文 PGRST 原句）。
 * 背景：线上 book_words 缺 quizDayPassed 等列（PGRST204），直写必失败；
 * 这条链路 2026-10-15 起改走 runOrQueue，本测试钉死「真缺列」与「普通错误」两条分支。
 */
import { describe, expect, it } from 'vitest';
import { describeWriteError } from '../../src/data/errorText';

describe('describeWriteError：PGRST204 缺列 → 可执行中文提示', () => {
  it('抽出列名并说明是数据库缺列、附去向', () => {
    const msg =
      "[book_words] Could not find the 'quizDayPassed' column of 'book_words' in the schema cache (code=DATABASE_PGRST204)";
    const out = describeWriteError(new Error(msg));
    expect(out).toContain('quizDayPassed');
    expect(out).toContain('数据库缺列');
    expect(out).toContain('交接文档');
  });

  it('双引号列名也认得', () => {
    const out = describeWriteError(new Error('Could not find the "streak" column of book_words'));
    expect(out).toContain('streak');
  });
});

describe('describeWriteError：非缺列错误原样透传', () => {
  it('网络错误不翻译成缺列话术', () => {
    const out = describeWriteError(new Error('Failed to fetch'));
    expect(out).toBe('Failed to fetch');
  });
  it('非 Error 入参也安全', () => {
    expect(describeWriteError('boom')).toBe('boom');
  });
});
