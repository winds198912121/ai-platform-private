/* ============================================================
   governance.test.mjs — ゲート方針 / 要件台帳 + トレース / 依存 DAG / 段階別スキル割当
   運行：AI_PLATFORM_SPEED=0 node --test test/governance.test.mjs
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.AI_PLATFORM_SPEED = '0';
process.env.AI_PLATFORM_PROVIDER = 'sim';
process.env.AI_PLATFORM_DATA = path.join(os.tmpdir(), `ai-platform-gov-${process.pid}.json`);
process.env.AI_PLATFORM_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-gov-ws-'));
fs.rmSync(process.env.AI_PLATFORM_DATA, { force: true });

const H = await import('../harness.mjs');
const G = await import('../governance.mjs');
const agent = await import('../agent.mjs');
H.load();

const waitFor = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('waitFor timed out');
};
const stage = (p, id) => p.stages.find(s => s.id === id);
const SPEC = [
  '業務名 車両管理システム',
  'No.  表名            表ID          インデクスID     概要',
  '  5   車両台帳         SHM_SYARYO         SHM_SYARYO_PK       車両を管理する',
  '  6   車種車台台帳     SHM_SYASYU         SHM_SYASYU_PK       車種車台を管理する',
  'Jsh050 車両台帳登録',
  'Jsh230L01  整備計画一覧表',
  '外部IF IF-001 POS 64バイト固定長',
].join('\n');

/* ---------- ① ゲート方針 ---------- */

test('ゲート方針：human_gate では API 直叩き・自動化名義の承認を拒否、画面の人の承認だけ通す', () => {
  const p = { mode: 'human_gate' };
  assert.match(G.approvalViolation(p, 'requirements', 'PM', 'api'), /dashboard/);
  assert.match(G.approvalViolation(p, 'requirements', 'Auto pipeline', 'dashboard'), /looks automated/);
  assert.match(G.approvalViolation(p, 'ux', 'AI auto-approve', 'auto'), /Auto-approval refused/);
  assert.match(G.approvalViolation(p, 'ux', '', 'dashboard'), /no reviewer/);
  assert.equal(G.approvalViolation(p, 'requirements', 'Manual review', 'dashboard'), null);
  assert.equal(G.approvalViolation(p, 'requirements', 'Human', 'direct'), null);
});

test('ゲート方針：auto でも高リスク段階（既定：要件・アーキ）は人の承認必須、それ以外は自動承認可', () => {
  const p = { mode: 'auto' };
  assert.deepEqual(G.humanGatesOf(p), ['requirements', 'architecture'], '旧データ（human_gates なし）は既定');
  assert.ok(G.needsHuman(p, 'requirements') && G.needsHuman(p, 'architecture'));
  assert.ok(!G.needsHuman(p, 'ux') && !G.needsHuman(p, 'development'));
  assert.match(G.approvalViolation(p, 'architecture', 'AI auto-approve', 'auto'), /high-risk/);
  assert.equal(G.approvalViolation(p, 'ux', 'AI auto-approve', 'auto'), null);
  assert.equal(G.approvalViolation({ mode: 'auto', human_gates: [] }, 'requirements', 'x', 'auto'), null, 'human_gates:[] = 完全自動');
});

test('human_gate プロジェクト：「Auto pipeline」の API 承認は 403、ステージは承認待ちのまま・事件に残る', async () => {
  const p = H.createProject({ name: 'ゲート検証', brief: '受注登録', tech: 'Node.js' });
  await waitFor(() => stage(p, 'requirements').status === 'awaiting_review');
  assert.throws(() => H.approveStage(p, 'requirements', 'Auto pipeline', { source: 'api' }), (e) => e.status === 403);
  assert.throws(() => H.approveStage(p, 'requirements', 'Auto pipeline', { source: 'dashboard' }), (e) => e.status === 403);
  assert.equal(stage(p, 'requirements').status, 'awaiting_review');
  assert.ok(p.events.some(e => /Approval refused/.test(e.text)), '拒否も記録');
  H.approveStage(p, 'requirements', 'Manual review', { source: 'dashboard' });
  assert.equal(stage(p, 'requirements').review.source, 'dashboard', '承認の出どころを記録');
});

test('auto モード：要件で人の承認待ちに止まり、人が承認すると UI/UX は自動承認で進む', async () => {
  const p = H.createProject({ name: 'auto リスク別', brief: '受注登録。在庫引当。', tech: 'Node.js', mode: 'auto' });
  assert.deepEqual(p.human_gates, ['requirements', 'architecture']);
  await waitFor(() => stage(p, 'requirements').status === 'awaiting_review');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(stage(p, 'requirements').status, 'awaiting_review', 'auto でも勝手に承認されない');
  assert.ok(p.events.some(e => /high-risk gate/.test(e.text)));
  H.approveStage(p, 'requirements', 'PM');
  await waitFor(() => stage(p, 'ux').status === 'approved');
  assert.equal(stage(p, 'ux').review.by, 'AI auto-approve');
  await waitFor(() => stage(p, 'architecture').status === 'awaiting_review');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(stage(p, 'architecture').status, 'awaiting_review', 'アーキも人待ち');
});

test('human_gates は作成・編集で指定でき、不明な段階 ID は捨てる', () => {
  const p = H.createProject({ name: 'gates 編集', tech: 'Node.js', human_gates: ['requirements', 'nope'] });
  assert.deepEqual(p.human_gates, ['requirements']);
  H.updateProject(p, { human_gates: ['architecture', 'wbs'] });
  assert.deepEqual(p.human_gates, ['architecture', 'wbs']);
  assert.ok(p.events.some(e => /Human-required gates/.test(e.text)));
});

/* ---------- ② 要件台帳 ---------- */

test('要件台帳：全文から ID を決定的に抽出（名前は同じ行から、_PK 除外、枝番は親付き）', () => {
  const { items, scanned } = G.scanLedger([{ name: 'spec.md', text: SPEC }]);
  const by = Object.fromEntries(items.map(i => [i.id, i]));
  assert.equal(scanned.files, 1);
  assert.equal(by.SHM_SYARYO.kind, 'table');
  assert.equal(by.SHM_SYARYO.name, '車両台帳');
  assert.ok(!by.SHM_SYARYO_PK, '索引 ID は台帳に入れない');
  assert.equal(by.Jsh050.kind, 'function');
  assert.equal(by.Jsh050.name, '車両台帳登録');
  assert.equal(by.Jsh230L01.kind, 'output');
  assert.equal(by.Jsh230L01.parent, 'Jsh230');
  assert.ok(by.Jsh230, '枝番しか無い親も立てる');
  assert.equal(by['IF-001'].kind, 'interface');
  assert.deepEqual(by.Jsh050.sources[0], { file: 'spec.md', line: 5 });
});

test('要件台帳 → WBS → モジュール：req_ids でトレースされ、網羅率が出る', async () => {
  const p = H.createProject({ name: '台帳トレース', brief: '車両管理', tech: 'Node.js', files: [{ name: 'spec.md', content: SPEC }] });
  await waitFor(() => stage(p, 'requirements').status === 'awaiting_review');
  assert.ok(G.ledgerItems(p).length >= 6, `台帳 ${G.ledgerItems(p).length} 件`);
  assert.equal(stage(p, 'requirements').artifacts[0].id, 'REQ-00', '台帳が成果物の先頭');
  assert.match(stage(p, 'requirements').artifacts[0].content, /SHM_SYARYO/);
  for (const sid of ['requirements', 'ux', 'architecture']) {
    await waitFor(() => stage(p, sid).status === 'awaiting_review');
    H.approveStage(p, sid);
  }
  await waitFor(() => stage(p, 'wbs').status === 'awaiting_review');
  const cv = G.coverage(p);
  assert.equal(cv.uncovered.length, 0, `全 ID がどこかのモジュールに割当：${cv.uncovered}`);
  assert.ok(p.modules.some(m => m.req_ids.includes('SHM_SYARYO')));

  // 1 モジュールの割当を外す → WBS ゲートは承認拒否、ack 付きなら通る
  const m = p.modules.find(x => x.req_ids.length);
  const lost = m.req_ids.splice(0);
  assert.throws(() => H.approveStage(p, 'wbs'), /not assigned to any module/);
  H.approveStage(p, 'wbs', 'PM', { ackGaps: true });
  assert.ok(p.events.some(e => /uncovered ledger ID/.test(e.text)));
  m.req_ids.push(...lost);

  const tr = H.trace(p);
  assert.equal(tr.ledger.total, cv.total);
  assert.ok(tr.rows.every(r => r.status !== 'implemented'), 'まだ承認済みモジュールなし');
});

/* ---------- ③ 依存 DAG ---------- */

test('normalizeDeps：明示 deps は前方参照だけ有効、deps フィールドが無ければレイヤー順で推定', () => {
  const layers = ['core', 'domain', 'app'];
  const given = G.normalizeDeps([
    { id: 'E1', name: 'A', layer: 'core', deps: [] },
    { id: 'E2', name: 'B', layer: 'domain', deps: ['E1', 'E3', 'A'] },
    { id: 'E3', name: 'C', layer: 'app', deps: [2] },
  ], layers);
  assert.deepEqual(given.map(e => e.deps), [[], ['E1'], ['E2']], '後方（E3）への依存は捨てる、名前・番号も解決');
  assert.equal(given[0].deps_from, 'wbs');
  const inferred = G.normalizeDeps([
    { id: 'E1', layer: 'core' }, { id: 'E2', layer: 'core' }, { id: 'E3', layer: 'app' },
  ], layers);
  assert.deepEqual(inferred.map(e => e.deps), [[], [], ['E1', 'E2']]);
  assert.equal(inferred[0].deps_from, 'layer');
  assert.deepEqual(G.dagOrder([{ id: 'M2', deps: ['M1'] }, { id: 'M1', deps: [] }]), ['M1', 'M2']);
});

test('依存 DAG：依存先が未承認のモジュールは着手も承認もできない（上位が mock 相手に先走らない）', async () => {
  const p = H.createProject({ name: 'DAG 順', brief: '在庫', tech: 'Node.js' });
  for (const sid of ['requirements', 'ux', 'architecture', 'wbs']) {
    await waitFor(() => stage(p, sid).status === 'awaiting_review');
    H.approveStage(p, sid);
  }
  const m3 = p.modules.find(m => m.id === 'M3');
  assert.deepEqual(m3.deps, ['M1', 'M2']);
  await waitFor(() => p.modules.filter(m => m.status === 'awaiting_review').length >= 3);
  assert.equal(m3.status, 'pending', 'M1・M2 未承認のうちは M3 に着手しない');
  assert.throws(() => H.checkModuleRunnable(p, 'M3'), /depends on unapproved/);
  H.approveModule(p, 'M1');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(m3.status, 'pending', 'M2 が残っている');
  H.approveModule(p, 'M2');
  await waitFor(() => m3.status === 'awaiting_review');
  const m4 = p.modules.find(m => m.id === 'M4');
  H.approveModule(p, 'M3');
  await waitFor(() => m4.status === 'awaiting_review');
  // M4 の依存 M3 を差し戻すと、M4 は承認できない
  H.rejectModule(p, 'M3', { category: 'test', comment: 'やり直し' });
  assert.throws(() => H.approveModule(p, 'M4'), /before its dependencies/);
});

test('モジュールのコンテキストパック：担当 ID の原文行と依存モジュールの実ソースを渡す', () => {
  const ws = path.join(process.env.AI_PLATFORM_WORKSPACE, 'P-ctx');
  fs.mkdirSync(path.join(ws, 'inputs'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'src/core'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'inputs/spec.md'), SPEC);
  fs.writeFileSync(path.join(ws, 'src/core/vehicle.mjs'), 'export const VEHICLE_TABLE = "SHM_SYARYO";');
  const project = {
    id: 'P-ctx', ledger: { items: G.scanLedger([{ name: 'spec.md', text: SPEC }]).items },
    modules: [{ id: 'M1', name: '車両', files: [{ path: 'src/core/vehicle.mjs' }], test_path: 'test/x.mjs' }],
  };
  const ctx = agent.moduleContext(project, { id: 'M2', req_ids: ['SHM_SYARYO'], deps: ['M1'] });
  assert.match(ctx, /SHM_SYARYO（table）車両台帳/);
  assert.match(ctx, /spec\.md:3/);
  assert.match(ctx, /export const VEHICLE_TABLE/);
  assert.match(ctx, /mock せず/);
});

/* ---------- ④ 段階別スキル割当 ---------- */

test('段階別スキル割当：主軸（BMAD v6）とチェックリストを役割付きで取り込み、衝突プリセットを外す', () => {
  const p = H.createProject({ name: 'スキル割当', tech: 'Next.js + NestJS + PostgreSQL' });
  H.importSkills(p, ['bmad-brainstorming', 'dev-nodejs']);         // 外す対象を先に入れておく
  H.addSkill(p, { name: '案件ルール', body: '固定長 64 バイト', stage: 'development' });
  const dry = H.applySkillPlan(p, { dryRun: true });
  assert.ok(dry.add.some(a => a.id === 'bmad6-requirements' && a.role === 'primary'));
  assert.deepEqual(dry.remove.map(r => r.preset).sort(), ['bmad-brainstorming', 'dev-nodejs']);
  assert.equal(p.skills.length, 3, 'dryRun は変更しない');
  H.applySkillPlan(p);
  assert.ok(!p.skills.some(s => /bmad-brainstorming|dev-nodejs/.test(s.preset || '')), '衝突プリセットは削除');
  assert.ok(p.skills.some(s => s.name === '案件ルール'), '人が書いたスキルは残す');
  const st = H.skillPlanStatus(p);
  assert.ok(st.development.primary.every(r => r.applied));
  assert.ok(st.development.checklist.some(r => r.id === 'dev-nestjs-nextjs-postgres' && r.applied), 'Nest 系は専用プリセット（NestJS / Next.js / PostgreSQL 開発規約）を取り込む');
  assert.deepEqual(st.development.conflicts, []);
  assert.equal(H.applySkillPlan(p, { dryRun: true }).add.length, 0, '2 回目は差分なし（冪等）');

  const brief = agent.skillsBrief(p, 'development');
  assert.match(brief, /スキル索引/);
  assert.match(brief, /主軸ワークフロー/);
  assert.match(brief, /【案件ルール】固定長 64 バイト/, '案件専用は全文');
  assert.ok(!/## Core Process/.test(brief.split('（チェックリスト')[1] || ''), 'チェックリストは本文全体を入れない');
});

test('スタック逸脱：Next.js + NestJS + PostgreSQL は TS 档案で実行（逸脱なし）、依存なし Node に置き換えられたら deviates', () => {
  const p = H.createProject({ name: '逸脱', tech: 'Next.js + NestJS + PostgreSQL 16' });
  const d = H.stackDeviation(p);
  assert.equal(d.deviates, false, `TS 档案が依存を実際に入れて走らせる：${d.runner}`);
  assert.match(d.runner, /TypeScript/);
  const sp = H.stackDeviation(H.createProject({ name: 'spring', tech: 'Java 21 + Spring Boot 3.3 + PostgreSQL 16' }));
  assert.ok(sp.deviates, 'Java は JDK のみ：Spring 宣言は依然として逸脱');
  assert.equal(H.stackDeviation(H.createProject({ name: 'cli', tech: 'Node.js 22 (zero-dep CLI)' })).deviates, false);
  p.arch = { ...p.arch, stack: 'Node.js ESM + node:test（サードパーティ依存なし）' };   // ARC-01 が依存なし Node に置き換えたケース
  const r = H.stackDeviation(p);
  assert.ok(r.deviates && r.replaced, '人の指定スタックがアーキで置き換えられたことを検出');
  assert.match(r.note, /was replaced by/);
});

/* ---------- ⑤ 疑問・変更台帳 + ⑥ 教訓ループ ---------- */

const LEDGER_P = () => ({
  ledger: { items: G.scanLedger([{ name: 'spec.md', text: SPEC }]).items },
  modules: [
    { id: 'M1', req_ids: ['SHM_SYARYO'], deps: [], status: 'approved' },
    { id: 'M2', req_ids: ['Jsh230'], deps: [], status: 'approved' },
    { id: 'M3', req_ids: ['Jsh050'], deps: ['M1'], status: 'awaiting_review' },
    { id: 'M4', req_ids: ['IF-001'], deps: ['M3'], status: 'pending' },
    { id: 'M5', req_ids: ['SHM_SYASYU'], deps: [], status: 'approved' },
  ],
});

test('cleanQuestions：テキスト必須、創作 ID は落とし、ID が無ければ質問元モジュールの担当 ID に紐づける', () => {
  const p = LEDGER_P();
  const qs = G.cleanQuestions(p, [
    { req_ids: ['SHM_SYARYO', 'XXX_NOPE'], text: '車両の廃車日は必須？' },
    { req_ids: [], text: '  ' },
    { text: '端数は切り捨て？' },
    'not an object',
  ], p.modules[2]);
  assert.deepEqual(qs, [
    { text: '車両の廃車日は必須？', req_ids: ['SHM_SYARYO'] },
    { text: '端数は切り捨て？', req_ids: ['Jsh050'] },
    { text: 'not an object', req_ids: ['Jsh050'] },
  ]);
  assert.deepEqual(G.cleanQuestions(p, null, p.modules[0]), []);
});

test('impactOf：req_ids が重なるモジュール + 質問元 + 依存先を推移的に、無関係なモジュールは含めない', () => {
  const p = LEDGER_P();
  const imp = G.impactOf(p, { module: 'M2', req_ids: ['SHM_SYARYO'] });
  assert.deepEqual(imp.direct, ['M1', 'M2']);
  assert.deepEqual(imp.dependents, ['M3', 'M4'], 'M3 は M1 に、M4 は M3 に依存');
  assert.ok(!imp.all.includes('M5'), 'M5 は無関係');
  // 枝番 ID の疑問は親 ID を担当するモジュールに及ぶ
  assert.deepEqual(G.impactOf(p, { module: 'M5', req_ids: ['Jsh230L01'] }).direct, ['M2', 'M5']);
  p.questions = [{ id: 'Q-1', status: 'open', module: 'M4', req_ids: ['SHM_SYASYU'] }];
  assert.deepEqual(G.heldBy(p, p.modules[4]).map(q => q.id), ['Q-1'], 'ID が重なるモジュールも回答まで保留');
  assert.deepEqual(G.heldBy(p, p.modules[0]), []);
});

const SPEC_Q = SPEC + '\nJsh060 運賃計算（端数処理は未定）\n';

test('疑問ループ：曖昧な ID を持つモジュールは on_hold、回答で影響範囲だけ作り直し、回答と差し戻しは教訓 → 案件専用スキル', async () => {
  const p = H.createProject({ name: '疑問台帳', brief: '車両管理', tech: 'Node.js', files: [{ name: 'spec.md', content: SPEC_Q }] });
  for (const sid of ['requirements', 'ux', 'architecture', 'wbs']) {
    await waitFor(() => stage(p, sid).status === 'awaiting_review');
    H.approveStage(p, sid);
  }
  const held = p.modules.find(m => m.req_ids.includes('Jsh060'));
  assert.ok(held, 'Jsh060 を担当するモジュールがある');
  await waitFor(() => held.status === 'on_hold');
  const q = p.questions.find(x => x.module === held.id);
  assert.equal(q.status, 'open');
  assert.deepEqual(q.req_ids, ['Jsh060']);
  assert.match(q.text, /未定/);
  assert.ok(p.events.some(e => /on hold: 1 open question/.test(e.text)));
  assert.throws(() => H.checkModuleRunnable(p, held.id), /on hold/);
  assert.equal(H.trace(p).questions.open, 1);
  assert.deepEqual(H.trace(p).questions.on_hold, [held.id]);

  // 無関係なモジュールは進む：依存なしで疑問の無いものを承認しておく
  const indep = p.modules.filter(m => m !== held && !m.deps.length);
  await waitFor(() => indep.every(m => m.status === 'awaiting_review'));
  for (const m of indep) H.approveModule(p, m.id);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(held.status, 'on_hold', '回答されるまで再実行しない');
  assert.equal(stage(p, 'development').status !== 'approved', true);

  // 回答は人だけ：API 直叩き・自動化名義は 403
  assert.throws(() => H.answerQuestion(p, q.id, { answer: '四捨五入', by: 'PM', source: 'api' }), (e) => e.status === 403);
  assert.throws(() => H.answerQuestion(p, q.id, { answer: '四捨五入', by: 'AI bot' }), (e) => e.status === 403);
  assert.throws(() => H.answerQuestion(p, q.id, { answer: ' ', by: 'PM' }), /empty/);
  const versions = Object.fromEntries(p.modules.map(m => [m.id, m.version]));
  const r = H.answerQuestion(p, q.id, { answer: '10 円未満は四捨五入', by: 'PM', source: 'dashboard' });
  assert.equal(q.status, 'answered');
  assert.ok(r.impact.all.includes(held.id));
  for (const m of p.modules.filter(x => !r.impact.all.includes(x.id))) {
    assert.equal(m.version, versions[m.id], `${m.id} は影響範囲外なので触らない`);
    assert.ok(!m.feedback);
  }
  assert.match(held.feedback.comment, /四捨五入/);
  assert.match(agent.moduleContext(p, held), /確定した仕様判断[\s\S]*10 円未満は四捨五入/);
  assert.ok(p.events.some(e => new RegExp(`${q.id} answered by PM → impact: .*${held.id}`).test(e.text)));
  await waitFor(() => held.status === 'awaiting_review');
  assert.ok(!p.questions.some(x => x.status === 'open'), '回答済みの ID は再質問しない');
  assert.throws(() => H.answerQuestion(p, q.id, { answer: 'x', by: 'PM' }), /already answered/);

  // 教訓：回答 → 下書き → 承認で案件専用スキルに追記。差し戻しも下書きになる
  const l1 = p.lessons.find(l => l.from === 'question' && l.ref === q.id);
  assert.equal(l1.status, 'draft');
  assert.match(l1.draft, /\[Jsh060\].*四捨五入/);
  assert.equal(p.skills.filter(s => /Lessons learned/.test(s.name)).length, 0, '承認前はスキルに入らない');
  const { skill } = H.approveLesson(p, l1.id, { by: 'PM' });
  assert.equal(skill.role, 'project');
  assert.equal(skill.stage, 'development');
  assert.match(skill.body, /四捨五入/);
  H.rejectModule(p, held.id, { category: 'Spec', comment: '運賃は税込で返す', reviewer: 'PM' });
  const l2 = p.lessons.find(l => l.from === 'rejection' && l.ref === held.id);
  assert.match(l2.draft, /\[Spec\] 運賃は税込で返す/);
  H.approveLesson(p, l2.id, { body: '- 運賃・金額は税込で返す', by: 'PM' });
  assert.equal(p.skills.filter(s => /Lessons learned/.test(s.name)).length, 1, '同じ段階の教訓は 1 本のスキルに追記');
  assert.match(skill.body, /四捨五入[\s\S]*税込/);
  assert.match(agent.skillsBrief(p, 'development'), /税込/, '次回以降のモデル呼び出しに入る');
  assert.throws(() => H.approveLesson(p, l2.id, { by: 'PM' }), /already approved/);
  H.rejectModule(p, indep[0].id, { category: 'Style', comment: '命名を業務語に', reviewer: 'PM' });
  const l3 = p.lessons.find(l => l.ref === indep[0].id);
  H.dismissLesson(p, l3.id, { by: 'PM' });
  assert.equal(l3.status, 'dismissed');
  assert.equal(H.trace(p).lessons.draft, 0);
});

/* ---------- ⑩ 台帳再走査 rescanLedger（既存案件の流し直し / 入力差分の反映） ---------- */

test('rescanLedger：入力資料だけから決定的に台帳を作り直し、消えた ID はモジュール req_ids から落ちる', async () => {
  const p = H.createProject({ name: 'rescan', brief: '車両管理', tech: 'Node.js', files: [{ name: 'spec.md', content: SPEC }] });
  await waitFor(() => stage(p, 'requirements').status === 'awaiting_review');
  // 既存台帳に「実際には入力に無い」ID を 1 件紛れ込ませる（モデルが創作した FR / 旧台帳の残り香の想定）
  p.ledger.items.push({ id: 'GHOST_FR_999', kind: 'requirement', name: '創造された要件', parent: null, refs: 0, sources: [], origin: 'model' });
  // モジュールの req_ids にも混ぜておく → rescan で落ちるべき
  p.modules = [{ id: 'M1', name: '車両台帳', layer: 'core', status: 'approved', req_ids: ['Jsh050', 'SHM_SYARYO', 'GHOST_FR_999'] }];
  const eventsBefore = p.events.length;
  const r = H.rescanLedger(p.id);
  assert.ok(r.items >= 6, `ledger items ${r.items}`);
  assert.equal(r.scanned.files, 1);
  assert.ok(r.prev_count >= 6, `previous ledger を持つので prev_count > 0 (実際 ${r.prev_count})`);
  assert.equal(r.dropped, 1, 'GHOST_FR_999 が removed');
  assert.equal(r.added, 0);
  // 消えた ID（GHOST_）はモジュールから落ちる、Jsh050 と SHM_SYARYO は残る
  assert.deepEqual([...p.modules[0].req_ids].sort(), ['Jsh050', 'SHM_SYARYO']);
  assert.equal(p.modules[0].id, 'M1', 'モジュールは消さない');
  assert.ok(p.ledger.items.some(it => it.id === 'SHM_SYARYO'), '台帳本体に SHM_SYARYO が入っている');
  assert.ok(!p.ledger.items.some(it => it.id === 'GHOST_FR_999'), '台帳本体から GHOST_FR_999 は消える');
  assert.ok(p.ledger.rescan_of, 'previous 生成時刻を rescan_of に保持');
  assert.ok(p.events.length > eventsBefore, 'rescan イベントが追加される');
  const rescanEvt = p.events.filter(e => /ledger rescan:/.test(e.text)).pop();
  assert.match(rescanEvt.text, /−1 removed/, 'GHOST_FR_999 は removed として記録');
  assert.match(rescanEvt.text, /1 file\(s\)/);
});

test('rescanLedger：走っている案件は 409（入力ファイル無し）', async () => {
  const empty = H.createProject({ name: 'rescan-noinput', tech: 'Node.js' });
  await waitFor(() => stage(empty, 'requirements').status === 'awaiting_review');
  assert.throws(() => H.rescanLedger(empty.id), (e) => e.status === 400 && /no input files/.test(e.message), '入力無し → 400');
});

test('rescanLedger：要件段階の実行中は 409', () => {
  // running 状態を強制して 409 を検証
  const p = H.createProject({ name: 'rescan-running', brief: '車両', tech: 'Node.js', files: [{ name: 'spec.md', content: SPEC }] });
  p.stages[0].status = 'running';
  assert.throws(() => H.rescanLedger(p.id), (e) => e.status === 409, '実行中 → 409');
});

test('rescanLedger：API ルート POST /api/projects/:id/ledger/rescan がサーバに届く', () => {
  // ルートファイル内にパスと関数が書かれているかを静的検査（実サーバを起動しない）
  const src = fs.readFileSync(path.join(process.cwd(), 'server.mjs'), 'utf8');
  // 正規表現なので `\/` のエスケープを含む。`ledger` と `rescan` の隣接だけ見る
  assert.ok(/ledger[\\]+\/rescan/.test(src), 'rescan ルートがサーバ.mjs に定義されている');
  assert.ok(src.includes('H.rescanLedger('), 'ルートから関数が呼ばれる');
});
