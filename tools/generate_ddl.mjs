#!/usr/bin/env node
/* ============================================================
   generate_ddl.mjs — データ仕様 JSON を PostgreSQL DDL に変換する。
   目的：交通局案件 §6.5 / レビュー §5 で挙げた「データ定義 → DDL を
   ジェネレートで作り、LLM に書かせない」を実現する最小 CLI。
   設計判断（決めるべきことをここで固定）：
     - LLM を使わない（決定論的、CI で差分検出できる）
     - 入力は JSON（TS の export default をパースする依存を入れたくなかったので）
       既存スキル `dev-nestjs-nextjs-postgres` が tsx を使う前提だが、
       この CLI は別途呼ばれてもよい独立ツール
     - 出力は生成物なのでファイル冒頭に必ず `-- DO NOT EDIT — regenerate via…`
       と焼き込む（手で直したのを git diff で検知するため）
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';

const PG_TYPES = new Set([
  'varchar', 'char', 'text', 'int', 'integer', 'bigint', 'smallint',
  'numeric', 'decimal', 'real', 'double precision',
  'date', 'time', 'timestamp', 'timestamptz',
  'boolean', 'bool',
  'uuid', 'jsonb', 'json', 'bytea',
]);

/** 1 つの spec オブジェクト → 1 つの CREATE TABLE + COMMENT + INDEX 群 */
export function convert(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('spec must be an object');
  const tname = String(spec.table || '').trim();
  if (!tname) throw new Error('spec.table is required');
  if (!/^[a-z][a-z0-9_]*$/.test(tname)) throw new Error(`spec.table "${tname}" はスネークケース小文字必須`);
  const cols = spec.columns || {};
  const colDefs = [];
  const pkCols = [];
  const colComments = [];
  for (const [cname, c] of Object.entries(cols)) {
    if (!/^[a-z][a-z0-9_]*$/.test(cname)) throw new Error(`column "${cname}" はスネークケース小文字必須`);
    if (!c || typeof c !== 'object') throw new Error(`column ${cname} must be object`);
    const type = String(c.type || '').toLowerCase();
    if (!PG_TYPES.has(type)) throw new Error(`column ${cname}: unknown type "${c.type}"`);
    let typeStr = type;
    if (c.length != null) typeStr += `(${c.length})`;
    else if (c.precision != null && c.scale != null) typeStr += `(${c.precision},${c.scale})`;
    const parts = [cname, typeStr];
    if (c.notNull) parts.push('NOT NULL');
    if (c.default != null) parts.push(`DEFAULT ${formatDefault(c.default, type)}`);
    if (c.fk) {
      const fk = c.fk;
      if (!fk.table || !fk.column) throw new Error(`column ${cname}.fk needs {table, column}`);
      parts.push(`REFERENCES ${fk.table}(${fk.column})`);
    }
    if (c.pk) pkCols.push(cname);
    if (c.primaryKey) pkCols.push(cname);                      // alias
    colDefs.push('  ' + parts.join(' '));
    if (c.comment) colComments.push({ cname, text: c.comment, table: tname });
  }
  if (pkCols.length === 1) colDefs[0] = colDefs[0] + ' PRIMARY KEY';
  // multi-column PK gets a separate constraint
  const conPk = pkCols.length > 1 ? [`  PRIMARY KEY (${pkCols.join(', ')})`] : [];
  const body = [
    `CREATE TABLE ${tname} (`,
    ...colDefs.join(',\n').split('\n'),
    ...conPk,
    ');',
  ].join('\n');
  // COMMENT
  const cmts = [];
  if (spec.comment) cmts.push(`COMMENT ON TABLE ${tname} IS ${quoteSql(spec.comment)};`);
  for (const { cname, text, table } of colComments) cmts.push(`COMMENT ON COLUMN ${table}.${cname} IS ${quoteSql(text)};`);
  // indexes
  const idx = [];
  if (Array.isArray(spec.indexes)) for (const ix of spec.indexes) {
    if (!ix || !ix.name || !Array.isArray(ix.columns) || ix.columns.length === 0) throw new Error(`index must have {name, columns[]}`);
    const kind = ix.unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
    idx.push(`${kind} ${ix.name} ON ${tname} (${ix.columns.join(', ')});`);
  }
  // header — burn the source spec path & timestamp in for git diff sanity
  const src = spec._source ? `-- from: ${spec._source}\n` : '';
  const head = [
    src,
    `-- DO NOT EDIT — regenerate via: node tools/generate_ddl.mjs <schema_dir> -o <out_dir>`,
    `-- generated: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  return [head, body, ...cmts, ...idx].filter(Boolean).join('\n') + '\n';
}

function formatDefault(v, type) {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') {
    const upper = v.toUpperCase();
    if (/^(NOW|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NULL|TRUE|FALSE|GEN_RANDOM_UUID|UUID_GENERATE_V4\(\))/.test(upper)) return v;
    if (/^\$\{.+\}$/.test(v)) return v;                          // ${fn()} などの式プレースホルダ
    return quoteSql(v);
  }
  throw new Error(`unsupported default value: ${v} (type ${type})`);
}

function quoteSql(s) { return `'${String(s).replace(/'/g, "''")}'`; }

/** ディレクトリを再帰で舐め、`*.json`（先頭が `{`）を spec として変換する。
 *  spec が配列なら各要素、spec.table のあるオブジェクトをそのまま取り扱う。
 *  出力先に同名ファイルがあれば上書き（決定論的生成）。
 */
export function generate(schemaDir, outDir) {
  const absSchema = path.resolve(schemaDir);
  const absOut = path.resolve(outDir || 'migrations');
  if (!fs.existsSync(absSchema)) throw new Error(`schema dir not found: ${absSchema}`);
  fs.mkdirSync(absOut, { recursive: true });
  const specs = [];
  walk(absSchema, (file) => {
    if (!file.endsWith('.json')) return;
    const text = fs.readFileSync(file, 'utf8');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new Error(`invalid JSON in ${file}: ${e.message}`); }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const s of arr) {
      if (!s || typeof s !== 'object' || !s.table) throw new Error(`${file}: spec must have "table"`);
      s._source = path.relative(process.cwd(), file);
      specs.push(s);
    }
  });
  // 安定順序：テーブル名でソート（生成物の diff が安定するように）
  specs.sort((a, b) => a.table.localeCompare(b.table));
  const written = [];
  for (const s of specs) {
    const ddl = convert(s);
    const out = path.join(absOut, `${s.table}.sql`);
    fs.writeFileSync(out, ddl);
    written.push(out);
  }
  return { count: written.length, files: written };
}

function walk(dir, cb) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, cb);
    else cb(p);
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log('Usage: node tools/generate_ddl.mjs <schema_dir> [-o <out_dir>]');
    console.log('       schema_dir 配下の *.json を spec として DDL に変換し、out_dir に <table>.sql を出力');
    process.exit(args.length === 0 ? 1 : 0);
  }
  let schemaDir = args[0];
  let outDir = 'migrations';
  const oi = args.indexOf('-o');
  if (oi >= 0) outDir = args[oi + 1];
  try {
    const r = generate(schemaDir, outDir);
    console.log(`✓ wrote ${r.count} file(s) to ${outDir}/`);
  } catch (e) {
    console.error(`✕ ${e.message}`);
    process.exit(1);
  }
}
