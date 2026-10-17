/* ============================================================
   governance.mjs — 大規模案件向けの統制ルール（純粋関数中心）
     ① ゲート方針：human_gate では自動承認を拒否、高リスク段階は auto でも人の承認必須
     ② 要件台帳：入力資料の全文から ID（機能・テーブル・帳票…）を決定的に抽出し、モジュールへトレース
     ③ モジュール依存 DAG：WBS の deps を正規化、未指定ならレイヤー順で推定、未承認の依存があれば着手しない
     ④ 段階別スキル割当：主軸ワークフロー / チェックリスト / 案件専用 の 3 区分
   harness.mjs / agent.mjs から呼ばれる。ここは project state を読むだけで書き換えない（台帳スキャンだけファイルを読む）。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';

/* ---------- ① ゲート方針 ---------- */

/** auto モードでも人の承認を必須にする段階の既定（要件・アーキ＝DB スキーマを含む）。 */
export const HIGH_RISK_STAGES = ['requirements', 'architecture'];
/** プロジェクトごとの「人の承認必須」段階。未設定（旧データ）は既定を使う。 */
export const humanGatesOf = (p) => (Array.isArray(p && p.human_gates) ? p.human_gates : HIGH_RISK_STAGES);
/** この段階（モジュールは 'development'）のゲートに人の承認が必要か。human_gate モードは全段階が必要。 */
export const needsHuman = (p, stageId) => !p || p.mode !== 'auto' || humanGatesOf(p).includes(stageId);

const AUTOMATED = /(^|[^a-z])(auto|ai|bot|pipeline|agent|script|ci|cron)([^a-z]|$)|自動/i;
/** 承認者名が自動化主体に見えるか（「Auto pipeline」「AI auto-approve」「CI bot」など）。 */
export const looksAutomated = (reviewer) => AUTOMATED.test(String(reviewer || ''));

/**
 * 承認の出どころを検査し、違反ならメッセージを返す（null = 許可）。
 * source: 'dashboard'（画面のボタン）| 'api'（ヘッダなしの REST 呼び出し）| 'auto'（auto モードの内部承認）| 'direct'（同一プロセス）
 */
export function approvalViolation(p, stageId, reviewer, source) {
  if (!needsHuman(p, stageId)) return null;
  const why = p.mode === 'auto' ? `"${stageId}" is a high-risk gate that requires human approval even in auto mode` : 'this project is in human_gate mode';
  if (source === 'auto') return `Auto-approval refused: ${why}`;
  if (source === 'api') return `Approval refused: ${why}. Approve from the dashboard (requests without x-approval-source: dashboard are treated as automated).`;
  if (!String(reviewer || '').trim()) return `Approval refused: ${why}, and no reviewer was given`;
  if (looksAutomated(reviewer)) return `Approval refused: reviewer "${reviewer}" looks automated, but ${why}`;
  return null;
}

/* ---------- ② 要件台帳（決定的抽出）+ トレーサビリティ ---------- */

/** 入力資料に出てくる ID の形。プロジェクトで p.ledger_patterns を指定すれば上書きできる。 */
export const DEFAULT_ID_PATTERNS = [
  // 機能・画面・帳票コード：Jsh050 / Jsi110 / Jms014 / Jsh230L01（英大文字 1 + 小文字 1〜3 + 数字 3 + 任意の枝番）
  { kind: 'function', re: '\\b[A-Z][a-z]{1,3}\\d{3}(?:[A-Za-z]\\d{2})?\\b' },
  // テーブル・ファイル ID：SHM_SYARYO / SIF_UKEDAI（索引 _PK / _IXn は除外）
  { kind: 'table', re: '\\b[A-Z]{2,4}_[A-Z0-9]{2,}(?:_[A-Z0-9]+)*\\b', skip: '_(PK|IX\\d*|FK\\d*|SEQ)$' },
  // 明示的な要件番号：FR-001 / NFR-03 / REQ-12 / IF-007 / RPT-01
  { kind: 'requirement', re: '\\b(?:FR|NFR|REQ|IF|RPT|SCR)-\\d{2,4}\\b' },
];
const KIND_BY_PREFIX = { NFR: 'nfr', IF: 'interface', RPT: 'report', SCR: 'screen' };

const CJK = /[぀-ヿ㐀-鿿]/;
const NAME_MAX = 40;

/** 1 行の中から ID の「名前」を拾う：同じセル内の日本語 → 直前のセル → 直後のセル。 */
function nameNear(line, id) {
  const cells = line.split(/[|\t]|\s{2,}|　+/).map(c => c.trim()).filter(Boolean);
  const i = cells.findIndex(c => c.includes(id));
  if (i < 0) return '';
  const own = cells[i].replace(id, '').replace(/^[\s:：_\-・]+|[\s:：_\-・]+$/g, '');
  const pick = [own, cells[i - 1], cells[i + 1]].find(c => c && CJK.test(c) && !/^\d+$/.test(c));
  // 「１．発注の処理－一覧画面（）」→「発注の処理－一覧画面」：空括弧と先頭の番号（全角含む）を落とす
  return pick ? pick.replace(/[（(]\s*[）)]/g, '').replace(/^[\d０-９.．、\s]+/, '').trim().slice(0, NAME_MAX) : '';
}

/** 機能コードの枝番（Jsh230L01 → 親 Jsh230）。 */
const parentOf = (id) => { const m = id.match(/^([A-Z][a-z]{1,3}\d{3})[A-Za-z]\d{2}$/); return m ? m[1] : null; };

/**
 * 入力資料（全文）を走査して要件台帳を作る。LLM は使わない。
 * files: [{ name, text }]。返り値の items は ID 順、各 item は出現箇所（最大 5 件）と出現回数を持つ。
 */
export function scanLedger(files, patterns = DEFAULT_ID_PATTERNS) {
  const rules = patterns.map(r => ({ kind: r.kind, re: new RegExp(r.re, 'g'), skip: r.skip ? new RegExp(r.skip) : null }));
  const items = new Map();
  let bytes = 0;
  for (const f of files) {
    const text = String(f.text || '');
    bytes += Buffer.byteLength(text);
    text.split(/\r?\n/).forEach((line, ln) => {
      for (const r of rules) {
        for (const m of line.matchAll(r.re)) {
          const id = m[0];
          if (r.skip && r.skip.test(id)) continue;
          let it = items.get(id);
          if (!it) {
            const parent = r.kind === 'function' ? parentOf(id) : null;
            const prefix = id.split('-')[0];
            const kind = r.kind === 'requirement' ? (KIND_BY_PREFIX[prefix] || 'requirement') : parent ? 'output' : r.kind;
            it = { id, kind, name: '', parent, refs: 0, sources: [], names: {} };
            items.set(id, it);
          }
          it.refs++;
          if (it.sources.length < 5) it.sources.push({ file: f.name, line: ln + 1 });
          const nm = nameNear(line, id);
          if (nm) it.names[nm] = (it.names[nm] || 0) + 1;
        }
      }
    });
  }
  // 多数の ID に付く名前（ページヘッダ「業務名 共通」等）は定型文とみなして名前候補から外す
  const spread = {};
  for (const it of items.values()) for (const nm of Object.keys(it.names)) spread[nm] = (spread[nm] || 0) + 1;
  const boiler = (nm) => spread[nm] > Math.max(4, items.size * 0.05);
  const out = [...items.values()].map(({ names, ...it }) => {
    const best = Object.entries(names).filter(([nm]) => !boiler(nm)).sort((a, b) => b[1] - a[1])[0];
    return { ...it, name: best ? best[0] : '', origin: 'scan' };
  });
  // 枝番の親が台帳に無ければ親も機能として立てる（Jsh230L01 だけ出てくる場合）
  for (const it of out) if (it.parent && !items.has(it.parent)) {
    items.set(it.parent, true);
    out.push({ id: it.parent, kind: 'function', name: '', parent: null, refs: 0, sources: it.sources.slice(0, 1), origin: 'scan' });
  }
  // 名前の無い機能は枝番（画面・帳票）の名前から取る：「発注の処理－一覧画面」→「発注の処理」
  for (const it of out) if (it.kind === 'function' && !it.name) {
    const heads = {};
    for (const c of out) if (c.parent === it.id && c.name) { const h = c.name.split(/[－—]|\s-\s/)[0].trim(); if (h) heads[h] = (heads[h] || 0) + 1; }
    const best = Object.entries(heads).sort((a, b) => b[1] - a[1])[0];
    if (best) it.name = best[0];
  }
  out.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { items: out, scanned: { files: files.length, bytes } };
}

/** 入力ファイルを全文で読む（excerpt ではなくディスク上の原文）。読めないファイルは excerpt で代用。 */
export function readInputs(p, wsDir) {
  return (p.inputs || []).map(f => {
    const abs = f.path ? path.join(wsDir, f.path) : path.join(wsDir, 'inputs', f.name);
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { text = f.excerpt || ''; }
    return { name: f.name, text };
  });
}

export const KINDS = ['function', 'output', 'table', 'interface', 'report', 'screen', 'requirement', 'nfr'];
export const ledgerItems = (p) => (p && p.ledger && Array.isArray(p.ledger.items) ? p.ledger.items : []);

/** 台帳 → 下流プロンプト用の索引（ID と名前だけ、1 行 1 件）。 */
export function ledgerIndex(p, { kinds = null, max = 12000 } = {}) {
  const lines = []; let used = 0;
  for (const it of ledgerItems(p)) {
    if (kinds && !kinds.includes(it.kind)) continue;
    const l = `${it.id}\t${it.kind}\t${it.name || ''}${it.parent ? `\t(親 ${it.parent})` : ''}`;
    if (used + l.length > max) { lines.push(`…（残り ${ledgerItems(p).length - lines.length} 件は省略）`); break; }
    lines.push(l); used += l.length + 1;
  }
  return lines.join('\n');
}

/** 台帳を Markdown 成果物にする（REQ-00）。 */
export function ledgerMarkdown(p) {
  const items = ledgerItems(p);
  const by = {};
  for (const it of items) (by[it.kind] ||= []).push(it);
  const sc = (p.ledger && p.ledger.scanned) || {};
  const head = `# 要件台帳\n\n入力資料 ${sc.files || 0} 本（${Math.round((sc.bytes || 0) / 1024)}KB）を全文走査し、ID 付きの要件項目 ${items.length} 件を抽出しました。`
    + '要約ではなく原文の ID をそのまま保持します。下流の WBS・モジュールはこの ID でトレースされます。\n';
  const sections = KINDS.filter(k => by[k]).map(k => `\n## ${k}（${by[k].length} 件）\n\n| ID | 名称 | 親 | 出現 | 出典 |\n| --- | --- | --- | --- | --- |\n`
    + by[k].map(it => `| ${it.id} | ${it.name || '—'} | ${it.parent || ''} | ${it.refs || 0} | ${(it.sources || []).slice(0, 2).map(s => `${s.file}:${s.line}`).join(', ') || it.origin || ''} |`).join('\n'));
  return head + sections.join('\n');
}

/** モジュールが担当する ID（枝番は親 ID でカバーされたものとみなす）。 */
const coveredBy = (p) => {
  const map = new Map();
  for (const m of p.modules || []) for (const id of m.req_ids || []) (map.get(id) || map.set(id, []).get(id)).push(m);
  return map;
};

/**
 * 網羅率：台帳の各項目が どのモジュールに割り当てられ（planned）、全て承認済みか（implemented）。
 * 返り値：{ total, planned, implemented, uncovered: [id], byKind: {kind: {total, planned, implemented}}, rows }
 */
export function coverage(p) {
  const items = ledgerItems(p);
  const cov = coveredBy(p);
  const rows = items.map(it => {
    const mods = cov.get(it.id) || (it.parent && cov.get(it.parent)) || [];
    const status = !mods.length ? 'uncovered' : mods.every(m => m.status === 'approved') ? 'implemented' : 'planned';
    return { ...it, modules: mods.map(m => m.id), status };
  });
  const byKind = {};
  for (const r of rows) {
    const k = (byKind[r.kind] ||= { total: 0, planned: 0, implemented: 0 });
    k.total++; if (r.status !== 'uncovered') k.planned++; if (r.status === 'implemented') k.implemented++;
  }
  const planned = rows.filter(r => r.status !== 'uncovered').length;
  const implemented = rows.filter(r => r.status === 'implemented').length;
  const unknown = [...cov.keys()].filter(id => !items.some(it => it.id === id));
  return { total: rows.length, planned, implemented, uncovered: rows.filter(r => r.status === 'uncovered').map(r => r.id), unknown, byKind, rows };
}

/** WBS が返した req_ids を台帳に存在する ID だけに絞る（モデルの創作 ID を落とす）。 */
export function cleanReqIds(p, ids) {
  const known = new Set(ledgerItems(p).map(it => it.id));
  const list = (Array.isArray(ids) ? ids : String(ids || '').split(/[\s,、]+/)).map(s => String(s).trim()).filter(Boolean);
  return known.size ? [...new Set(list.filter(id => known.has(id)))] : [...new Set(list)].slice(0, 40);
}

/* ---------- ③ モジュール依存 DAG ---------- */

/**
 * WBS の epics に deps（先行 Epic の ID 配列）を正規化して付ける。
 * - モデルの deps は "E2" / 2 / Epic 名 のどれでも受ける。自分より前の Epic だけ有効（＝必ず DAG）。
 * - どの Epic にも deps フィールドが無い場合（旧 WBS・形式違反）はレイヤー順で推定：下位レイヤーの Epic すべてに依存。
 */
export function normalizeDeps(epics, layers) {
  const idx = new Map(epics.map((e, i) => [e.id, i]));
  const byName = new Map(epics.map((e, i) => [String(e.name || '').trim(), i]));
  const toIndex = (d) => {
    if (typeof d === 'number') return d - 1;
    const s = String(d || '').trim();
    if (idx.has(s)) return idx.get(s);
    if (/^E?\d+$/i.test(s)) return Number(s.replace(/\D/g, '')) - 1;
    return byName.has(s) ? byName.get(s) : -1;
  };
  const given = epics.some(e => Array.isArray(e.deps));            // deps:[] も「依存なし」と明示されたものとして尊重
  const rank = (l) => { const r = (layers || []).indexOf(l); return r < 0 ? 0 : r; };
  return epics.map((e, i) => {
    const deps = given
      ? [...new Set((e.deps || []).map(toIndex).filter(j => j >= 0 && j < i).map(j => epics[j].id))]
      : epics.slice(0, i).filter(o => rank(o.layer) < rank(e.layer)).map(o => o.id);
    return { ...e, deps, deps_from: given ? 'wbs' : 'layer' };
  });
}

/** モジュールの未承認の依存先（無ければ空配列）。 */
export const blockedBy = (p, mod) => (mod.deps || [])
  .map(id => (p.modules || []).find(m => m.id === id))
  .filter(m => m && m.status !== 'approved');

/** 依存グラフを DAG 順（トポロジカル順）に並べたモジュール ID 列。循環があれば残りを元の順で末尾に。 */
export function dagOrder(mods) {
  const done = new Set(), out = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const m of mods) {
      if (done.has(m.id)) continue;
      if ((m.deps || []).every(d => done.has(d) || !mods.some(x => x.id === d))) { done.add(m.id); out.push(m.id); progress = true; }
    }
  }
  return [...out, ...mods.filter(m => !done.has(m.id)).map(m => m.id)];
}

/* ---------- ④ 段階別スキル割当（BMAD v6 を主軸に統合） ---------- */

/**
 * 各段階：primary = 手順を決める主軸ワークフロー（1 本）、checklist = Verifier が照合する既存プリセット、
 * project = 案件専用スキルの推奨枠（中身は案件側で書く）、exclude = 外す・置換するプリセット。
 */
export const STAGE_SKILL_PLAN = {
  requirements: {
    primary: ['bmad6-requirements'],
    checklist: ['requirements-ids-and-acceptance', 'requirements-nonfunctional-metrics', 'agx-spec-driven-development'],
    project: ['仕様書 → 要件台帳変換（機能・テーブル・IF・帳票 ID）'],
    exclude: ['bmad-brainstorming', 'bmad-brief', 'agx-idea-refine', 'agx-interview-me'],
  },
  ux: {
    primary: ['bmad6-ux'],
    checklist: ['ux-information-architecture', 'ux-accessibility-and-copy', 'ux-usability-checklist', 'agx-frontend-ui-engineering'],
    project: ['HTML プロトタイプ + 撮影 + 視覚レビュー', '現行画面の型（検索・一覧・明細・ファンクションキー）'],
    exclude: ['bmad-ux'],
  },
  architecture: {
    primary: ['bmad6-architecture'],
    checklist: ['architecture-data-consistency', 'architecture-layering-contracts', 'architecture-security-design', 'agx-api-and-interface-design', 'agx-documentation-and-adrs'],
    project: ['実スタック構成（フレームワーク・DB）', 'インフラ・ネットワーク制約', '外部データ連携', 'DDL 自動生成'],
    exclude: ['bmad-architecture'],
  },
  wbs: {
    primary: ['bmad6-planning'],
    checklist: ['wbs-module-granularity', 'wbs-estimate-and-dependencies', 'agx-planning-and-task-breakdown'],
    project: ['機能スライス分割規約（機能 ID 単位・依存順）'],
    exclude: [],
  },
  development: {
    primary: ['bmad6-dev-story'],
    checklist: ['development-general-conventions', 'development-review-checklist', 'agx-test-driven-development', 'agx-incremental-implementation', 'agx-debugging-and-error-recovery', 'agx-git-workflow-and-versioning'],
    project: ['固定長・CSV など外部 IF 規約', 'Excel / PDF 帳票'],
    exclude: ['bmad-build', 'bmad-code-review'],
  },
  testing: {
    primary: ['bmad6-tea-testing'],
    checklist: ['testing-case-design', 'testing-coverage-matrix', 'testing-perf-and-security', 'agx-browser-testing-with-devtools'],
    project: ['データ移行検証（重複・欠落）'],
    exclude: ['bmad-qa-generate-e2e-tests'],
  },
  deployment: {
    primary: [],
    checklist: ['deployment-config-and-secrets', 'deployment-release-and-rollback', 'agx-ci-cd-and-automation'],
    project: ['インフラ IaC・計画停止手順'],
    exclude: ['deployment-pipeline-and-canary'],
  },
  operations: {
    primary: ['bmad6-retrospective'],
    checklist: ['operations-monitoring-runbook', 'operations-backup-and-restore', 'operations-incident-response', 'agx-observability-and-instrumentation'],
    project: ['問合せ対応と障害一次切り分け'],
    exclude: ['bmad-retrospective'],
  },
  '': {
    primary: [],
    checklist: ['security-baseline', 'agx-context-engineering', 'agx-constraint-driven-development', 'agx-doubt-driven-development'],
    project: ['セキュリティ基準（発注者固有）', '個人情報の取扱い'],
    exclude: ['agx-using-agent-skills'],
  },
};

/** 技術スタック → 開発段階に入れる言語別規約（先にマッチしたもの）。null = 該当プリセットなし（要新設）。 */
const STACK_SKILLS = [
  { re: /nest|next\.?js/i, id: 'dev-nestjs-nextjs-postgres' },
  { re: /spring/i, id: 'dev-java-springboot' },
  { re: /struts/i, id: 'dev-java-struts' },
  { re: /\bcap\b|\bcds\b|\brap\b/i, id: 'dev-sap-cap-rap' },
  { re: /react|vite/i, id: 'dev-react-vite' },
  { re: /python/i, id: 'dev-python' },
  { re: /static|html5/i, id: 'dev-static-site' },
  { re: /node/i, id: 'dev-nodejs' },
];
const DEV_STACK_IDS = ['dev-nestjs-nextjs-postgres', 'dev-java-springboot', 'dev-java-struts', 'dev-sap-cap-rap', 'dev-react-vite', 'dev-python', 'dev-static-site', 'dev-nodejs'];

/** プロジェクトの段階一覧と技術スタックに合わせた割当（言語別規約は stack で 1 本に絞る）。 */
export function skillPlanFor(stageIds, stack) {
  const hit = STACK_SKILLS.find(s => s.re.test(String(stack || '')));
  const plan = {};
  for (const sid of [...stageIds, '']) {
    const base = STAGE_SKILL_PLAN[sid];
    if (!base) continue;
    const e = { primary: [...base.primary], checklist: [...base.checklist], project: [...base.project], exclude: [...base.exclude] };
    if (sid === 'development') {
      if (hit && hit.id) e.checklist.unshift(hit.id); else if (hit && hit.need) e.project.unshift(hit.need);
      e.exclude.push(...DEV_STACK_IDS.filter(id => !(hit && hit.id === id)));
    }
    plan[sid] = e;
  }
  return plan;
}

/** プリセット ID → 割当上の役割（どの段階にも無ければ null）。 */
export function planRole(presetId) {
  for (const e of Object.values(STAGE_SKILL_PLAN)) {
    if (e.primary.includes(presetId)) return 'primary';
    if (e.checklist.includes(presetId)) return 'checklist';
  }
  return DEV_STACK_IDS.includes(presetId) ? 'checklist' : null;
}

export const ROLES = ['primary', 'checklist', 'project'];
/** スキルの役割：明示 > プリセットの割当 > プリセット由来は checklist > 人が書いたものは project（案件専用）。 */
export function roleOf(s) {
  if (s && ROLES.includes(s.role)) return s.role;
  if (s && s.from === 'workspace') return 'project';
  const preset = s && s.preset ? s.preset : (String((s && s.by) || '').match(/^Preset (\S+)/) || [])[1];
  if (preset) return planRole(preset) || 'checklist';
  return 'project';
}
export const presetIdOf = (s) => (s && s.preset) || (String((s && s.by) || '').match(/^Preset (\S+)/) || [])[1] || null;

/* ---------- ⑤ 疑問・変更台帳（曖昧さのフィードバックループ） ---------- */

export const questionsOf = (p) => (p && Array.isArray(p.questions) ? p.questions : []);
const QTEXT_MAX = 1000;

/**
 * 開発エージェントが返した questions を正規化：テキスト必須、req_ids は台帳に在るものだけ。
 * req_ids が空（または全部創作 ID）ならモジュール自身の担当 ID に紐づける（どこにも紐づかない疑問は影響分析できない）。
 */
export function cleanQuestions(p, raw, mod) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const q of raw.slice(0, 10)) {
    const text = String((q && (q.text || q.question)) || (typeof q === 'string' ? q : '')).trim().slice(0, QTEXT_MAX);
    if (!text) continue;
    let ids = cleanReqIds(p, q && q.req_ids);
    if (!ids.length) ids = [...((mod && mod.req_ids) || [])];
    out.push({ text, req_ids: ids });
  }
  return out;
}

/** モジュールを止めている未回答の疑問：自分が出したもの + 担当 ID が重なるもの（曖昧な仕様の上に作らない）。 */
export function heldBy(p, mod) {
  const mine = new Set(mod.req_ids || []);
  return questionsOf(p).filter(q => q.status === 'open'
    && (q.module === mod.id || (q.req_ids || []).some(id => mine.has(id))));
}

/** 枝番 → 親（Jsh230L01 → Jsh230）。 */
const parentMap = (p) => new Map(ledgerItems(p).filter(it => it.parent).map(it => [it.id, it.parent]));

/**
 * 回答の影響分析：疑問の req_ids（と親 ID）を担当するモジュール + 質問元モジュール → それらに deps で依存するモジュール（推移的）。
 * 返り値：{ direct: [id], dependents: [id], all: [id]（DAG 順） }
 */
export function impactOf(p, q) {
  const mods = p.modules || [];
  const par = parentMap(p);
  const ids = new Set(q.req_ids || []);
  for (const id of q.req_ids || []) if (par.has(id)) ids.add(par.get(id));
  const hit = (id) => ids.has(id) || ids.has(par.get(id));            // 枝番と親は同じ要件とみなす
  const direct = new Set(mods.filter(m => m.id === q.module || (m.req_ids || []).some(hit)).map(m => m.id));
  const all = new Set(direct);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of mods) if (!all.has(m.id) && (m.deps || []).some(d => all.has(d))) { all.add(m.id); grew = true; }
  }
  const order = dagOrder(mods).filter(id => all.has(id));
  return { direct: order.filter(id => direct.has(id)), dependents: order.filter(id => !direct.has(id)), all: order };
}

/* ---------- ⑥ 教訓（差し戻し・回答 → 案件専用スキル） ---------- */

export const lessonsOf = (p) => (p && Array.isArray(p.lessons) ? p.lessons : []);
/** 教訓を追記する案件専用スキルの名前（段階ごとに 1 本）。 */
export const lessonSkillName = (stageId) => `Lessons learned${stageId ? ` (${stageId})` : ''}`;

/** 教訓の下書き（LLM を使わない決定的な文面）。人が編集してから承認する。 */
export function lessonDraft(src) {
  if (src.kind === 'question') {
    const ids = (src.req_ids || []).join(', ');
    return `- ${ids ? `[${ids}] ` : ''}${oneLine(src.question)} → ${oneLine(src.answer)}`;
  }
  const who = src.module ? `${src.module}${src.name ? ` "${src.name}"` : ''}` : (src.stage || '');
  return `- [${src.category || 'review'}] ${oneLine(src.comment)}${who ? ` (rejected: ${who})` : ''}`;
}
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 600);
