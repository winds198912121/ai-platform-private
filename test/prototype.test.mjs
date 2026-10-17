/* ============================================================
   prototype.test.mjs — UX 段階の見える成果物：台帳 ID と 1 対 1 の HTML プロトタイプ / 撮影 / AS-IS 比較
   運行：node --test test/prototype.test.mjs   （撮影まで確かめるなら AI_PLATFORM_SHOTS=1）
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.AI_PLATFORM_SPEED = '0';
process.env.AI_PLATFORM_PROVIDER = 'sim';
process.env.AI_PLATFORM_DATA = path.join(os.tmpdir(), `ai-platform-proto-${process.pid}.json`);
process.env.AI_PLATFORM_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-proto-ws-'));
fs.rmSync(process.env.AI_PLATFORM_DATA, { force: true });

const H = await import('../harness.mjs');
const PX = await import('../prototype.mjs');
const capture = await import('../capture.mjs');
const agent = await import('../agent.mjs');
H.load();

const waitFor = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('waitFor timed out');
};
const stage = (p, id) => p.stages.find(s => s.id === id);

/** 画面帳票イメージ集の体裁（ページ見出し → 画面タイトル(ID) → 【検索項目】【一覧項目】…）。 */
const ASIS_DOC = [
  'F2-1 システム方式詳細設計             F2-1.2   システム処理方式詳細設計',
  ' 業務名 資材管理システム                 ﾌﾟﾛｸﾞﾗﾑID Jsi010',
  '１．部品マスタ登録－一覧画面（Jsi010f01）',
  '        【検索項目】',
  '         ①年度        ：数字(半角)   4桁',
  '        【一覧項目】',
  '         ①業者        ：文字(半角)    5桁',
  '         ②取込日      ：数値(半角)    8桁 ※yyyy/mm/dd',
  '         ③取込件数    ：数値(半角)   10桁',
  'F2-1 システム方式詳細設計             F2-1.2   システム処理方式詳細設計',
  ' 業務名 資材管理システム                 ﾌﾟﾛｸﾞﾗﾑID Jsi010',
  '２．部品マスタ登録－入力画面（Jsi010f02）',
  '        【詳細項目】',
  '         ①年度      ：数字(半角)    4桁',
  '         ②業者コード ：文字(半角)    5桁 ※Ｆ３キーで検索',
  'F2-1 システム方式詳細設計',
  ' 業務名 資材管理システム                 ﾌﾟﾛｸﾞﾗﾑID Jsi020',
  '１．部品台帳一覧表（Jsi020L01）',
  'Jsh050 車両台帳登録',
].join('\n');

test('screensOf：台帳の画面・帳票 ID と 1 対 1（枝番を持つ機能は枝番で、持たない機能は機能そのもので）', () => {
  const p = { ledger: { items: [
    { id: 'Jsi010', kind: 'function', name: '部品マスタ登録' },
    { id: 'Jsi010f01', kind: 'output', parent: 'Jsi010', name: '一覧画面', refs: 5 },
    { id: 'Jsi010f02', kind: 'output', parent: 'Jsi010', name: '入力画面', refs: 2 },
    { id: 'Jsi020L01', kind: 'output', parent: 'Jsi020', name: '一覧表', refs: 9 },
    { id: 'Jsh050', kind: 'function', name: '車両台帳登録', refs: 1 },
    { id: 'SHM_SYARYO', kind: 'table' }, { id: 'FR-001', kind: 'requirement' },
  ] } };
  const s = PX.screensOf(p);
  assert.deepEqual(s.map(x => x.id), ['Jsh050', 'Jsi010f01', 'Jsi010f02', 'Jsi020L01']);
  assert.equal(s.find(x => x.id === 'Jsi020L01').form, 'report');
  assert.equal(s.find(x => x.id === 'Jsi010f01').form, 'screen');
  // 重要画面：未指定 → 参照回数上位（画面のみ、帳票は除外）を auto、指定 → その通り（空配列 = ハイファイなし）
  assert.deepEqual(PX.importantOf(p, s), { ids: ['Jsi010f01', 'Jsi010f02', 'Jsh050'], auto: true });
  assert.deepEqual(PX.screensOf({ ...p, ux_important: ['Jsi020L01'] }).filter(x => x.important).map(x => x.id), ['Jsi020L01']);
  assert.equal(PX.screensOf({ ...p, ux_important: [] }).filter(x => x.important).length, 0);
});

test('AS-IS 抽出と項目解析：該当ページだけを切り出し、【検索項目】【一覧項目】【詳細項目】から型・桁を拾う', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-asis-'));
  fs.mkdirSync(path.join(ws, 'inputs'));
  fs.writeFileSync(path.join(ws, 'inputs', 'AS画面帳票イメージ集.md'), ASIS_DOC);
  fs.writeFileSync(path.join(ws, 'inputs', 'Jsi010f01.png'), 'png');
  const p = { inputs: [{ name: 'AS画面帳票イメージ集.md', path: 'inputs/AS画面帳票イメージ集.md' }] };
  const a = PX.asIsOf(p, ws, 'Jsi010f01');
  assert.equal(a.found, true);
  assert.equal(a.line, 3);
  assert.match(a.text, /取込件数/);
  assert.doesNotMatch(a.text, /入力画面/, 'stops at the next page header');
  assert.deepEqual(a.images, ['inputs/Jsi010f01.png']);
  assert.equal(a.title, '部品マスタ登録－一覧画面');
  const spec = PX.specFromAsIs({ id: 'Jsi010f01', form: 'screen' }, a);
  assert.equal(spec.from, 'as-is');
  assert.deepEqual(spec.search.map(f => [f.label, f.type, f.len]), [['年度', 'number', 4]]);
  assert.deepEqual(spec.columns.map(f => f.label), ['業者', '取込日', '取込件数']);
  assert.equal(spec.columns[1].note, 'yyyy/mm/dd');
  assert.deepEqual(spec.order, ['search', 'columns']);
  // 現行の並び（ヘッダ → 一覧）を TO-BE でも保つ
  const hdr = PX.specFromAsIs({ id: 'X', form: 'screen' }, { text: '【ヘッダ】\n ①年度 ：数字(半角) 4桁\n【一覧項目】\n ①品番 ：文字(半角) 13桁' });
  assert.deepEqual(hdr.order, ['detail', 'columns']);
  const html = PX.renderScreen(PX.designSystem(), { id: 'X', form: 'screen' }, hdr);
  assert.ok(html.indexOf('<h2>明細</h2>') < html.indexOf('<h2>一覧</h2>'));
  const none = PX.asIsOf(p, ws, 'Zzz999');
  assert.equal(none.found, false);
  assert.equal(PX.specFromAsIs({ id: 'Zzz999', form: 'report' }, none).from, 'default');
});

test('テンプレート：共通の型（検索条件 + 一覧 + 明細 + F1〜F12、F2/F5/F12 必須）を 1 本にし、画面は中身だけ差し替え', () => {
  const tpl = PX.designSystem({ brand: 'javascript:alert(1)', accent: '#123456' }, '車両管理');
  assert.match(tpl, /--brand:#0b5394/, 'invalid token falls back to default');
  assert.match(tpl, /--accent:#123456/);
  for (const slot of ['{{TITLE}}', '{{SCREEN_ID}}', '{{BODY}}', '{{FKEYS}}']) assert.ok(tpl.includes(slot), slot);
  const scr = { id: 'Jsi010f01', name: '部品マスタ登録－一覧画面', form: 'screen' };
  const spec = { search: [{ label: '年度', type: 'number', len: 4 }], columns: [{ label: '業者', type: 'text' }], detail: [], fkeys: [{ key: 'F2', label: '' }, { key: 'F4', label: '取消' }], from: 'as-is', source: 'x.md' };
  const lo = PX.renderScreen(tpl, scr, spec), hi = PX.renderScreen(tpl, scr, spec, { fidelity: 'high' });
  assert.doesNotMatch(lo, /\{\{/);
  assert.match(lo, /class="app lo"/); assert.match(hi, /class="app hi"/);
  assert.match(lo, /Jsi010f01/); assert.match(lo, /検索条件/); assert.match(lo, /年度/);
  for (const [k, l] of [['F2', '検索'], ['F5', '登録'], ['F12', '終了'], ['F4', '取消']]) assert.match(lo, new RegExp(`<b>${k}</b>${l}`), `${k} ${l}`);
  assert.doesNotMatch(lo, /<script/i);
  assert.match(PX.renderScreen(tpl, { ...scr, name: '<img onerror=x>' }, spec), /&lt;img onerror=x&gt;/);
});

test('UX 段階（sim）：台帳 ID ごとに prototypes/ へ HTML、成果物は html 型（本文は DB に持たない）、撮影不可なら skipped', async () => {
  const p = H.createProject({ name: '資材管理', brief: '部品マスタ', tech: 'Node.js', files: [{ name: 'AS資材画面帳票イメージ集.md', content: ASIS_DOC }] });
  await waitFor(() => stage(p, 'requirements').status === 'awaiting_review');
  H.approveStage(p, 'requirements', 'PM', { source: 'dashboard' });
  await waitFor(() => stage(p, 'ux').status === 'awaiting_review');
  const ux = stage(p, 'ux');
  const screens = PX.screensOf(p);
  assert.deepEqual(screens.map(s => s.id), ['Jsh050', 'Jsi010f01', 'Jsi010f02', 'Jsi020L01']);
  const protos = ux.artifacts.filter(a => a.group === 'screens' && a.type === 'html');
  assert.deepEqual(protos.map(a => a.screen).sort(), screens.map(s => s.id), 'one prototype per ledger screen ID');
  assert.ok(ux.artifacts.some(a => a.id === 'UX-DS' && a.type === 'html'), 'design-system template artifact');
  assert.ok(ux.artifacts.some(a => a.id === 'UX-02' && a.type === 'markdown'), 'spec documents are still produced');
  const ws = path.join(process.env.AI_PLATFORM_WORKSPACE, p.id);
  for (const a of protos) {
    assert.equal(a.content, undefined, 'html body lives in the workspace file, not projects.json');
    const html = fs.readFileSync(path.join(ws, a.path), 'utf8');
    assert.match(html, new RegExp(a.screen));
    assert.match(html, /<b>F12<\/b>終了/);
  }
  assert.ok(fs.existsSync(path.join(ws, 'prototypes/_template.html')));
  const f01 = protos.find(a => a.screen === 'Jsi010f01');
  assert.equal(f01.spec_from, 'as-is');
  assert.deepEqual(f01.asis, { file: 'AS資材画面帳票イメージ集.md', line: 3 });
  assert.equal(f01.name, 'Jsi010f01 部品マスタ登録－一覧画面');
  assert.match(fs.readFileSync(path.join(ws, f01.path), 'utf8'), /取込件数/);
  // 重要画面（auto 上位 3）だけハイファイ、残りはローファイ
  assert.equal(protos.filter(a => a.fidelity === 'high').length, 3);
  assert.equal(protos.find(a => a.screen === 'Jsi020L01').fidelity, 'low');
  // node --test 配下は撮影しない → イベントに skipped、image 成果物なし
  assert.ok(p.events.some(e => /screenshots skipped/.test(e.text)));
  assert.equal(ux.artifacts.filter(a => a.type === 'image').length, 0);
  // html 成果物は Markdown の docs/ に書かない・成果物 API からは編集させない
  assert.ok(!fs.existsSync(path.join(ws, H.docPathOf('ux', 'UXP-Jsi010f01', p))));
  assert.throws(() => H.editArtifact(p, 'UXP-Jsi010f01', { content: 'x' }), (e) => e.status === 409);
  // AS-IS API
  assert.equal(H.asIs(p, 'Jsi010f02').found, true);
  assert.throws(() => H.asIs(p, ''), (e) => e.status === 400);

  // 重要画面の指定 → 差し戻し → 再実行でその画面だけハイファイ
  H.markImportant(p, 'Jsi020L01', true);
  H.markImportant(p, 'Jsh050', false);
  assert.ok(p.ux_important.includes('Jsi020L01') && !p.ux_important.includes('Jsh050'));
  assert.throws(() => H.markImportant(p, 'NOPE01', true), (e) => e.status === 404);
  H.rejectStage(p, 'ux', { category: 'UX', comment: '帳票もハイファイで' });
  await waitFor(() => stage(p, 'ux').status === 'awaiting_review' && stage(p, 'ux').attempts === 2);
  const again = stage(p, 'ux').artifacts.filter(a => a.group === 'screens' && a.type === 'html');
  assert.equal(again.find(a => a.screen === 'Jsi020L01').fidelity, 'high');
  assert.equal(again.find(a => a.screen === 'Jsh050').fidelity, 'low');
  assert.equal(again.length, screens.length, 'no duplicate prototypes after re-run');
});

test('台帳に画面 ID が無い案件：プロトタイプは作らずイベントで知らせる（UX 文書は従来どおり）', async () => {
  const p = H.createProject({ name: '画面なし', brief: '受注登録を行う。在庫を引き当てる。', tech: 'Node.js' });
  await waitFor(() => stage(p, 'requirements').status === 'awaiting_review');
  H.approveStage(p, 'requirements', 'PM', { source: 'dashboard' });
  await waitFor(() => stage(p, 'ux').status === 'awaiting_review');
  assert.equal(stage(p, 'ux').artifacts.filter(a => a.group).length, 0);
  assert.ok(p.events.some(e => /no screen\/report IDs/.test(e.text)));
});

test('UX のプロンプト：「thin spec / no pixel design」は撤廃、HTML プロトタイプ前提の規則を渡す', () => {
  const src = fs.readFileSync(new URL('../agent.mjs', import.meta.url), 'utf8');
  assert.match(src, /UX_RULE/);
  assert.match(src, /stage\.id === 'ux' \? UX_RULE/);
  assert.equal(typeof agent.uxDesign, 'function');
  assert.equal(typeof agent.uxScreen, 'function');
  for (const f of ['../skills/bmad-ux/SKILL.md', '../skills/bmad6-ux/SKILL.md']) {
    assert.doesNotMatch(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), /No pixel-perfect design|thin prototype description/);
  }
});

test('撮影：ブラウザがあれば PNG、無ければ skipped を返して失敗にしない', async (t) => {
  process.env.AI_PLATFORM_SHOTS = '0';
  const off = await capture.capture([{ html: '/nope.html', png: '/nope.png' }]);
  assert.equal(off.shots.length, 0);
  assert.match(off.skipped, /disabled/);
  process.env.AI_PLATFORM_SHOTS = '1';
  try {
    const br = capture.findBrowser();
    if (!br.path) return t.skip(`no browser: ${br.why}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-shot-t-'));
    const html = path.join(dir, 'a.html'), png = path.join(dir, 'a.png');
    fs.writeFileSync(html, PX.templatePreview(PX.designSystem()));
    const r = await capture.capture([{ html, png }, { html: path.join(dir, 'missing.html'), png: path.join(dir, 'b.png') }]);
    assert.equal(r.skipped, null);
    assert.ok(r.shots.includes(png));
    assert.deepEqual([...fs.readFileSync(png).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG signature');
  } finally { delete process.env.AI_PLATFORM_SHOTS; }
});
