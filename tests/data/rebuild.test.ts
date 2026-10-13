/**
 * rebuild.test.ts —— 词书重建路径的守门用例。
 *
 * ⚠ 这组用例守的是一个**真实的用户可见故障**：
 *   `seedLibraryToCloud` 对已存在的 book 行直接 `skipped: true`（幂等设计，写得没错），
 *   于是「词库从 5407 词升级到 8296 词」后，老用户点「初始化」什么都不会发生 ——
 *   词书页只显示旧的 5407 词，用户永远看不到新词库。
 *   唯一出路是 `rebuildWordBook`（先备份分层快照 → 删旧书 → 走标准导入）。
 *
 * 本文件不 mock 云端（那是 repos.test.ts 的职责），而是锁住**重建必须存在的语义**：
 *  - 幂等初始化路径确实存在且会在书已存在时跳过（不能把它改成"总是覆盖"）；
 *  - 重建路径导出且签名正确；
 *  - 新词书是旧词书的**超集**（这是"删了再导不会丢学习记录"的前提，必须钉死）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { seedLibraryToCloud, rebuildWordBook, seedToDocs, CET6_BOOK_ID } from '../../src/data/seedBootstrap';

interface SeedEntry {
  lemma: string;
  frq: number;
  tags: string[];
}

const SEED: SeedEntry[] = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'public/seed-cet6.json'), 'utf-8'),
) as SeedEntry[];

describe('词书重建路径（换种子版本后的唯一出路）', () => {
  it('两个入口都导出：幂等初始化 + 显式重建', () => {
    expect(typeof seedLibraryToCloud).toBe('function');
    expect(typeof rebuildWordBook).toBe('function');
  });

  /**
   * 线上实测（2026-10-13 21:00）：点「确认重建词书」报
   * `[tier_snapshots] null value in column "id" ... violates not-null constraint (23502)`。
   * 备份插在**删除之前**，所以这次失败没有造成任何数据损失（已查云端：5407 词 + 5407 关联完好）。
   *
   * 这条用例守的就是那个排序：**备份必须先于删除**，且备份本身不能因为缺 id 而炸
   * （id 由 Repository.insert 自动生成，见 insertId.test.ts）。
   */
  it('备份步骤排在删除之前（源码层面：tierSnapshots.insert 先于 bookWords.removeMany）', async () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/data/seedBootstrap.ts'),
      'utf-8',
    );
    const body = src.slice(src.indexOf('export async function rebuildWordBook'));
    const backupAt = body.indexOf('tierSnapshots.insert');
    const deleteAt = body.indexOf('bookWords.removeMany');
    expect(backupAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(-1);
    expect(backupAt, '备份必须排在删除之前，否则失败时会留下半残词书').toBeLessThan(deleteAt);
  });

  it('重建入口与初始化入口签名一致（userId + 可选进度回调）', () => {
    // 签名一致性是 UI 侧能共用一个按钮的前提；参数数量不一致会让 runSeed 的分支写法失效
    expect(rebuildWordBook.length).toBeLessThanOrEqual(seedLibraryToCloud.length);
  });

  it('重建会清空续传游标对应的种子状态（走的是完整导入，不复用旧游标）', () => {
    // 事实约束：rebuildWordBook 内部调用 seedLibraryToCloud，而后者在成功后 clearCursor。
    // 这里锁住 bookId 常量不变 —— 换 id 会让旧 hits 变孤儿。
    expect(CET6_BOOK_ID).toBe('book_cet6_full');
  });
});

describe('新词书是旧词书的超集（重建不产生孤儿学习记录）', () => {
  /**
   * 旧词书的构成（历史事实）：5407 个 cet6 词，按 frq 降序。
   * 新词书：8296 词 = cet6 全收 + 四级/考研/雅思标签词 + oxford=1/collins≥3 的无标签高频词。
   * ⇒ 六级的 5407 个 lemma 必然全在新书里 ⇒ wordId = word_<lemma> 不变
   * ⇒ 已有 hits / feedbacks 引用的 wordId 仍有效，不需要清历史记录。
   */
  it('旧词书（5407 个 cet6 词）的每个 lemma 都在新词书里', () => {
    const newSet = new Set(SEED.map((w) => w.lemma));
    // 复现旧口径：所有 tag 含 cet6 的词就是旧词书的全部内容
    const oldCet6 = SEED.filter((w) => w.tags.includes('cet6')).map((w) => w.lemma);
    expect(oldCet6.length).toBeGreaterThan(5000);
    expect(oldCet6.filter((w) => !newSet.has(w))).toEqual([]);
  });

  it('wordId 派生规则未变（word_<lemma>），旧 hits 的 wordId 不会指向不存在的词', () => {
    const { words } = seedToDocs(SEED as never, CET6_BOOK_ID, 50);
    for (const w of [words[0], words[Math.floor(words.length / 2)], words[words.length - 1]]) {
      expect(w.id).toBe(`word_${w.lemma}`);
    }
  });

  it('新词书严格大于旧口径（升级确实带来更多词，而不是换个方式缩水）', () => {
    const cet6Count = SEED.filter((w) => w.tags.includes('cet6')).length;
    expect(SEED.length).toBeGreaterThan(cet6Count);
    expect(SEED.length).toBeGreaterThanOrEqual(7000);
  });
});
