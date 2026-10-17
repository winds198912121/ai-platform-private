/* ============================================================
   generate_ddl.test.mjs — 决定論的 DDL ジェネレータのテスト
   运行：AI_PLATFORM_SPEED=0 node --test test/generate_ddl.test.mjs
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const { convert, generate } = await import('../tools/generate_ddl.mjs');

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `aip-ddl-${tag}-`));

/* ---------- convert() — 1 つの spec を SQL 文字列に ---------- */

test('convert: 最小 spec（主キー 1 列）', () => {
  const sql = convert({ table: 'sample', columns: { id: { type: 'varchar', length: 10, pk: true } } });
  assert.match(sql, /CREATE TABLE sample \(/);
  assert.match(sql, /id varchar\(10\) PRIMARY KEY/);
  assert.match(sql, /\bDO NOT EDIT\b/);
  assert.match(sql, /\bgenerated:\s/);
});

test('convert: 多列主キーは別行の PRIMARY KEY 制約', () => {
  const sql = convert({
    table: 'rel', columns: {
      a: { type: 'varchar', length: 5, pk: true },
      b: { type: 'varchar', length: 5, pk: true },
      c: { type: 'varchar', length: 5 },
    },
  });
  assert.match(sql, /a varchar\(5\),/);
  assert.match(sql, /b varchar\(5\),/);
  assert.match(sql, /PRIMARY KEY \(a, b\)/, '複数列 PK は table-level 制約として出す');
});

test('convert: FOREIGN KEY', () => {
  const sql = convert({
    table: 'child', columns: {
      id: { type: 'varchar', length: 10, pk: true },
      parent_id: { type: 'varchar', length: 10, notNull: true, fk: { table: 'parent', column: 'id' } },
    },
  });
  assert.match(sql, /parent_id varchar\(10\) NOT NULL REFERENCES parent\(id\)/);
});

test('convert: デフォルト値（数値・文字列・真偽・関数）', () => {
  const sql = convert({
    table: 't', columns: {
      id: { type: 'bigint', pk: true, default: 0 },
      flag: { type: 'boolean', default: true },
      note: { type: 'varchar', length: 20, default: 'pending' },
      created_at: { type: 'timestamptz', default: 'NOW()' },
    },
  });
  assert.match(sql, /id bigint DEFAULT 0 PRIMARY KEY/);
  assert.match(sql, /flag boolean DEFAULT TRUE/);
  assert.match(sql, /note varchar\(20\) DEFAULT 'pending'/);
  assert.match(sql, /created_at timestamptz DEFAULT NOW\(\)/);
});

test('convert: COMMENT は別文で出す', () => {
  const sql = convert({ table: 'cmt', columns: { id: { type: 'int', pk: true } }, comment: 'コメント' });
  assert.match(sql, /COMMENT ON TABLE cmt IS 'コメント';/);
});

test('convert: 単一/複合ユニーク・非ユニーク INDEX', () => {
  const sql = convert({
    table: 'ix', columns: { id: { type: 'int', pk: true } },
    indexes: [
      { name: 'IX1', columns: ['id'], unique: true },
      { name: 'IX2', columns: ['id'] },
    ],
  });
  assert.match(sql, /CREATE UNIQUE INDEX IX1 ON ix \(id\);/);
  assert.match(sql, /CREATE INDEX IX2 ON ix \(id\);/);
});

test('convert: 不正な型は例外', () => {
  assert.throws(() => convert({ table: 'bad', columns: { id: { type: 'foobar', pk: true } } }), /unknown type/);
});

test('convert: 不正なテーブル名は例外（大文字・ハイフン）', () => {
  assert.throws(() => convert({ table: 'UpperCase', columns: { id: { type: 'int', pk: true } } }), /スネークケース/);
  assert.throws(() => convert({ table: 'has-dash', columns: { id: { type: 'int', pk: true } } }), /スネークケース/);
});

test('convert: 必須フィールド欠落で例外', () => {
  assert.throws(() => convert({}), /table is required/);
  assert.throws(() => convert({ table: '', columns: {} }), /table is required/);
});

/* ---------- generate() — ディレクトリ → ファイル群 ---------- */

test('generate: schema ディレクトリを走査して .sql を出す（テーブル名でソート）', () => {
  const schema = tmp('schema');
  const out = tmp('out');
  // 意図的に逆順で書く → 出力は sorted
  fs.writeFileSync(path.join(schema, 'zeta.json'), JSON.stringify({ table: 'zeta', columns: { id: { type: 'int', pk: true } } }));
  fs.writeFileSync(path.join(schema, 'alpha.json'), JSON.stringify({ table: 'alpha', columns: { id: { type: 'int', pk: true } } }));
  const r = generate(schema, out);
  assert.equal(r.count, 2);
  const files = fs.readdirSync(out).sort();
  assert.deepEqual(files, ['alpha.sql', 'zeta.sql']);
  assert.ok(fs.readFileSync(path.join(out, 'alpha.sql'), 'utf8').includes('CREATE TABLE alpha'));
  assert.ok(fs.readFileSync(path.join(out, 'zeta.sql'), 'utf8').includes('CREATE TABLE zeta'));
});

test('generate: 配列 JSON を複数の spec に展開', () => {
  const schema = tmp('arr');
  const out = tmp('outarr');
  fs.writeFileSync(path.join(schema, 'pair.json'), JSON.stringify([
    { table: 'p_a', columns: { id: { type: 'int', pk: true } } },
    { table: 'p_b', columns: { id: { type: 'int', pk: true } } },
  ]));
  const r = generate(schema, out);
  assert.equal(r.count, 2);
  const files = fs.readdirSync(out).sort();
  assert.deepEqual(files, ['p_a.sql', 'p_b.sql']);
});

test('generate: 不正 JSON はエラーで落ちる', () => {
  const schema = tmp('bad');
  const out = tmp('badout');
  fs.writeFileSync(path.join(schema, 'bad.json'), '{ this is not json');
  assert.throws(() => generate(schema, out), /invalid JSON/);
});

test('generate: スキーマ dir が無いとエラー', () => {
  assert.throws(() => generate('/no/such/dir', '/tmp/x'), /not found/);
});

test('generate: schema_dir 直下に table フィールドが無い spec はエラー', () => {
  const schema = tmp('notable');
  const out = tmp('notableout');
  fs.writeFileSync(path.join(schema, 'junk.json'), JSON.stringify({ foo: 'bar' }));
  assert.throws(() => generate(schema, out), /must have "table"/);
});

test('generate: 既存出力は上書き（決定論）', () => {
  const schema = tmp('idem');
  const out = tmp('idemout');
  fs.writeFileSync(path.join(schema, 't.json'), JSON.stringify({ table: 't', columns: { id: { type: 'int', pk: true } } }));
  const r1 = generate(schema, out);
  const r2 = generate(schema, out);
  const a = fs.readFileSync(r1.files[0], 'utf8');
  const b = fs.readFileSync(r2.files[0], 'utf8');
  // `generated: <date>` だけが毎回違う、置換して完全一致
  const norm = (s) => s.replace(/generated: [^\n]+/, 'generated: <fixed>');
  assert.equal(norm(a), norm(b), 'generated 行以外が完全一致（決定論）');
});

test('generate: SHM_SYARYO の交通局案件サンプル（現実データ）', () => {
  // レビュー §6.5 で言及した代表テーブル
  const schema = tmp('sample');
  const out = tmp('sampleout');
  fs.writeFileSync(path.join(schema, 'SHM_SYARYO.json'), JSON.stringify({
    table: 'shm_syaryo',
    comment: '車両台帳',
    columns: {
      syaryo_no:  { type: 'varchar', length: 10, pk: true, comment: '車両番号' },
      syasyu_cd:  { type: 'varchar', length: 6,  notNull: true, fk: { table: 'mss_syasyu', column: 'syasyu_cd' }, comment: '車種コード' },
      nyusya_ymd: { type: 'date',    notNull: true, comment: '入社年月日' },
      haisya_ymd: { type: 'date',    comment: '廃車年月日' },
      version:    { type: 'bigint',  notNull: true, default: 1, comment: '楽観ロック' },
    },
    indexes: [{ name: 'SHM_SYARYO_UK1', columns: ['syasyu_cd'], unique: true }],
  }));
  const r = generate(schema, out);
  const sql = fs.readFileSync(r.files[0], 'utf8');
  assert.match(sql, /COMMENT ON TABLE shm_syaryo IS '車両台帳';/);
  assert.match(sql, /syaryo_no varchar\(10\) PRIMARY KEY/);
  assert.match(sql, /syasyu_cd varchar\(6\) NOT NULL REFERENCES mss_syasyu\(syasyu_cd\)/);
  assert.match(sql, /version bigint NOT NULL DEFAULT 1/);
  assert.match(sql, /CREATE UNIQUE INDEX SHM_SYARYO_UK1 ON shm_syaryo \(syasyu_cd\);/);
});
