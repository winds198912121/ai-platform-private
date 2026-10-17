/* ============================================================
   prototype.mjs — UX 段階の「見える成果物」：画面 ID ごとの HTML プロトタイプ
   - 画面一覧は要件台帳（G.ledgerItems）から決定的に作る：画面・帳票の枝番 ID（output）と screen/report、
     枝番を持たない機能 ID は機能そのものを 1 画面とする。→ 台帳と 1 対 1。
   - デザインシステム（共通テンプレート：検索条件 + 一覧 + 明細 + ファンクションキー F1〜F12）を 1 回だけ作り、
     画面ごとには中身（項目）だけを差し込む。ローファイは全画面、ハイファイは重要画面だけ。
   - 項目は入力資料（画面帳票イメージ集）の【検索項目】【一覧項目】【詳細項目】ブロックから機械的に拾う（LLM 不使用）。
   ファイルは workspace/<pid>/prototypes/ に置く（自己完結 HTML：CSS はテンプレートから各画面にインライン展開）。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import * as G from './governance.mjs';

export const DIR = 'prototypes';
export const TEMPLATE_FILE = `${DIR}/_design-system.html`;
export const fileOf = (id) => `${DIR}/${safeId(id)}.html`;
export const shotOf = (id) => `${DIR}/shots/${safeId(id)}.png`;
const safeId = (id) => String(id).replace(/[^\w.-]/g, '_');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 画面一覧（台帳と 1 対 1） ---------- */

const SCREEN_KINDS = ['output', 'screen', 'report'];
/** 画面か帳票か：枝番の英字（f = 画面 / l = 帳票）、RPT- は帳票、それ以外は画面。 */
export const formOf = (it) => (it.kind === 'report' || /^RPT-/.test(it.id) || /^[A-Z][a-z]{1,3}\d{3}[Ll]\d{2}$/.test(it.id) ? 'report' : 'screen');

/** 重要画面（ハイファイ対象）：p.ux_important が指定されていればそれ、無ければ参照回数の多い上位 3 件（auto）。 */
export function importantOf(p, screens) {
  const explicit = Array.isArray(p.ux_important) ? p.ux_important.filter(id => screens.some(s => s.id === id)) : [];
  if (Array.isArray(p.ux_important)) return { ids: explicit, auto: false };
  const top = [...screens].filter(s => s.form === 'screen').sort((a, b) => (b.refs || 0) - (a.refs || 0) || a.id.localeCompare(b.id)).slice(0, 3);
  return { ids: top.map(s => s.id), auto: true };
}

export function screensOf(p) {
  const items = G.ledgerItems(p);
  const parents = new Set(items.filter(it => it.parent).map(it => it.parent));
  const list = items
    .filter(it => SCREEN_KINDS.includes(it.kind) || (it.kind === 'function' && !parents.has(it.id)))
    .map(it => ({ id: it.id, kind: it.kind, name: it.name || '', parent: it.parent || null, refs: it.refs || 0, sources: it.sources || [], form: formOf(it) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const imp = new Set(importantOf(p, list).ids);
  return list.map(s => ({ ...s, important: imp.has(s.id) }));
}

/* ---------- AS-IS：入力資料のうちその画面 ID が出てくる箇所 ---------- */

const PAGE_HEAD = /F2-1\s+システム方式詳細設計|^\s*業務名\s|^[-=]{8,}\s*$/;
const isImageDoc = (name) => /画面|帳票|イメージ|layout|screen/i.test(name);
const IMG = /\.(png|jpe?g|gif|webp|svg)$/i;

/** 画面 ID の現行資料抜粋：画面帳票イメージ集の該当ページ（次のページ見出しまで）＋ inputs/ にある同 ID の画像。 */
export function asIsOf(p, wsDir, id) {
  const files = G.readInputs(p, wsDir);
  const re = new RegExp(`\\b${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const ranked = [...files].sort((a, b) => Number(isImageDoc(b.name)) - Number(isImageDoc(a.name)));
  let hit = null;
  for (const f of ranked) {
    const lines = String(f.text || '').split(/\r?\n/);
    const i = lines.findIndex(l => re.test(l));
    if (i < 0) continue;
    let end = i + 1;
    while (end < lines.length && end - i < 80 && !PAGE_HEAD.test(lines[end])) end++;
    hit = { file: f.name, line: i + 1, text: lines.slice(i, end).join('\n').replace(/\s+$/, '') };
    break;
  }
  const inDir = path.join(wsDir, 'inputs');
  let images = [];
  try { images = fs.readdirSync(inDir).filter(n => IMG.test(n) && n.toLowerCase().includes(String(id).toLowerCase())).map(n => `inputs/${n}`); } catch { /* inputs なし */ }
  return { id, found: !!hit, file: hit?.file || null, line: hit?.line || null, title: hit ? titleOf(hit.text.split('\n')[0], id) : '', text: hit?.text || '', images };
}

/** 見出し行「１．部品マスタ登録－一覧画面（Jsi010f01）」→「部品マスタ登録－一覧画面」。ページ見出し等なら ''。 */
function titleOf(line, id) {
  const i = line.toLowerCase().indexOf(String(id).toLowerCase());
  if (i < 0) return '';
  const head = line.slice(0, i).replace(/[（(【\[]\s*$/, '').replace(/^[\s\d０-９.．、]+/, '').trim();
  return /[぀-ヿ㐀-鿿]/.test(head) && !/ﾌﾟﾛｸﾞﾗﾑ|業務名|ID$|ＩＤ$/.test(head) && head.length <= 40 ? head : '';
}

/* ---------- 項目抽出（決定的） ---------- */

const SECTION = { 検索項目: 'search', 抽出条件: 'search', 検索条件: 'search', 一覧項目: 'columns', 明細項目: 'columns', 詳細項目: 'detail', 入力項目: 'detail', ヘッダ: 'detail', 出力項目: 'columns' };
const CIRCLED = /^[①-⑳]/;

/** 「①年度 ：数字(半角) 4桁 ※…」→ { label, type, len, note }。 */
function parseField(line) {
  const s = line.trim().replace(CIRCLED, '').trim();
  const [label0, rest = ''] = s.split(/\s*[：:]\s*/);
  const label = label0.replace(/\s+/g, ' ').trim();
  if (!label || label.length > 24) return null;
  const len = (rest.match(/(\d+)\s*桁/) || [])[1];
  const type = /数[字値]/.test(rest) ? 'number' : /チェック/.test(rest) ? 'check' : /日|yyyy/.test(rest + label) ? 'date' : 'text';
  const note = (rest.match(/※\s*(.+)$/) || [])[1] || '';
  return { label, type, len: len ? Number(len) : null, note: note.trim() };
}

/** AS-IS 抜粋から画面の型（検索条件・一覧・明細）を作る。何も拾えなければ名前から既定の型。 */
export function specFromAsIs(scr, asis) {
  const spec = { search: [], columns: [], detail: [] }, order = [];
  let cur = null;
  for (const raw of String(asis?.text || '').split('\n')) {
    const sec = raw.match(/【([^】]+)】/);
    if (sec) { cur = SECTION[sec[1].trim()] || null; if (cur && !order.includes(cur)) order.push(cur); continue; }
    if (cur && CIRCLED.test(raw.trim())) { const f = parseField(raw); if (f) spec[cur].push(f); }
  }
  const found = spec.search.length + spec.columns.length + spec.detail.length > 0;
  if (!found) {
    const nm = scr.name || '';
    spec.search = [{ label: 'コード', type: 'text', len: 10 }, { label: '名称', type: 'text', len: 20 }, { label: '年度', type: 'number', len: 4 }];
    if (scr.form === 'report' || /一覧|帳票|表/.test(nm)) spec.columns = ['No.', 'コード', '名称', '数量', '更新日'].map(label => ({ label, type: 'text' }));
    else spec.detail = ['コード', '名称', '区分', '備考'].map(label => ({ label, type: 'text' }));
    if (!spec.columns.length) spec.columns = ['コード', '名称', '更新日'].map(label => ({ label, type: 'text' }));
  }
  return { ...spec, order: found ? order.filter(k => spec[k].length) : ['search', 'columns', 'detail'], from: found ? 'as-is' : 'default' };
}

/* ---------- デザインシステム（共通テンプレート） ---------- */

export const DEFAULT_TOKENS = {
  brand: '#0b5394', ink: '#1f2328', muted: '#5b6470', line: '#c9d1da', panel: '#f4f6f9', accent: '#0b7a3e', danger: '#b42318',
  font: '"Hiragino Sans","Yu Gothic UI","Meiryo",system-ui,sans-serif', density: 'compact',
};
/** ファンクションキー：業務端末の慣習（F2 検索・F5 登録・F12 終了は全画面共通で必須）。 */
export const DEFAULT_FKEYS = [
  ['F1', 'ヘルプ'], ['F2', '検索'], ['F3', '参照'], ['F4', ''], ['F5', '登録'], ['F6', ''],
  ['F7', '前頁'], ['F8', '次頁'], ['F9', '印刷'], ['F10', ''], ['F11', 'クリア'], ['F12', '終了'],
];
const REQUIRED_FKEYS = ['F2', 'F5', 'F12'];

/** トークン（色・書体）だけはモデル / sim から受け取り、検証してから使う。不正値は既定値。 */
export function sanitizeTokens(t = {}) {
  const out = { ...DEFAULT_TOKENS };
  for (const k of ['brand', 'ink', 'muted', 'line', 'panel', 'accent', 'danger']) if (/^#[0-9a-f]{3,8}$/i.test(String(t[k] || ''))) out[k] = t[k];
  if (typeof t.font === 'string' && /^[\w\s"',-]+$/.test(t.font) && t.font.length < 160) out.font = t.font;
  if (t.density === 'comfortable') out.density = 'comfortable';
  return out;
}
export function sanitizeFkeys(list) {
  const map = new Map(DEFAULT_FKEYS);
  for (const k of Array.isArray(list) ? list : []) {
    const key = String(k?.key || k?.[0] || '').toUpperCase(), label = String(k?.label ?? k?.[1] ?? '').slice(0, 6);
    if (/^F([1-9]|1[0-2])$/.test(key) && (label || !REQUIRED_FKEYS.includes(key))) map.set(key, label);
  }
  return DEFAULT_FKEYS.map(([k]) => [k, map.get(k) || '']);
}

/** テンプレート HTML：{{…}} のスロットを画面ごとに埋める。テンプレート自体もプレビューできる（見本の中身入り）。 */
export function designSystem(tokens = DEFAULT_TOKENS, system = '') {
  const t = sanitizeTokens(tokens);
  const pad = t.density === 'comfortable' ? 8 : 5;
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{TITLE}}</title>
<style>
:root{--brand:${t.brand};--ink:${t.ink};--muted:${t.muted};--line:${t.line};--panel:${t.panel};--accent:${t.accent};--danger:${t.danger};--pad:${pad}px}
*{box-sizing:border-box}html,body{margin:0;background:#fff;color:var(--ink);font:13px/1.5 ${t.font}}
.app{display:flex;flex-direction:column;min-height:100vh;width:1280px;margin:0 auto;border:1px solid var(--line)}
.hd{display:flex;align-items:center;gap:12px;background:var(--brand);color:#fff;padding:6px 12px}
.hd .sys{font-weight:600}.hd .sid{font-family:ui-monospace,Menlo,monospace;background:rgba(255,255,255,.18);padding:1px 6px;border-radius:2px}
.hd .ttl{font-size:15px;font-weight:600}.hd .usr{margin-left:auto;font-size:12px;opacity:.9}
.fid{font-size:11px;padding:1px 6px;border:1px solid rgba(255,255,255,.6);border-radius:2px}
.main{flex:1;padding:10px 12px;display:flex;flex-direction:column;gap:10px}
.sec{border:1px solid var(--line)}.sec>h2{margin:0;font-size:12px;font-weight:600;background:var(--panel);border-bottom:1px solid var(--line);padding:4px 8px;color:var(--muted)}
.form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--pad) 16px;padding:8px}
.fld{display:flex;align-items:center;gap:6px}.fld label{min-width:7em;color:var(--muted);font-size:12px}.fld label.req{text-decoration:underline;color:var(--ink)}
.in{flex:1;min-height:24px;border:1px solid var(--line);background:#fff;padding:2px 6px;font:inherit;color:var(--muted)}
.in.num{text-align:right}.in.chk{flex:0 0 18px;min-height:18px}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid var(--line);padding:calc(var(--pad) - 2px) 6px;text-align:left;white-space:nowrap}
th{background:var(--panel);font-weight:600}tbody tr:nth-child(even) td{background:#fafbfc}td.num{text-align:right}
.pager{display:flex;justify-content:space-between;padding:4px 8px;font-size:12px;color:var(--muted)}
.msg{border-left:3px solid var(--accent);background:var(--panel);padding:4px 8px;font-size:12px}
.fk{display:grid;grid-template-columns:repeat(12,1fr);gap:4px;padding:6px 12px;background:var(--panel);border-top:1px solid var(--line)}
.fk div{border:1px solid var(--line);background:#fff;text-align:center;font-size:11px;padding:3px 0;min-height:36px}
.fk b{display:block;font-family:ui-monospace,Menlo,monospace;color:var(--brand)}.fk .off{opacity:.35}
/* ローファイ：色と装飾を落として構造だけを見る */
.lo .hd{background:#777}.lo .fk b{color:#333}.lo th{background:#eee}.lo .msg{border-left-color:#999}
.lo .in{background:repeating-linear-gradient(135deg,#fff 0 6px,#f3f3f3 6px 12px)}
.notes{font-size:11px;color:var(--muted);padding:0 12px 8px}
</style></head>
<body><div class="app {{FIDELITY_CLASS}}">
<header class="hd"><span class="sys">${esc(system || '業務システム')}</span><span class="sid">{{SCREEN_ID}}</span><span class="ttl">{{TITLE}}</span><span class="fid">{{FIDELITY}}</span><span class="usr">利用者：職員 0001 ／ {{DATE}}</span></header>
<main class="main">
{{BODY}}
</main>
<footer class="fk">{{FKEYS}}</footer>
<div class="notes">{{NOTES}}</div>
</div></body></html>
`;
}

/* ---------- 画面の描画 ---------- */

const sample = (f, r) => {
  if (/年度/.test(f.label)) return String(2026 - (r % 2));
  if (f.type === 'number') return String((r * 37 + (f.len || 3)) % Math.pow(10, Math.min(f.len || 4, 6))).padStart(1, '0');
  if (f.type === 'date') return `2026/0${(r % 9) + 1}/1${r % 10}`;
  if (f.type === 'check') return r % 2 ? '☑' : '☐';
  return `${f.label.replace(/\s.*$/, '').slice(0, 6)}${r + 1}`;
};
const input = (f, hi, val = '') => f.type === 'check'
  ? `<span class="in chk"></span>`
  : `<span class="in${f.type === 'number' ? ' num' : ''}" style="max-width:${Math.min(28, Math.max(5, (f.len || 10) + 2))}em">${hi ? esc(val) : ''}</span>`;
const field = (f, hi, val, req) => `<div class="fld"><label${req ? ' class="req"' : ''} title="${esc(f.note || '')}">${esc(f.label)}</label>${input(f, hi, val)}</div>`;

/** 画面 1 枚の HTML。spec = { search, columns, detail, rows?, message?, notes?, fkeys? }。 */
export function renderScreen(template, scr, spec, { fidelity = 'low', date = '2026/04/01' } = {}) {
  const hi = fidelity === 'high';
  const rows = Math.max(3, Math.min(spec.rows || (hi ? 8 : 5), 15));
  const part = {};
  if (spec.search?.length) part.search = (`<section class="sec"><h2>検索条件</h2><div class="form">${spec.search.map((f, i) => field(f, hi, sample(f, 0), i === 0)).join('')}</div></section>`);
  if (spec.columns?.length) part.columns = (`<section class="sec"><h2>${scr.form === 'report' ? '帳票明細' : '一覧'}</h2><table><thead><tr><th>選択</th>${spec.columns.map(c => `<th title="${esc(c.note || '')}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${
    Array.from({ length: rows }, (_, r) => `<tr><td>${hi ? (r === 0 ? '◉' : '○') : ''}</td>${spec.columns.map(c => `<td class="${c.type === 'number' ? 'num' : ''}">${hi ? esc(sample(c, r)) : '&nbsp;'}</td>`).join('')}</tr>`).join('')
  }</tbody></table><div class="pager"><span>${hi ? `全 ${rows * 4} 件中 1〜${rows} 件` : '件数'}</span><span>${hi ? '1 / 4 頁' : '頁'}</span></div></section>`);
  if (spec.detail?.length) part.detail = (`<section class="sec"><h2>${scr.form === 'report' ? '出力条件' : '明細'}</h2><div class="form">${spec.detail.map((f, i) => field(f, hi, sample(f, 1), i === 0)).join('')}</div></section>`);
  // 現行資料の並び（例：ヘッダ → 一覧）を保つ。指定が無ければ 検索条件 → 一覧 → 明細
  const order = [...new Set([...(spec.order || []), 'search', 'columns', 'detail'])];
  const parts = order.filter(k => part[k]).map(k => part[k]);
  if (hi && spec.message) parts.push(`<div class="msg">${esc(spec.message)}</div>`);
  const fk = sanitizeFkeys(spec.fkeys).map(([k, l]) => `<div class="${l ? '' : 'off'}"><b>${k}</b>${esc(l)}</div>`).join('');
  const title = scr.name || scr.id;
  const notes = [`出典：${spec.from === 'as-is' ? `現行資料 ${spec.source || ''}` : '既定の型（現行資料に項目定義なし）'}`, ...(spec.notes || [])].map(esc).join(' ／ ');
  return template
    .replaceAll('{{TITLE}}', esc(title)).replaceAll('{{SCREEN_ID}}', esc(scr.id))
    .replaceAll('{{FIDELITY_CLASS}}', hi ? 'hi' : 'lo').replaceAll('{{FIDELITY}}', hi ? 'Hi-Fi' : 'Lo-Fi')
    .replaceAll('{{DATE}}', esc(date)).replaceAll('{{BODY}}', parts.join('\n')).replaceAll('{{FKEYS}}', fk).replaceAll('{{NOTES}}', notes);
}

/** テンプレートの見本（デザインシステム成果物のプレビュー用）。 */
export function templatePreview(template) {
  const scr = { id: 'TEMPLATE', name: '共通テンプレート（検索条件 + 一覧 + 明細 + ファンクションキー）', form: 'screen' };
  const f = (label, type = 'text', len = 10) => ({ label, type, len });
  return renderScreen(template, scr, { search: [f('年度', 'number', 4), f('コード'), f('名称', 'text', 20)], columns: [f('コード'), f('名称', 'text', 20), f('数量', 'number', 5), f('更新日', 'date')], detail: [f('コード'), f('名称', 'text', 20), f('備考', 'text', 30)], message: '検索条件を入力して F2 を押してください。', from: 'default', notes: ['下線付きラベル = 必須入力'] }, { fidelity: 'high' });
}
