/**
 * gen-seed-sql.mjs —— 部署期词库播种 SQL 生成器（一次性工具，不进构建）。
 * 读 src/data/seed/seed-cet6.json（ECDICT 全量裁剪，5407 六级词），
 * 生成分批 INSERT（words + book_words），owner_id 暂挂 system_seed，
 * 用户注册后由主理人用 UPDATE 改归真实 uid。
 *
 *   node deploy/gen-seed-sql.mjs
 * 输出：deploy/sql/04_seed_words_*.sql（每批 CHUNK 条）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/seed/seed-cet6.json'), 'utf-8'));
const OUT_DIR = path.join(ROOT, 'deploy/sql');
const CHUNK = 2000; // 每批行数，避免单条 SQL 过大
const BOOK_ID = 'book_cet6_full';
const LIST_SIZE = 50;
const OWNER = 'system_seed';

const j = (v) => `$J$${JSON.stringify(v)}$J$::jsonb`;
const s = (v) => v === undefined || v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const n = (v) => (Number(v) || 0);

const wordRows = SEED.map((w) =>
  `(${s('word_' + w.lemma)}, ${s(OWNER)}, ${s(w.lemma)}, ${s(w.ipa)}, NULL, ${j(w.translation ? [w.translation] : [])}, ${j([])}, ${n(w.frq)}, ${j(w.tags)})`
);
const bookWordRows = SEED.map((w, idx) => {
  const tier = idx < SEED.length * 0.25 ? 2 : idx < SEED.length * 0.6 ? 3 : 4;
  return `(${s(`bw_${BOOK_ID}_${w.lemma}`)}, ${s(OWNER)}, ${s(BOOK_ID)}, ${s('word_' + w.lemma)}, ${Math.floor(idx / LIST_SIZE) + 1}, ${(idx % LIST_SIZE) + 1}, ${tier}, ${s(new Date().toISOString())}, 'normal')`;
});

let fileNo = 0;
const emit = (name, rows, header) => {
  for (let i = 0; i < rows.length; i += CHUNK) {
    fileNo += 1;
    const part = rows.slice(i, i + CHUNK).join(',\n');
    const sql = `${header}\n${part}\nON CONFLICT (id) DO NOTHING;`;
    fs.writeFileSync(path.join(OUT_DIR, `04_seed_${name}_${String(fileNo).padStart(2, '0')}.sql`), sql, 'utf-8');
  }
};

emit('words', wordRows, `INSERT INTO words (id, owner_id, lemma, ipa, pos, senses, examples, frequency, tags) VALUES`);
emit('book_words', bookWordRows, `INSERT INTO book_words (id, owner_id, "bookId", "wordId", "listNo", "orderInList", tier, "tierUpdatedAt", status) VALUES`);

// books 表主行
fs.writeFileSync(
  path.join(OUT_DIR, '04_seed_books.sql'),
  `INSERT INTO books (id, owner_id, "userId", name, source, "wordCount", "tierCount", "listSize", status, "createdAt")\nVALUES (${s(BOOK_ID)}, ${s(OWNER)}, ${s(OWNER)}, '六级全量', 'builtin', ${SEED.length}, 4, ${LIST_SIZE}, 'active', now())\nON CONFLICT (id) DO NOTHING;`,
  'utf-8',
);

const files = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith('04_seed_') && f.endsWith('.sql'));
console.log(`seed=${SEED.length} words; generated ${files.length} SQL files in deploy/sql/`);
