/* TypeScript 档案（NestJS / Next.js / PostgreSQL）：真 package.json + npm install + tsx/node --test，
   PostgreSQL は Docker で起動、無ければ skipped を明示（合格扱いにしない）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const exec = await import('../exec.mjs');
const G = await import('../governance.mjs');
const sim = await import('../sim.mjs');

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `aipf-${tag}-`));
const write = (root, rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};

test('栈档案：Nest / Next.js / PostgreSQL 宣言 → TS 档案（依存あり）；素の TypeScript・Java・Python は従来どおり', () => {
  for (const s of ['Next.js + NestJS + PostgreSQL 16', 'NestJS 10 + PostgreSQL', 'Next.js 14 (App Router)', 'Node.js 22 + PostgreSQL']) {
    const p = exec.profileOf(s);
    assert.equal(p.id, 'ts-node', s);
    assert.ok(p.deps, `${s}: 依存を入れる档案`);
  }
  assert.equal(exec.profileOf('Next.js + NestJS + PostgreSQL').ext, '.ts');
  assert.equal(exec.profileOf('React + Vite + TypeScript 静态站').id, 'node');
  assert.equal(exec.profileOf('Java 21 + Spring Boot 3.3 + PostgreSQL 16').id, 'java');
  assert.equal(exec.profileOf('Python 3.12 + FastAPI + PostgreSQL').id, 'python');
  assert.equal(exec.profileOf('Node.js 22 + Fastify + SQLite').id, 'node');
});

test('package.json：基線依存 + 許可リストで篩う（版は平台固定、リスト外は拒否）、tsconfig も用意', () => {
  const root = tmp('pkg');
  const r = exec.ensurePackageJson(root, { stack: 'Next.js + NestJS + PostgreSQL 16', deps: ['zod@^1.0.0', 'left-pad', 'pg'] });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@nestjs/common'], exec.NPM_ALLOW['@nestjs/common']);
  assert.equal(pkg.dependencies.pg, exec.NPM_ALLOW.pg, 'PostgreSQL 宣言 → pg');
  assert.equal(pkg.dependencies.zod, exec.NPM_ALLOW.zod, 'モデルが書いた版指定は捨てて平台の版');
  assert.equal(pkg.devDependencies.tsx, exec.NPM_ALLOW.tsx);
  assert.deepEqual(r.rejected, ['left-pad']);
  assert.ok(!pkg.dependencies['left-pad'] && !pkg.devDependencies['left-pad']);
  const ts = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
  assert.ok(ts.compilerOptions.experimentalDecorators && ts.compilerOptions.emitDecoratorMetadata, 'Nest のデコレータ');

  const again = exec.ensurePackageJson(root, { deps: ['class-validator'] });
  assert.deepEqual(again.added, ['class-validator'], '既存 package.json には追記のみ（基線は再追加しない）');
});

test('npm install：package.json に許可リスト外があれば install せずに失敗；npm が無ければ明示失敗', async () => {
  const root = tmp('pkgbad');
  write(root, 'package.json', JSON.stringify({ name: 'x', private: true, dependencies: { 'evil-pkg': '1.0.0' } }));
  const r = await exec.npmInstall(root);
  assert.equal(r.ok, false);
  assert.match(r.why, /outside the allowlist: evil-pkg/);

  await withEnv({ AI_PLATFORM_NO_NPM: '1' }, async () => {
    const t = await exec.runTs(tmp('nonpm'), 'test/');
    assert.equal(t.ok, false);
    assert.match(t.tail, /npm missing/);
    assert.match(t.tail, /do NOT silently fall back/);
  });
});

test('PostgreSQL：Docker が無ければ skipped（理由付き）、あれば postgres:16 を起動して DATABASE_URL を返す', async () => {
  await withEnv({ AI_PLATFORM_NO_DOCKER: '1', AI_PLATFORM_DATABASE_URL: undefined }, async () => {
    const r = await exec.ensurePostgres(tmp('nodocker'));
    assert.equal(r.status, 'skipped');
    assert.match(r.why, /Docker not installed/);
  });

  // 偽 docker：呼び出しを記録し、info/run/exec(pg_isready)/port に成功で応える
  const bin = tmp('fakedocker');
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  info) echo 27.0.0 ;;
  inspect) exit 1 ;;
  run) echo cafebabe ;;
  port) echo 127.0.0.1:55432 ;;
esac
exit 0
`, { mode: 0o755 });
  const root = tmp('pgws');
  await withEnv({ AI_PLATFORM_NO_DOCKER: undefined, AI_PLATFORM_DATABASE_URL: undefined, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, async () => {
    const r = await exec.ensurePostgres(root);
    assert.equal(r.status, 'ready', JSON.stringify(r));
    assert.equal(r.url, 'postgres://aip:aip@127.0.0.1:55432/app');
    assert.match(r.image, /^postgres:16/);
    const calls = fs.readFileSync(log, 'utf8');
    assert.match(calls, /^run -d --name aip-pg-\w+ .*postgres:16/m, '工作区専用コンテナを起動');
    assert.match(calls, /^exec aip-pg-\w+ pg_isready/m, '起動待ち');
    exec.stopPostgres(root);
    assert.match(fs.readFileSync(log, 'utf8'), /^rm -f aip-pg-\w+$/m, '工作区削除時に片付け');
  });
});

test('needsPostgres：pg 依存かテストの DATABASE_URL 参照で判定', () => {
  const a = tmp('needs');
  write(a, 'package.json', JSON.stringify({ dependencies: { pg: '^8' } }));
  assert.equal(exec.needsPostgres(a), true);
  const b = tmp('needs2');
  write(b, 'package.json', JSON.stringify({ dependencies: {} }));
  write(b, 'test/x.test.ts', 'test("a", () => {});');
  assert.equal(exec.needsPostgres(b), false);
  write(b, 'test/y.test.ts', 'if (process.env.DATABASE_URL) {}');
  assert.equal(exec.needsPostgres(b), true);
});

test('テスト集計：node --test / jest / vitest の出力', () => {
  assert.deepEqual(exec.parseTestCounts('ℹ tests 3\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n'), { passed: 2, failed: 0, skipped: 1 });
  assert.deepEqual(exec.parseTestCounts('Tests:       1 failed, 1 skipped, 3 passed, 5 total\n'), { passed: 3, failed: 1, skipped: 1 });
  assert.deepEqual(exec.parseTestCounts('      Tests  2 passed | 1 skipped (3)\n'), { passed: 2, failed: 0, skipped: 1 });
});

test('真実行（npm install + tsx + node --test）：Docker 無しでは DB テストが skipped と記録され、合格に数えない', async (t) => {
  const root = tmp('tsrun');
  const mod = sim.moduleCode({ tech: 'Next.js + NestJS + PostgreSQL 16', name: 't', wbs: { epics: [] }, modules: [] },
    { id: 'M1', name: 'Inventory', layer: 'domain', dir: 'src/domain', test_path_planned: 'test/domain/inventory.test.ts' });
  assert.ok(mod.files.every(f => f.path.endsWith('.ts')) && mod.test.path.endsWith('.ts'), 'オフライン生成も .ts');
  assert.deepEqual(mod.deps, ['pg', '@types/pg']);
  exec.writeFiles(root, [...mod.files, mod.test]);
  exec.ensurePackageJson(root, { stack: 'Next.js + NestJS + PostgreSQL 16', deps: mod.deps });

  await withEnv({ AI_PLATFORM_NO_DOCKER: '1', AI_PLATFORM_DATABASE_URL: undefined, DATABASE_URL: 'postgres://should-not-leak/x' }, async () => {
    const r = await exec.runTests(root, mod.test.path, exec.profileOf('Next.js + NestJS + PostgreSQL 16'));
    if (r.install && !r.install.ok) { t.skip(`npm install unavailable here: ${String(r.install.why).slice(0, 120)}`); return; }
    assert.equal(r.ok, true, r.tail);
    assert.equal(r.passed, 2);
    assert.equal(r.skipped, 1, 'PostgreSQL ケースは skip（継承した DATABASE_URL は使わない）');
    assert.equal(r.total, 2, 'skipped は total に入れない');
    assert.equal(r.db.status, 'skipped');
    assert.match(r.tail, /NOT counted as passed/);
    assert.match(r.cmd, /node --import tsx --test/);

    // 2 回目：package.json 不変 → install はキャッシュ
    write(root, mod.test.path, fs.readFileSync(path.join(root, mod.test.path), 'utf8').replace("qty: 5 });\n  assert.equal", "qty: 6 });\n  assert.equal"));
    const bad = await exec.runTests(root, mod.test.path, exec.profileOf('Next.js + NestJS + PostgreSQL'));
    assert.equal(bad.install.cached, true, 'install はキャッシュされる');
    assert.equal(bad.ok, false, '断言失敗は失敗');
    assert.equal(bad.failed, 1);

    // DB ケースしか無いのに Docker が無い → 何も合格していない → 緑にしない
    write(root, mod.test.path, "import { test } from 'node:test';\ntest('db only', { skip: !process.env.DATABASE_URL && 'PostgreSQL unavailable' }, () => {});\n");
    const onlyDb = await exec.runTests(root, mod.test.path, exec.PROFILES.ts);
    assert.equal(onlyDb.ok, false, 'skip だけでは合格にならない');
    assert.equal(onlyDb.passed, 0);

    const ws = await exec.runWorkspaceTests(root);
    assert.equal(ws.db.status, 'skipped', 'ワークスペース集計にも DB 状況が載る');
  });
});

test('技能割当：Nest / Next.js 系は専用プリセット dev-nestjs-nextjs-postgres、他の言語別規約は外す', () => {
  const plan = G.skillPlanFor(['development'], 'Next.js + NestJS + PostgreSQL');
  assert.ok(plan.development.checklist.includes('dev-nestjs-nextjs-postgres'));
  assert.ok(plan.development.exclude.includes('dev-nodejs'));
  assert.ok(!plan.development.exclude.includes('dev-nestjs-nextjs-postgres'));
  assert.equal(G.planRole('dev-nestjs-nextjs-postgres'), 'checklist');
});
