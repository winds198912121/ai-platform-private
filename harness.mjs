/* ============================================================
   harness.mjs — 交付状态机(本project的大脑)
   规则(不可绕过，サーバーで強制):
     1. stage按顺序推进，前一stage未批准，后一stage不可execute。
     2. 每个stage AI execute完 → 进入"等待审核"，必须Human批准才推进。
     3. reject → 回到execute(attempts/version +1)，反馈喂回模型，重做后再次送审。
     4. WBS stage的交付物 = module清单；开发stage逐moduleexecute：
        真实生成代码 → real-ran node --test → 必须 FAIL=0 且Human批准，
        才能进入/一modules；全部module批准后开发stage闭合，进入結合テスト。
     5. ゲート方針(governance.mjs)：human_gate では自動承認・API 直叩きの承認を拒否、
        auto でも human_gates(既定：要件・アーキ)は人の承認必須。モジュールは依存(deps)が承認済みになるまで着手しない。
   证据来源：所有测试数字都来自 exec.mjs 真实execute，不是编出来的。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sim from './sim.mjs';
import * as agent from './agent.mjs';
import * as exec from './exec.mjs';
import * as G from './governance.mjs';
import * as PX from './prototype.mjs';
import * as capture from './capture.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(DIR, 'data');
export const DATA_FILE = process.env.AI_PLATFORM_DATA || path.join(DATA_DIR, 'projects.json');

/** 'live' = 调真实模型(default)；'sim' = offline template通道(显式选择，界面会标明)。 */
const PROVIDER = process.env.AI_PLATFORM_PROVIDER === 'sim' ? 'sim' : 'live';
export const channelInfo = () => PROVIDER === 'sim'
  ? { channel: 'sim', provider: 'offline', model: null }
  : { ...agent.info(), channel: 'live' };

/** 开发stage的并行度：同时几个 Dev Agent 在写代码。1 = 老的串行语义。 */
const CONC = Math.max(1, Math.min(8, Number(process.env.AI_PLATFORM_CONCURRENCY || 3) || 3));
const AGENTS = Array.from({ length: CONC }, (_, i) => `Dev-Agent-${i + 1}`);
export const runtimeInfo = () => ({ concurrency: CONC, agents: AGENTS, provider: PROVIDER });

/** 找一个空闲的 Agent 名(正在跑's module占着槽位)。 */
function freeAgent(p) {
  const used = new Set(p.modules.filter(m => m.status === 'running').map(m => m.agent));
  return AGENTS.find(a => !used.has(a)) || AGENTS[0];
}

export const STAGES = [
  { id: 'requirements', name: 'Requirements', agent: 'BA Agent', kind: 'artifacts' },
  { id: 'ux', name: 'UI/UX Design', agent: 'UX Agent', kind: 'artifacts' },
  { id: 'architecture', name: 'Architecture', agent: 'Architecture Agent', kind: 'artifacts' },
  { id: 'wbs', name: 'WBS Breakdown', agent: 'Task Planner', kind: 'wbs' },
  { id: 'development', name: 'Module Development', agent: 'Dev Agent', kind: 'development' },
  { id: 'testing', name: 'Integration Testing', agent: 'QA Agent', kind: 'artifacts' },
  { id: 'deployment', name: 'Deployment', agent: 'DevOps Agent', kind: 'artifacts' },
  { id: 'operations', name: 'Operations', agent: 'SRE Agent', kind: 'artifacts' },
];

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/* ---------- Workflow(harness 变体): 按客户的project需求选不同的stage序列 ----------
   预设而已：一Workflow就是"stage id 的有序子集"。约束两 ——
   ① id 必须来自 STAGES；② 带 development 的必须同时带 wbs(module是 WBS 计划出来的，没 WBS 就没module可开发)。
   老project没 has workflow 字段 = 全流程，照旧。 */
export const WORKFLOWS = [
  { id: 'full', name: 'Standard Pipeline', hint: 'Requirements → UX → Architecture → WBS → Development → Testing → Deployment → Operations',
    stages: ['requirements', 'ux', 'architecture', 'wbs', 'development', 'testing', 'deployment', 'operations'] },
  { id: 'lean', name: 'Lean Delivery', hint: 'Requirements → Architecture → WBS → Development → Testing (no UX / Deployment / Operations — typical for backend / API projects)',
    stages: ['requirements', 'architecture', 'wbs', 'development', 'testing'] },
  { id: 'prototype', name: 'Prototype', hint: 'Requirements → UX → WBS → Development (just to see it running; no Testing / Deployment / Operations)',
    stages: ['requirements', 'ux', 'wbs', 'development'] },
  { id: 'change', name: 'Change / Maintenance', hint: 'Requirements → WBS → Development → Testing → Deployment (modifying an existing system — skip UX and Architecture)',
    stages: ['requirements', 'wbs', 'development', 'testing', 'deployment'] },
  { id: 'design', name: 'Design Only', hint: 'Requirements → UX → Architecture → WBS (only design and task plan; no code)',
    stages: ['requirements', 'ux', 'architecture', 'wbs'] },
  { id: 'website', name: 'Website / Static', hint: 'Requirements → UX → Architecture → WBS → Development → Testing → Deployment (content site — no Operations)',
    stages: ['requirements', 'ux', 'architecture', 'wbs', 'development', 'testing', 'deployment'] },
  { id: 'service', name: 'Backend Service / API', hint: 'Requirements → Architecture → WBS → Development → Testing → Deployment → Operations (no UI — skip UX)',
    stages: ['requirements', 'architecture', 'wbs', 'development', 'testing', 'deployment', 'operations'] },
  { id: 'data', name: 'Data Processing / Migration', hint: 'Requirements → Architecture → WBS → Development → Testing → Deployment (batch / migration / reports — skip UX and Operations)',
    stages: ['requirements', 'architecture', 'wbs', 'development', 'testing', 'deployment'] },
  { id: 'devflow', name: 'DevFlow (BMAD)', hint: 'Requirements → UX → Architecture → Development → Testing → Deployment → Operations (BMAD method: task breakdown lives inside Development — no separate WBS stage)',
    stages: ['requirements', 'ux', 'architecture', 'development', 'testing', 'deployment', 'operations'] },
];
export const workflowOf = (p) => WORKFLOWS.find(w => w.id === ((p && p.workflow) || 'full')) || WORKFLOWS[0];
/** project's actual stages (in workflow order, objects from STAGES)。 */
export const stagesOf = (p) => workflowOf(p).stages.map(id => STAGES.find(s => s.id === id)).filter(Boolean);
/** Workflow self-check: unique ids, all stages exist in STAGES, development requires WBS. Run this before adding workflows (unit tests call it).。 */
export function checkWorkflows() {
  const ids = new Set(STAGES.map(s => s.id));
  const errs = [];
  for (const w of WORKFLOWS) {
    if (!w.id || !w.name || !w.stages.length) errs.push(`${w.id || '(no id)'}: missing id/name/stages`);
    const dup = w.stages.filter((x, i) => w.stages.indexOf(x) !== i);
    if (dup.length) errs.push(`${w.id}: duplicate phase ${dup.join('、')}`);
    for (const s of w.stages) if (!ids.has(s)) errs.push(`${w.id}: unknown phase ${s}`);
    if (w.stages.includes('development') && !w.stages.includes('wbs')) errs.push(`${w.id}: has development but no WBS (no modules to develop)`);
  }
  if (!WORKFLOWS.some(w => w.id === 'full')) errs.push('missing full');
  return errs;
}

/* ---------- Software type: picking one sets default workflow + tech-stack suggestion (all options run on the platform's four real runtimes) ---------- */

export const TYPES = [
  { id: 'webapp', name: 'Web Application', workflow: 'full', hint: 'Frontend + backend + database, full pipeline',
    techs: ['Next.js + NestJS + PostgreSQL', 'Java 21 + Spring Boot 3.3 + PostgreSQL 16', 'Vue 3 + Express + SQLite'],
    layers: ['core', 'domain', 'service', 'api', 'ui'],
    skills: ['development-general-conventions', 'dev-code-layout', 'security-baseline', 'env-bootstrap',
      'dev-nestjs-nextjs-postgres', 'dev-nodejs', 'dev-java-springboot', 'architecture-layering-contracts', 'testing-coverage-matrix',
      'agx-code-review-and-quality', 'agx-test-driven-development'] },
  { id: 'website', name: 'Website / Static', workflow: 'website', hint: 'Content site: build UI and pages, no Operations',
    techs: ['HTML5 + CSS3 + vanilla JavaScript (ES Modules) static site', 'React + Vite static site', 'SAP CAP Node.js (content + OData service)'],
    layers: ['core', 'content', 'ui', 'app'],
    skills: ['development-general-conventions', 'dev-code-layout', 'security-baseline', 'env-bootstrap',
      'dev-static-site', 'dev-react-vite', 'ux-information-architecture', 'deployment-release-and-rollback',
      'agx-frontend-ui-engineering', 'agx-performance-optimization'] },
  { id: 'service', name: 'Backend Service / API', workflow: 'service', hint: 'No UI: API + data + deploy + operations',
    techs: ['Java 21 + Spring Boot 3.3 + PostgreSQL 16', 'Node.js 22 + Fastify + SQLite', 'Python 3.12 + FastAPI + PostgreSQL'],
    layers: ['core', 'domain', 'api', 'repo'],
    skills: ['development-general-conventions', 'dev-code-layout', 'security-baseline', 'env-bootstrap',
      'dev-java-springboot', 'dev-nodejs', 'dev-python', 'architecture-data-consistency', 'operations-monitoring-runbook',
      'agx-security-and-hardening', 'agx-observability-and-instrumentation'] },
  { id: 'cli', name: 'Tool / Script', workflow: 'lean', hint: 'CLI tool: must run, must have tests; no deployment',
    techs: ['Node.js 22 (zero-dep CLI)', 'Python 3.12 (argparse + unittest)', 'Java 21 (single-jar CLI tool)'],
    layers: ['core', 'cli', 'io'],
    skills: ['development-general-conventions', 'dev-code-layout', 'security-baseline', 'env-bootstrap',
      'dev-nodejs', 'dev-python', 'development-review-checklist', 'agx-debugging-and-error-recovery'] },
  { id: 'data', name: 'Data Processing / Migration', workflow: 'data', hint: 'Batch / migration / reports: validation + cutover',
    techs: ['Python 3.12 (stdlib csv/json + unittest)', 'Python 3.12 + in-memory tables (batch ETL + validation)', 'Node.js 22 (streaming read/write + validation)'],
    layers: ['core', 'io', 'transform', 'report'],
    skills: ['development-general-conventions', 'dev-code-layout', 'security-baseline', 'env-bootstrap',
      'dev-python', 'dev-nodejs', 'architecture-data-consistency', 'testing-perf-and-security',
      'agx-incremental-implementation', 'agx-performance-optimization'] },
  { id: 'devflow', name: 'DevFlow Delivery', workflow: 'devflow', hint: 'BMAD-method delivery: AI agents handle execution per stage, FDE focuses on review & approval across all 7 stages',
    techs: ['Next.js + NestJS + PostgreSQL', 'Java 21 + Spring Boot 3.3 + PostgreSQL 16', 'Node.js 22 + Fastify + SQLite'],
    layers: ['core', 'domain', 'service', 'api', 'ui'],
    skills: [
      // BMAD v6 primary workflows (one per stage; replaces the 8 legacy bmad-* presets — see governance.STAGE_SKILL_PLAN)
      'bmad6-requirements', 'bmad6-ux', 'bmad6-architecture', 'bmad6-planning',
      'bmad6-dev-story', 'bmad6-tea-testing', 'bmad6-retrospective',
      // existing platform skills (per-stage)
      'requirements-interview-and-conflict', 'requirements-ids-and-acceptance',
      'ux-information-architecture',
      'architecture-layering-contracts',
      'development-general-conventions', 'dev-nestjs-nextjs-postgres', 'dev-nodejs', 'dev-java-springboot',
      'testing-coverage-matrix',
      'deployment-release-and-rollback',
      'operations-monitoring-runbook',
      'security-baseline', 'env-bootstrap',
    ] },
];
/** Unknown / empty type = first entry (Web Application). */
export const typeOf = (id) => TYPES.find(t => t.id === id) || TYPES[0];
/** type自检：id 唯一、指向的流程必须存在、Tech stack建议/skill/Folder convention都要有(单测会调)。 */
export function checkTypes() {
  const errs = [], seen = new Set();
  const cat = new Set(skillCatalog().map(c => c.id));
  for (const t of TYPES) {
    if (!t.id || !t.name) errs.push(`${t.id || '(no id)'}: missing id/name`);
    if (seen.has(t.id)) errs.push(`${t.id}: duplicate id`);
    seen.add(t.id);
    if (!WORKFLOWS.some(w => w.id === t.workflow)) errs.push(`${t.id}: points to non-existent workflow ${t.workflow}`);
    if (!Array.isArray(t.techs) || t.techs.length < 2) errs.push(`${t.id}: must give at least 2 tech-stack suggestions`);
    for (const s of t.techs || []) if (!String(s).trim()) errs.push(`${t.id}: has empty tech-stack suggestion`);
    if (!Array.isArray(t.skills) || !t.skills.length) errs.push(`${t.id}: no skills configured`);
    for (const s of t.skills || []) if (!cat.has(s)) errs.push(`${t.id}: Skill ${s} not in preset library`);
    if (!Array.isArray(t.layers) || !t.layers.length) errs.push(`${t.id}: no folder convention (layer list) configured`);
    const dup = (t.layers || []).filter((x, i) => t.layers.indexOf(x) !== i);
    if (dup.length) errs.push(`${t.id}: duplicate layer list ${dup.join('、')}`);
    for (const l of t.layers || []) if (!/^[a-z][a-z0-9-]*$/.test(l)) errs.push(`${t.id}: layer name ${l} invalid (lowercase letters / digits / hyphens)`);
  }
  return errs;
}
/** 分类自带的配置包(Skill + Folder convention)，供界面与创建流程用。 */
export const packOf = (id) => { const t = typeOf(id); return { skills: t.skills || [], layers: t.layers || [], techs: t.techs || [] }; };

/* ---------- 各stage的调用Model ----------
   project里按stage定义(p.models[stageId])；没定义 → default DeepSeek(agent.DEFAULT_MODEL)。
   定义只在"本轮要调模型"时读一次，已批准stage/已donemodule的历史不受影响。 */

export const stagesMeta = () => STAGES.map(({ id, name, agent: a, kind }) => ({ id, name, agent: a, kind }));
export const DEFAULT_MODEL = agent.DEFAULT_MODEL;
export const modelFor = (p, stageId) => agent.modelFor(p, stageId);
/** 事件流里的通道描述：sim 通道不报模型名。 */
const channelTag = (p, stageId) => (PROVIDER === 'sim' ? 'offline template' : modelFor(p, stageId));

/** 只认流水线里的stage id；值必须是非空 chars串(≤64  chars)；空值 = 未定义(回到缺省)。 */
export function sanitizeModels(input) {
  const ids = new Set(STAGES.map(s => s.id));
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    const m = String(v ?? '').trim();
    if (ids.has(k) && m && m.length <= 64) out[k] = m;
  }
  return out;
}

/** 合并式update：传空串即delete该stage的定义(回到default deepseek)。 */
export function setStageModels(p, models) {
  const next = sanitizeModels({ ...(p.models || {}), ...models });
  const before = p.models || {};
  for (const s of STAGES) {
    const a = before[s.id] || '', b = next[s.id] || '';
    if (a === b) continue;
    pushEvent(p, { stage: 'project', kind: 'info', text: `Stage model: ${s.name} ${a ? `custom ${a}` : `default ${DEFAULT_MODEL}`} → ${b ? `custom ${b}` : `default ${DEFAULT_MODEL}`}` });
  }
  p.models = next;
  save();
  return next;
}


const SPEED = (() => { const v = Number(process.env.AI_PLATFORM_SPEED); return Number.isFinite(v) ? v : 1; })();
const delay = (ms) => new Promise(r => setTimeout(r, SPEED <= 0 ? 1 : Math.max(1, ms / SPEED)));

let db = { version: 1, active: null, projects: [] };
const subs = new Set();
const busy = new Set();
const timers = new Map();

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
function emit(ev) { for (const fn of subs) { try { fn(ev); } catch { /* 订阅者出错不影响主流程 */ } } }

const now = () => new Date().toISOString();

/* ---------- 持久化 ---------- */

export function load() {
  try { if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { console.error('[harness] load failed: ', e.message); }
  if (!db.projects) db = { version: 1, active: null, projects: [] };
  // 进程重启后没有"正在execute"可言：把残留的 running 归位，否则project看起来永远在跑(也挡住重建/重跑)
  let fixed = 0;
  for (const p of db.projects) {
    const stuck = [...p.stages.filter(s => s.status === 'running'), ...p.modules.filter(m => m.status === 'running')];
    for (const x of stuck) { x.status = 'failed'; x.error = 'server restart interrupted(in-process execution cannot survive a restart)—— — just re-run'; }
    if (stuck.length) { fixed += stuck.length; pushEvent(p, { stage: 'project', kind: 'error', text: `⚠ Server restart: ${stuck.length}  "running" task(s) moved to "failed"(${stuck.map(x => x.id).join('、')})，— just re-run` }); }
    // 老逻辑遗留：module单测没过也被标成"等待批准"→ retry循环看不见它，人也没得批。归位为failed，让自动retry接手。
    const parked = (p.modules || []).filter(m => m.status === 'awaiting_review' && m.unit_tests
      && (m.unit_tests.exit_code !== 0 || m.unit_tests.failed > 0 || !m.unit_tests.total));
    for (const m of parked) {
      m.status = 'failed';
      m.error = `単体テスト failed: PASS=${m.unit_tests.passed} FAIL=${m.unit_tests.failed}(exit code ${m.unit_tests.exit_code})—— marked failed and queued for retry`;
    }
    if (parked.length) {
      fixed += parked.length;
      pushEvent(p, { stage: 'development', kind: 'error', text: `⚠ ${parked.length}  module(s) marked awaiting-review despite failing tests (legacy)→ moved to failed and re-queued: ${parked.map(m => m.id).join('、')}` });
      syncDevelopment(p);
    }
    if ((p.modules || []).some(m => m.status === 'failed' && (m.attempts || 0) < 3)) resume.add(p);   // 有可retry的failedmodule → 启动后接着跑
    else {
      const st = (p.stages || []).find(s => s.status === 'failed' && (s.attempts || 0) < 3);          // failedstage同理(retry封顶 3 attempts)
      if (st) resume.add(p);
    }
  }
  if (fixed) save();
  for (const p of resume) kick(p);          // 不用等人点：retry由门禁与 attempts<3 兜住
}
const resume = new Set();
let saveT = null;
export function save() { clearTimeout(saveT); saveT = setTimeout(flush, 120); }
export function flush() {
  clearTimeout(saveT); saveT = null;
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('[harness] save failed: ', e.message); }
}

/* ---------- 查询 ---------- */

export const state = () => db;
export const get = (id) => db.projects.find(p => p.id === id);
export function must(id) { const p = get(id); if (!p) throw new HttpError(404, `Project not found: ${id}`); return p; }
export function currentStage(p) { return p.stages.find(s => s.status !== 'approved') || null; }
const lastFeedback = (x) => {
  const fb = baseFeedback(x);
  if (!x.feedback) return fb;                     // 疑問への回答（影響分析で戻されたとき）は差し戻し・テスト結果と一緒に渡す
  return fb ? { category: `${x.feedback.category} + ${fb.category}`, comment: `${x.feedback.comment}\n${fb.comment}` } : x.feedback;
};
const baseFeedback = (x) => {
  if (x.review && x.review.decision === 'rejected') return { category: x.review.category, comment: x.review.comment };
  // 自动retry：把上一轮**真实测试输出**喂回去，模型才知道哪断言挂了(否则只会盲目重生成)
  const u = x.unit_tests;
  if (u && (u.failed > 0 || u.exit_code !== 0 || !u.total)) {
    const ev = {
      category: '単体テスト未通过',
      comment: `Previous execution: "${u.cmd}"→ PASS=${u.passed} FAIL=${u.failed}，exit code ${u.exit_code}。`
        + `Fix all failures before returning output. Every assertion must pass against your implementation; honor explicit parameters instead of falling back to global state. Actual output tail:\n${String(u.tail || '').slice(-1200)}`,
    };
    if (x.error) ev.comment = `${x.error}\n${ev.comment}`;
    return ev;
  }
  return null;
};

/** transient failure(空响应 / 网络 / 限流 / 网关)——不是模型的"答案"，不该吃掉 3 轮retry预算。 */
export const isTransientModelError = (msg) => /empty content|EMPTY|Invalid JSON|Unexpected end|Unexpected token|timeout|timed out|ECONNRESET|fetch failed|socket hang up|\b429\b|\b50[234]\b/i.test(String(msg || ''));

/** transient failure统一处理(stage / module共用): 原地重排、attempts 回退，max 2 次；back true = 已按transient failure处理。 */
export function transientBounce(p, x, stageId, label, msg) {
  if (!(isTransientModelError(msg) && (x.transient || 0) < 2)) return false;
  x.transient = (x.transient || 0) + 1;
  x.attempts = Math.max(0, (x.attempts || 0) - 1);
  x.status = 'failed';
  x.error = `${msg}(transient failure, in-place re-queue，no retry-budget cost ${x.transient}/2)`;
  pushEvent(p, { stage: stageId, kind: 'error', text: `⚠ ${label} ${x.id}${x.name ? `"${x.name}"` : ''}${msg} → transient failure, in-place re-queue (does not count toward 3-retry budget)` });
  return true;
}

/* ---------- 事件流 ---------- */

function pushEvent(p, { stage = 'system', kind = 'info', text }) {
  const ev = { ts: now(), stage, kind, text };
  p.events.push(ev);
  if (p.events.length > 800) p.events.splice(0, p.events.length - 800);
  p.updated_at = ev.ts;
  emit({ type: 'event', projectId: p.id, event: ev });
  emit({ type: 'state', projectId: p.id });
}

// 只上报已到达的执行节点；模型调用期间不按时间伪造百分比。
function setProgress(p, item, percent, label) {
  item.progress = percent;
  item.progress_label = label;
  save();
  emit({ type: 'state', projectId: p.id });
}

/* ---------- 创建project(初始入口) ---------- */

/** 分类自带的源码Folder convention(new/重建/换分类都回到它；架构stage声明合法层清单时可覆盖)。 */
const typeArch = (ty, tech = '') => ({
  layers: [...ty.layers], declared: false, from: 'type-default',
  stack: '', stackFrom: 'none', profile: exec.profileOf(tech).id, at: now(),
});

export function createProject(input = {}) {
  const id = 'P-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const ty = typeOf(input.type);
  const wf = WORKFLOWS.find(w => w.id === input.workflow)                     // explicit workflow wins
    || WORKFLOWS.find(w => w.id === ty.workflow) || WORKFLOWS[0];             // else default from type
  const p = {
    id,
    type: ty.id,
    name: (input.name || '').trim() || 'Untitled project',
    brief: (input.brief || '').trim(),
    tech: (input.tech || '').trim(),
    mode: input.mode === 'auto' ? 'auto' : 'human_gate',
    human_gates: sanitizeGates(input.human_gates),  // auto モードでも人の承認が必須な段階(既定：要件・アーキ)
    workflow: wf.id,
    provider: channelInfo().channel,
    created_at: now(), updated_at: now(),
    stages: buildStages(wf),
    wbs: { epics: [], task_count: 0 },
    arch: typeArch(ty, (input.tech || '').trim()),                          // 分类自带的源码Folder convention(架构stage可覆盖)
    models: sanitizeModels(input.models),           // 各stage调用模型；未定义 = default deepseek
    modules: [],
    inputs: [],                                    // newproject时upload的inputmaterials
    skills: [],                                    // projectskill库：用户写的工程约定 + 分类自带skill，每次模型调用都带上
    events: [],
  };
  db.projects.push(p);
  db.active = id;
  const ci = channelInfo();
  pushEvent(p, { stage: 'project', kind: 'created', text: `Project "${p.name}" created · Type: ${ty.name} · Workflow: ${wf.name}(${p.stages.length}  stages) · Category skill pack: ${ty.skills.length} skills (one-click import on Skills page)· Folder convention ${ty.layers.join(' / ')} · entry mode: ${p.mode === 'auto' ? 'AI auto-approve' : 'Manual review'} · Channel: ${ci.channel === 'live' ? `real model (default ${DEFAULT_MODEL})` : 'offline template'}` });
  if (Array.isArray(input.files) && input.files.length) {          // newproject时upload的inputmaterials
    const { inputs, skipped } = exec.writeInputs(exec.wsDir(p.id), input.files);
    p.inputs = inputs;
    if (inputs.length) pushEvent(p, { stage: 'project', kind: 'artifact', text: `received ${inputs.length}  input file(s): ${inputs.map(i => `${i.name}(${(i.bytes / 1024).toFixed(1)}K)`).join('、')} → workspace/${p.id}/inputs/` });
    if (skipped.length) pushEvent(p, { stage: 'project', kind: 'error', text: `skipped ${skipped.length}  file(s): ${skipped.map(s => `${s.name}(${s.why})`).join('、')}` });
  }
  save();
  kick(p);
  return p;
}

/** human_gates の入力を段階 ID の配列に正規化(未指定 = 既定の高リスク段階)。 */
function sanitizeGates(v) {
  if (v === undefined || v === null) return [...G.HIGH_RISK_STAGES];
  const list = Array.isArray(v) ? v : String(v).split(/[\s,]+/);
  return [...new Set(list.map(String).filter(id => STAGES.some(s => s.id === id)))];
}

/** 老数据没 has inputs 字段——读到就补上。 */
export const inputsOf = (p) => (p.inputs ||= []);

/** 给已有project补inputmaterials(和new时同一套落盘与限制): 同名文件覆盖旧的。 */
export function addInputs(p, files) {
  const { inputs, skipped } = exec.writeInputs(exec.wsDir(p.id), files);
  if (!inputs.length && !skipped.length) throw new HttpError(400, 'no files');
  for (const f of inputs) {
    const i = inputsOf(p).findIndex(x => x.name === f.name);
    if (i >= 0) inputsOf(p)[i] = f; else inputsOf(p).push(f);        // 同名 = 覆盖
  }
  if (inputs.length) pushEvent(p, { stage: 'project', kind: 'artifact', text: `added input files ${inputs.length} : ${inputs.map(i => `${i.name}(${(i.bytes / 1024).toFixed(1)}K)`).join('、')} → workspace/${p.id}/inputs/` });
  if (skipped.length) pushEvent(p, { stage: 'project', kind: 'error', text: `skipped ${skipped.length}  file(s): ${skipped.map(s => `${s.name}(${s.why})`).join('、')}` });
  p.updated_at = now();
  save();
  return { inputs: inputsOf(p), added: inputs.length, skipped };
}

export function activate(id) { if (!get(id)) throw new HttpError(404, 'Project not found'); db.active = id; save(); return db; }

/* ---------- project信息：建完还能改(name / 需求 / Tech stack / Entry mode；Software type与Workflow不在这儿改) ---------- */

const PROJ_MAX = { name: 80, tech: 200, brief: 20000 };
const PROJ_FIELD = { type: 'Software type', workflow: 'Workflow', name: 'Project name', tech: 'Tech stack', brief: 'Requirements', mode: 'Entry mode', human_gates: 'Human-required gates' };

/** 一个全新的stagerecords。 */
const freshStage = (sid) => {
  const s = STAGES.find(x => x.id === sid);
  return { id: s.id, name: s.name, agent: s.agent, kind: s.kind, status: 'pending', attempts: 0, artifacts: [], review: null, error: null, started_at: null, finished_at: null };
};

/** 按Workflow造一套全新stagerecords(newproject用)。 */
export const buildStages = (wf) => wf.stages.map(freshStage);

/** 改type / 流程时的重排：按新流程的顺序排，**能对上的stage保留状态与artifact**，多的补 pending、少的移除records。 */
function mergeStages(p, wf) {
  const kept = [], added = [], gone = [];
  const stages = wf.stages.map(sid => {
    const old = (p.stages || []).find(s => s.id === sid);
    if (old) { kept.push(sid); return old; }
    added.push(sid); return freshStage(sid);
  });
  for (const s of p.stages || []) if (!wf.stages.includes(s.id)) gone.push(s.id);
  return { stages, kept, added, gone };
}

export function updateProject(p, input = {}) {
  const base = { type: p.type || TYPES[0].id, workflow: workflowOf(p).id };
  const next = {
    ...base,
    type: input.type === undefined ? base.type : typeOf(input.type).id,
    workflow: input.workflow !== undefined ? (WORKFLOWS.find(w => w.id === input.workflow) || workflowOf(p)).id
      : input.type !== undefined ? typeOf(input.type).workflow                                    // 只给type → 用它带来的default流程(与new一致)
      : base.workflow,
    name: String(input.name ?? p.name ?? '').trim().slice(0, PROJ_MAX.name),      // 单项夹住上限，防手滑贴进来的长文本撑爆界面
    tech: String(input.tech ?? p.tech ?? '').trim().slice(0, PROJ_MAX.tech),
    brief: String(input.brief ?? p.brief ?? '').trim().slice(0, PROJ_MAX.brief),
    mode: input.mode === undefined ? p.mode : (input.mode === 'auto' ? 'auto' : 'human_gate'),
    human_gates: input.human_gates === undefined ? G.humanGatesOf(p) : sanitizeGates(input.human_gates),
  };
  if (!next.name) throw new HttpError(400, 'Project name cannot be empty');
  const retarget = next.type !== base.type || next.workflow !== base.workflow;
  if (retarget && (p.stages || []).some(s => s.status === 'running')) throw new HttpError(409, 'a stage is running: wait for it to finish before changing software type / workflow');
  const changed = Object.keys(PROJ_FIELD).filter(k => k === 'human_gates'
    ? G.humanGatesOf(p).join(',') !== next.human_gates.join(',')
    : (p[k] || '') !== (next[k] || ''));
  if (!changed.length) return p;                                                  // 没改动就别记事件
  const beforeName = p.name, beforeType = base.type, beforeWf = workflowOf(p);
  let note = '';
  if (retarget) {
    const wf = WORKFLOWS.find(w => w.id === next.workflow);
    const m = mergeStages(p, wf);
    p.type = next.type; p.workflow = wf.id; p.stages = m.stages;
    p.arch = typeArch(typeOf(next.type), next.tech);                              // 换分类/流程 = Folder convention回到新分类自带的那套
    note = ` · Workflow changed to "${wf.name}"(${p.stages.length} stages; retained ${m.kept.length} existing stages`
      + `${m.added.length ? `、added ${m.added.map(id => STAGES.find(s => s.id === id).name).join('、')}` : ''}`
      + `${m.gone.length ? `、removed ${m.gone.map(id => STAGES.find(s => s.id === id).name).join('、')}(artifact records removed; workspace files retained)` : ''})`;
  }
  p.name = next.name; p.tech = next.tech; p.brief = next.brief; p.mode = next.mode; p.human_gates = next.human_gates;
  p.updated_at = now();
  pushEvent(p, { stage: 'project', kind: 'info', text: `Project info edited (${changed.map(k => PROJ_FIELD[k]).join('、')}): `
    + (changed.includes('name') ? `${beforeName} → ${p.name}` : p.name)
    + (retarget ? ` · type ${beforeType} → ${p.type} · workflow ${beforeWf.name} → ${WORKFLOWS.find(w => w.id === p.workflow).name}${note}` : '') });
  save();
  return p;
}

/* ---------- skill库：用户写的工程约定，注入每次Model calling ---------- */

/** 老数据没 has skills 字段——读到就补上，避免各处判空。 */
export const skillsOf = (p) => (p.skills ||= []);
const SKILL_LIMIT = { name: 60, body: 4000, count: 60 };

const cleanSkill = (s = {}) => {
  const name = String(s.name || '').trim().slice(0, SKILL_LIMIT.name);
  const body = String(s.body || '').trim().slice(0, SKILL_LIMIT.body);
  if (!name) throw new HttpError(400, 'Skill name cannot be empty');
  if (!body) throw new HttpError(400, 'Skill body cannot be empty (state what to do / what is forbidden)');
  const raw = String(s.stage ?? '').trim();
  const stage = raw && STAGES.some(x => x.id === raw) ? raw : '';    // empty = all stages; unknown id treated as empty (don't error)
  const role = G.ROLES.includes(s.role) ? s.role : '';               // primary / checklist / project(empty = derived, see G.roleOf)
  return { name, body, stage, role };
};

const stageName = (id) => (STAGES.find(s => s.id === id) || {}).name || 'all stages';

export function addSkill(p, input = {}, { silent = false } = {}) {
  const list = skillsOf(p);
  if (list.length >= SKILL_LIMIT.count) throw new HttpError(400, `Max ${SKILL_LIMIT.count} skills`);
  const { name, body, stage, role } = cleanSkill(input);
  const n = list.reduce((mx, s) => Math.max(mx, Number(String(s.id).replace(/\D/g, '')) || 0), 0) + 1;
  const skill = { id: `SK-${n}`, name, body, stage, added_at: now(), by: String(input.editor || 'Human').slice(0, 40) };
  if (role) skill.role = role;
  if (input.preset) { skill.preset = String(input.preset).slice(0, 80); if (input.desc) skill.desc = String(input.desc).slice(0, 400); }
  list.push(skill);
  if (!silent) pushEvent(p, { stage: 'project', kind: 'artifact', text: `new skill ${skill.id}"${skill.name}"· applies to: ${stageName(stage)} · sent with every model call (total: ${list.length} skills)` });
  save();
  return skill;
}

export function updateSkill(p, sid, input = {}) {
  const skill = skillsOf(p).find(s => s.id === sid);
  if (!skill) throw new HttpError(404, `Skill not found: ${sid}`);
  const { name, body, stage, role } = cleanSkill({ name: input.name ?? skill.name, body: input.body ?? skill.body, stage: input.stage ?? skill.stage, role: input.role ?? skill.role });
  skill.name = name; skill.body = body; skill.stage = stage;
  if (role) skill.role = role; else delete skill.role;
  pushEvent(p, { stage: 'project', kind: 'artifact', text: `Skill ${sid}"${skill.name}"updated · applies to: ${stageName(stage)}` });
  save();
  return skill;
}

export function removeSkill(p, sid) {
  const list = skillsOf(p);
  const i = list.findIndex(s => s.id === sid);
  if (i < 0) throw new HttpError(404, `Skill not found: ${sid}`);
  const [gone] = list.splice(i, 1);
  pushEvent(p, { stage: 'project', kind: 'error', text: `deleted skill ${gone.id}"${gone.name}"(remaining: ${list.length} skills)` });
  save();
  return { ok: true, id: gone.id, count: list.length };
}

/** 批量delete：一次事件记账，逐删；不存在的 id 忽略(幂等，别让整批因为一失效而failed)。 */
export function removeSkills(p, ids) {
  const list = skillsOf(p);
  const want = new Set((Array.isArray(ids) ? ids : []).map(String));
  const gone = list.filter(s => want.has(s.id));
  if (!gone.length) throw new HttpError(404, 'no matching skills to delete');
  for (const g of gone) list.splice(list.indexOf(g), 1);
  pushEvent(p, { stage: 'project', kind: 'error', text: `batch-deleted ${gone.length} skills: ${gone.map(g => `${g.id}"${g.name}"`).join('、')}(remaining: ${list.length} skills)` });
  save();
  return { ok: true, deleted: gone.map(g => g.id), missing: [...want].filter(id => !gone.some(g => g.id === id)), count: list.length };
}

/* ---------- 预设skill库：skills/*.md(随仓库走，改文件即生效) ---------- */

const SKILL_DIR = path.join(DIR, 'skills');

/* ---------- 上游skill(vendor/agent-skills，MIT): 只取"验收 / 红线 / 反合理化"三段 ----------
   上游单个 SKILL.md 均值 13.7KB，比本平台单次注入预算(agent.SKILL_PROMPT_MAX = 12000  chars)还大，
   所以不搬原文：只抽可execute的三段(24/25 个skill都有"Verification / Red Flags / Common Rationalizations")，
   按每上限截断。import进project的是这份切片文本 —— 之后不再依赖 vendor 目录(离线也能用)。 */
const AGX_DIR = path.join(DIR, 'vendor', 'agent-skills');
const AGX_SECTIONS = [/^Verification\b/i, /^Red Flags\b/i, /^Common Rationalizations\b/i];
/** 上游Skill → 本平台stage + 抽取上限( chars)。没进这张表的上游skill不暴露(宁缺勿滥)。 */
export const AGX_MAP = {
  'using-agent-skills':               { stage: '',            max: 800 },
  'context-engineering':              { stage: '',            max: 800 },
  'doubt-driven-development':         { stage: '',            max: 800 },
  'constraint-driven-development':    { stage: '',            max: 1000 },
  'security-and-hardening':           { stage: '',            max: 1000 },
  'interview-me':                     { stage: 'requirements', max: 1000 },
  'idea-refine':                      { stage: 'requirements', max: 900 },
  'spec-driven-development':          { stage: 'requirements', max: 1200 },
  'planning-and-task-breakdown':      { stage: 'wbs',          max: 1200 },
  'api-and-interface-design':         { stage: 'architecture', max: 1200 },
  'documentation-and-adrs':           { stage: 'architecture', max: 1000 },
  'frontend-ui-engineering':          { stage: 'ux',           max: 1200 },
  'incremental-implementation':       { stage: 'development',  max: 1000 },
  'test-driven-development':          { stage: 'development',  max: 1200 },
  'code-review-and-quality':          { stage: 'development',  max: 1200 },
  'code-simplification':              { stage: 'development',  max: 1000 },
  'git-workflow-and-versioning':      { stage: 'development',  max: 1000 },
  'deprecation-and-migration':        { stage: 'development',  max: 1000 },
  'debugging-and-error-recovery':     { stage: 'development',  max: 1200 },
  'source-driven-development':        { stage: 'development',  max: 800 },
  'browser-testing-with-devtools':    { stage: 'testing',      max: 1200 },
  'performance-optimization':         { stage: 'testing',      max: 1000 },
  'ci-cd-and-automation':             { stage: 'deployment',   max: 1200 },
  'shipping-and-launch':              { stage: 'deployment',   max: 1200 },
  'observability-and-instrumentation': { stage: 'operations',  max: 1200 },
};

/** vendor/agent-skills/SOURCE 里记的 commit(没 vendor 过就空 → 整个上游skill层不出现)。 */
export const agxSha = () => { try { return (fs.readFileSync(path.join(AGX_DIR, 'SOURCE'), 'utf8').match(/^sha:\s*(\w+)/m) || [])[1] || ''; } catch { return ''; } };

/** 抽三段拼到 max  chars为止(三段一个都没有就退回各节，照样截断兜底)。 */
function agxSlice(body, max) {
  const secs = body.split(/^## +/m).map((chunk) => {
    const [title, ...rest] = chunk.split('\n');
    return { title: title.trim(), text: rest.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
  });
  const picked = AGX_SECTIONS.map(re => secs.find(s => re.test(s.title))).filter(Boolean);
  const use = picked.length ? picked : secs.filter(s => s.title && s.title.length < 40);
  const out = []; let used = 0;
  for (const s of use) {
    const block = `【${s.title}】${s.text}`;
    if (used + block.length <= max) { out.push(block); used += block.length + 1; continue; }
    const room = max - used - 2;
    if (room > 240) out.push(`${block.slice(0, room).trimEnd()} …`);
    break;
  }
  return out.join('\n');
}

/** 上游skill(vendor 目录在才有): id = agx-<上游名>，stage 由 AGX_MAP 定，body = 切片。 */
export function agxCatalog() {
  const sha = agxSha(); if (!sha) return [];
  let dirs = []; try { dirs = fs.readdirSync(path.join(AGX_DIR, 'skills')).sort(); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    const cfg = AGX_MAP[d]; if (!cfg) continue;
    const f = path.join(AGX_DIR, 'skills', d, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const body = agxSlice(raw.replace(/^---[\s\S]*?---\s*/, '').trim(), cfg.max);
    if (!body) continue;
    out.push({
      id: `agx-${d}`,
      name: `Upstream standard · ${d}`,
      stage: STAGES.some(s => s.id === cfg.stage) ? cfg.stage : '',
      tech: '',
      body: `(Excerpt from upstream addyosmani/agent-skills@${sha.slice(0, 8)}：${d}｜Full text vendor/agent-skills/skills/${d}/SKILL.md)\n${body}`,
      bytes: Buffer.byteLength(body),
    });
  }
  return out;
}
const fmValue = (raw, key) => {
  const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};
/** frontmatter 里 `metadata:` 块的某个子键(平台扩展：stage / tech / label)。 */
const metaValue = (raw, key) => {
  const block = (raw.match(/^metadata:[^\n]*\n((?:[ \t]+[^\n]*\n?)*)/m) || [])[1] || '';
  const m = block.match(new RegExp(`^\\s+${key}:\\s*(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};

/** AI Agent Skills 标准格式的标准小节(顺序固定，见 vendor/agent-skills/docs/skill-anatomy.md)。 */
export const SKILL_SECTIONS = ['Overview', 'When to Use', 'Core Process', 'Common Rationalizations', 'Red Flags', 'Verification'];

/** 解析一份标准格式skill(skills/<name>/SKILL.md): 平台预设与"生成project工作区自带skill"共用。 */
function parseSkill(id, raw) {
  const stage = metaValue(raw, 'stage');
  return {
    id,
    name: metaValue(raw, 'label') || id,
    desc: fmValue(raw, 'description'),
    stage: STAGES.some(s => s.id === stage) ? stage : '',
    tech: metaValue(raw, 'tech'),
    body: raw.replace(/^---[\s\S]*?---\s*/, '').trim(),
    bytes: Buffer.byteLength(raw),
  };
}

/** 工作区自带skill：生成的project里自己放的 skills/<name>/SKILL.md(同一套标准格式)。有就优先用。 */
export function workspaceSkills(p) {
  const dir = path.join(exec.wsDir(p.id), 'skills');
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const f = path.join(dir, n, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    try { out.push({ ...parseSkill(n, fs.readFileSync(f, 'utf8')), from: 'workspace' }); } catch {}
  }
  return out;
}

/** 调模型前刷一次：工作区skill以磁盘为准(不落库、不拷贝)，顺手在集合变化时记账。 */
export function refreshWsSkills(p) {
  const before = (p.ws_skills || []).map(s => s.id).join(',');
  p.ws_skills = workspaceSkills(p);
  const after = p.ws_skills.map(s => s.id).join(',');
  if (after !== before) {
    pushEvent(p, { stage: 'project', kind: 'step', text: p.ws_skills.length
      ? `Workspace skills:  ${p.ws_skills.length} skills(skills/*/SKILL.md): ${p.ws_skills.map(s => s.name).join('、')} → take priority over project skills and platform defaults`
      : 'No workspace skills remain(skills/*/SKILL.md)' });
  }
  return p.ws_skills;
}

/** 读 skills/<name>/SKILL.md(标准格式：frontmatter `name`(=目录名)+ `description` + `metadata.{stage,tech,label}`，正文六节)。 */
export function skillCatalog() {
  let dirs = [];
  try { dirs = fs.readdirSync(SKILL_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); }
  catch { return agxCatalog(); }
  return [...dirs.map(id => {
    const f = path.join(SKILL_DIR, id, 'SKILL.md');
    if (!fs.existsSync(f)) return null;
    return parseSkill(id, fs.readFileSync(f, 'utf8'));
  }).filter(Boolean), ...agxCatalog()];
}

/** 把预设skillimportprojectskill库：同名+同stage视为already exists，skipped；超出数上限的算 dropped(不中断import)。 */
export function importSkills(p, ids) {
  const cat = skillCatalog();
  const want = (Array.isArray(ids) && ids.length) ? cat.filter(c => ids.includes(c.id)) : cat;
  if (!want.length) throw new HttpError(404, 'no matching preset skills');
  const has = new Set(skillsOf(p).map(s => `${s.name}|${s.stage}`));
  let added = 0, skipped = 0, dropped = 0;
  for (const c of want) {
    if (has.has(`${c.name}|${c.stage}`)) { skipped++; continue; }
    if (skillsOf(p).length >= SKILL_LIMIT.count) { dropped++; continue; }    // 到顶了也别把整批import搞挂
    addSkill(p, { name: c.name, body: c.body, stage: c.stage, editor: `Preset ${c.id}`, preset: c.id, desc: c.desc, role: G.planRole(c.id) || '' }, { silent: true });
    has.add(`${c.name}|${c.stage}`);
    added++;
  }
  if (added || dropped) {
    pushEvent(p, { stage: 'project', kind: 'artifact', text: `imported from preset skill library: ${added} skills${skipped ? `(${skipped} already exist, skipped)` : ''}${dropped ? `(${dropped} over ${SKILL_LIMIT.count} skill limit, not imported)` : ''} · total: ${skillsOf(p).length} skills` });
  }
  return { added, skipped, dropped, total: skillsOf(p).length };
}
/* ---------- 段階別スキル割当(§11)：主軸ワークフロー / チェックリスト / 案件専用 ---------- */

// 言語別規約は「人が指定したスタック」優先(アーキが依存なし Node に置き換えても、それに合わせて dev-nodejs を勧めない)
const planOf = (p) => G.skillPlanFor(p.stages.map(s => s.id), String(p.tech || '').trim() || stackOf(p));

/** 割当の適用状況：段階ごとに 3 区分の各スキルが取り込み済みか、外すべきものが残っていないか。 */
export function skillPlanStatus(p) {
  const plan = planOf(p);
  const cat = new Map(skillCatalog().map(c => [c.id, c]));
  const mine = skillsOf(p);
  const byPreset = new Map(mine.map(s => [G.presetIdOf(s), s]).filter(([k]) => k));
  const out = {};
  for (const [sid, e] of Object.entries(plan)) {
    const row = (id, role) => ({ id, role, name: cat.get(id)?.name || id, applied: byPreset.has(id), available: cat.has(id) });
    const own = mine.filter(s => (s.stage || '') === sid && G.roleOf(s) === 'project').map(s => ({ id: s.id, name: s.name }));
    out[sid] = {
      primary: e.primary.map(id => row(id, 'primary')),
      checklist: e.checklist.map(id => row(id, 'checklist')),
      project: { suggested: e.project, have: own },
      conflicts: e.exclude.filter(id => byPreset.has(id)).map(id => ({ id, skill: byPreset.get(id).id, name: byPreset.get(id).name })),
    };
  }
  return out;
}

/**
 * 割当を適用：主軸・チェックリストを取り込み(役割付き)、外す対象のプリセット由来スキルを削除。
 * 人が書いたスキル(案件専用)には触らない。dryRun なら変更せずに差分だけ返す。
 */
export function applySkillPlan(p, { dryRun = false } = {}) {
  const plan = planOf(p);
  const cat = new Map(skillCatalog().map(c => [c.id, c]));
  const want = new Map();                                     // presetId → { stage, role }
  for (const [sid, e] of Object.entries(plan)) {
    for (const id of e.primary) want.set(id, { stage: sid, role: 'primary' });
    for (const id of e.checklist) if (!want.has(id)) want.set(id, { stage: sid, role: 'checklist' });
  }
  const exclude = new Set(Object.values(plan).flatMap(e => e.exclude).filter(id => !want.has(id)));
  const mine = skillsOf(p);
  const remove = mine.filter(s => exclude.has(G.presetIdOf(s)));
  const have = new Set(mine.map(G.presetIdOf).filter(Boolean));
  const add = [...want.entries()].filter(([id]) => !have.has(id) && cat.has(id));
  const missing = [...want.keys()].filter(id => !cat.has(id));
  const retag = mine.filter(s => want.has(G.presetIdOf(s)) && s.role !== want.get(G.presetIdOf(s)).role);
  const diff = { add: add.map(([id, w]) => ({ id, ...w })), remove: remove.map(s => ({ id: s.id, preset: G.presetIdOf(s), name: s.name })), retag: retag.map(s => s.id), missing };
  if (dryRun) return diff;
  if (mine.length - remove.length + add.length > SKILL_LIMIT.count) throw new HttpError(400, `Applying the plan would exceed ${SKILL_LIMIT.count} skills — delete some project skills first`);
  for (const s of remove) mine.splice(mine.indexOf(s), 1);
  for (const s of retag) s.role = want.get(G.presetIdOf(s)).role;
  for (const [id, w] of add) {
    const c = cat.get(id);
    addSkill(p, { name: c.name, body: c.body, stage: w.stage, role: w.role, editor: `Preset ${id}`, preset: id, desc: c.desc }, { silent: true });
  }
  pushEvent(p, { stage: 'project', kind: 'artifact', text: `stage skill plan applied (BMAD primary + checklists): +${add.length} imported, −${remove.length} conflicting removed${remove.length ? ` (${remove.map(s => s.name).join('、')})` : ''}${missing.length ? ` · ${missing.length} preset(s) not available: ${missing.join(', ')}` : ''} · total ${mine.length} skills` });
  save();
  return { ...diff, total: mine.length };
}

/** トレーサビリティ：台帳カバレッジ + 依存 DAG + ゲート方針(画面表示用にまとめて返す)。 */
export function trace(p) {
  const cv = G.coverage(p);
  return {
    ledger: { total: cv.total, planned: cv.planned, implemented: cv.implemented, uncovered: cv.uncovered, unknown: cv.unknown, byKind: cv.byKind, scanned: p.ledger?.scanned || null, generated_at: p.ledger?.generated_at || null },
    rows: cv.rows.map(r => ({ id: r.id, kind: r.kind, name: r.name, parent: r.parent, refs: r.refs, source: (r.sources || [])[0] || null, origin: r.origin, modules: r.modules, status: r.status })),
    dag: { order: G.dagOrder(p.modules), modules: p.modules.map(m => ({ id: m.id, name: m.name, layer: m.layer, deps: m.deps || [], blocked_by: G.blockedBy(p, m).map(x => x.id), req_ids: m.req_ids || [], status: m.status })) },
    gates: { mode: p.mode, human: G.humanGatesOf(p), stages: p.stages.map(s => ({ id: s.id, human: G.needsHuman(p, s.kind === 'development' ? 'development' : s.id) })) },
    stack: stackDeviation(p),
    questions: { open: G.questionsOf(p).filter(q => q.status === 'open').length, answered: G.questionsOf(p).filter(q => q.status === 'answered').length,
      on_hold: (p.modules || []).filter(m => m.status === 'on_hold').map(m => m.id) },
    lessons: { draft: G.lessonsOf(p).filter(l => l.status === 'draft').length },
  };
}

/** 宣言スタック(アーキ) と実行器のずれ：例「Next.js + NestJS + PostgreSQL」宣言なのに実行は依存なし Node ESM。 */
export function stackDeviation(p) {
  const requested = String(p.tech || '').trim();          // 人が指定したスタック
  const resolved = stackOf(p);                            // アーキ(ARC-01)が採用したスタック
  const pr = prof(p);
  const runner = pr.label || pr.id;
  const needsDeps = (x) => /nest|next|express|fastify|spring|postgres|mysql|react|vue|prisma|typeorm/i.test(x);
  const declared = needsDeps(requested) ? requested : resolved;
  const replaced = requested && resolved && requested !== resolved && needsDeps(requested) && !needsDeps(resolved);
  if (!needsDeps(declared)) return { declared, resolved, runner, deviates: false };
  if (pr.deps && !replaced) return { declared, resolved, runner, deviates: false, deps: true };   // TS 档案：npm 許可リストで実際に依存を入れて走らせる
  return { declared, resolved, runner, deviates: true, replaced,
    note: replaced
      ? `Requested stack "${requested}" was replaced by "${resolved}" in architecture, because the executor only runs ${runner} without dependencies.`
      : `Declared stack "${declared}" needs frameworks/DB, but the executor runs ${runner} without dependencies — generated code cannot use them.` };
}

/** /api/state 用：各プロジェクトに計算済みの統制情報を付ける(永続化しない)。 */
export const withGovernance = (p) => ({ ...p, governance: { trace: trace(p), skill_plan: skillPlanStatus(p) } });

export function removeProject(id, { force = false } = {}) {
  const p = get(id);
  if (p) {
    const running = p.stages.some(s => s.status === 'running') || p.modules.some(m => m.status === 'running');
    if (running && !force)
      throw new HttpError(409, 'Project is running: wait for it to finish, or confirm force-delete (in-flight model calls will be discarded)');
    p._removed = true;                                     // 打墓碑：迟到的写入全部作废
    for (const k of [...timers.keys()]) if (k.startsWith(`${id}:`)) { clearTimeout(timers.get(k)); timers.delete(k); }
  }
  db.projects = db.projects.filter(p => p.id !== id);
  if (db.active === id) db.active = db.projects[0]?.id || null;
  try { exec.rmWorkspace(id); } catch { /* 目录不存在即可 */ }
  save();
  return { ok: true, deleted: id, forced: force, remaining: db.projects.length };
}

/* ---------- 重新构建：clearartifact与历史痕迹，skill保留 ---------- */

/** 重新构建project：clear全部stageartifact / WBS / 架构规约 / module与源码·测试文件 / 事件流 / workspace 里的生成目录，
    保留skill库、inputmaterials、Tech stack与各stage模型配置。规则见 README"重新构建"。
    在飞的任务：先停掉该project的定时器；仍显示 running 且未 force ⇒ 409(与deleteproject同一套口径)。 */
export function rebuildProject(id, { force = false } = {}) {
  const p = get(id);
  if (!p) throw new HttpError(404, 'Project not found');
  const running = p.stages.some(s => s.status === 'running') || p.modules.some(m => m.status === 'running');
  if (running && !force)
    throw new HttpError(409, 'Project is running: wait for it to finish, or confirm force-rebuild (in-flight model call results will be discarded)');
  for (const k of [...timers.keys()]) if (k.startsWith(`${id}:`)) { clearTimeout(timers.get(k)); timers.delete(k); }

  const stat = {
    artifacts: p.stages.reduce((a, s) => a + s.artifacts.length, 0) + p.modules.reduce((a, m) => a + m.artifacts.length, 0),
    modules: p.modules.length,
    files: p.modules.reduce((a, m) => a + (m.files?.length || 0), 0),
    events: p.events.length,
    dirs: [],
  };
  for (const s of p.stages)
    Object.assign(s, { status: 'pending', attempts: 0, artifacts: [], review: null, error: null, started_at: null, finished_at: null, progress: 0, progress_label: 'started' });
  for (const s of p.stages) delete s.human_hold;
  p.wbs = { epics: [], task_count: 0 };
  delete p.ledger;                     // 要件台帳は要件段階の再実行で入力資料から作り直す
  p.arch = typeArch(typeOf(p.type), p.tech);   // 架构规约回到分类自带的那套，重跑架构stage再定
  p.modules = [];
  if (p.questions) p.questions = p.questions.filter(q => q.status !== 'open');   // 未回答はモジュールと一緒に消える（再生成で再質問）。回答済みは決定事項として残す
  p.events = [];                       // 历史痕迹清零(紧接着写/重建这一)
  try { stat.dirs = exec.clearWorkspace(id); } catch (e) { stat.dirs = [`(清理failed: ${e.message})`]; }
  save();
pushEvent(p, {
    stage: 'project', kind: 'rebuild',
    text: `♻ Rebuild: cleared  ${stat.artifacts}  artifact(s), ${stat.modules} modules(${stat.files}  source/test file(s)), ${stat.events} skillsexecuterecords`
      + ` ，deleted workspace/${id}/ / ${stat.dirs.length}  generated item(s)${stat.dirs.length ? `(${stat.dirs.join('、')})` : ''}`
      + ` ; Skills ${skillsOf(p).length} skills、inputmaterials ${(p.inputs || []).length} retained`,
  });
  return { ok: true, cleared: { ...stat, dirs: stat.dirs.length }, kept: { skills: skillsOf(p).length, inputs: (p.inputs || []).length } };
}

/** Rescan the requirements ledger from raw input files on disk. Deterministic:
 *  no model call, so it's safe to run from the UI without paying for re-supplementation.
 *  Use when inputs have been added/changed outside the loop, or when the project
 *  predates the ledger feature. The model-supplemented FR/NFR (added by buildLedger)
 *  is dropped — re-running the requirements stage is the path to get them back.
 *  Modules whose req_ids point at IDs that no longer exist get those IDs trimmed
 *  (the modules themselves are kept). Running stages block with 409 to avoid races.
 */
export function rescanLedger(id, { replace = true } = {}) {
  const p = get(id);
  if (!p) throw new HttpError(404, `Project not found: ${id}`);
  if ((p.stages || []).some(s => s.status === 'running') || (p.modules || []).some(m => m.status === 'running'))
    throw new HttpError(409, 'Project is running: wait for it to finish before rescanning the ledger');
  const files = G.readInputs(p, exec.wsDir(p.id));
  if (!files.length) throw new HttpError(400, 'no input files on disk — add inputs first, or run the requirements stage');
  const { items, scanned } = G.scanLedger(files, Array.isArray(p.ledger_patterns) && p.ledger_patterns.length ? p.ledger_patterns : undefined);
  if (!items.length) throw new HttpError(400, `scan returned 0 IDs from ${scanned.files} file(s) — check inputs or ledger_patterns`);
  const prevIds = new Set((p.ledger && p.ledger.items ? p.ledger.items : []).map(it => it.id));
  const nextIds = new Set(items.map(it => it.id));
  const dropped = [...prevIds].filter(x => !nextIds.has(x));
  const added = [...nextIds].filter(x => !prevIds.has(x));
  if (dropped.length && Array.isArray(p.modules)) {
    for (const m of p.modules) {
      if (!Array.isArray(m.req_ids) || !m.req_ids.length) continue;
      const before = m.req_ids.length;
      m.req_ids = m.req_ids.filter(rid => nextIds.has(rid));
      const lost = before - m.req_ids.length;
      if (lost) pushEvent(p, { stage: 'project', kind: 'step', text: `rescanLedger: module ${m.id} dropped ${lost} req_id(s) no longer in input files` });
    }
  }
  p.ledger = { items, scanned, generated_at: now(), rescan_of: p.ledger?.generated_at || null, prev_count: prevIds.size };
  const by = {};
  for (const it of items) by[it.kind] = (by[it.kind] || 0) + 1;
  const delta = added.length || dropped.length
    ? ` · Δ ${added.length - dropped.length >= 0 ? '+' : ''}${added.length - dropped.length} vs previous (${prevIds.size})${added.length ? ` · +${added.length} added` : ''}${dropped.length ? ` · −${dropped.length} removed` : ''}`
    : ' · unchanged';
  pushEvent(p, {
    stage: 'project', kind: 'artifact',
    text: `ledger rescan: ${scanned.files} file(s) / ${Math.round(scanned.bytes / 1024)}KB → ${items.length} ID(s) (${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(' / ')})${delta}`,
  });
  save();
  return { items: items.length, scanned, dropped: dropped.length, added: added.length, prev_count: prevIds.size };
}

/** Resumable launcher for the project card 「起動」 button:
 *  finds the first non-approved stage and runs it via the existing kick machinery.
 *  Returns { stage_id, stage_name } on success, throws 409 if there's nothing to run
 *  (all approved) or a stage is currently busy / awaiting review.
 */
export function runProject(id) {
  const p = must(id);
  const st = currentStage(p);
  if (!st) throw new HttpError(409, 'All stages already approved — nothing to run');
  const r = checkStageRunnable(p, st.id);
  guarded(p.id, () => runStage(p, r.id));
  return { stage_id: r.id, stage_name: r.name };
}

/* ---------- execute器 ---------- */

async function guarded(id, fn) {
  if (busy.has(id)) return;
  busy.add(id);
  try { await fn(); } finally { busy.delete(id); }
}

function later(key, ms, fn) {
  if (timers.has(key)) return;
  timers.set(key, setTimeout(async () => { timers.delete(key); try { await fn(); } catch (e) { console.error('[harness]', e.message); } }, SPEED <= 0 ? 5 : Math.max(5, ms / SPEED)));
}

/** 推动流程：从currentstage继续推进到/一个"需要人"的位置。 */
export function kick(p, opts = {}) {
  if (p._removed) return;                         // project已删：迟到的回调不再推进
  const st = currentStage(p);
  if (!st) return;

  if (st.kind === 'development') {
    // 多 Agent 并行：把空闲的 Agent 槽位补满(状态机自己就是锁——
    // runModule 在第一个 await 之前就把module置为 running，所以这里的 find 不会重复领取)。
    const slots = CONC - p.modules.filter(m => m.status === 'running').length;
    for (let i = 0; i < slots; i++) {
      // 只领取"没做过"或"人reject"'s module；failedretrymax 3 轮，避免模型反复failed时无限循环
      // 依存(deps)が全部承認済みのものだけ着手：上位が mock 相手に先走らない(DAG 順)
      // 未回答の疑問に紐づくもの（on_hold / 担当 ID が重なる）は回答まで着手しない：曖昧な仕様の上に作らない
      const next = p.modules.find(m => (m.status === 'pending' || m.status === 'rejected' || (m.status === 'failed' && (m.attempts || 0) < 3)) && !G.blockedBy(p, m).length && !G.heldBy(p, m).length);
      if (!next) break;
      runModule(p, next, opts).catch(e => console.error('[harness]', e.message));
    }
    // 已done's module在人(或 auto 模式)批准后才把槽位还回来
    const rev = p.modules.filter(m => m.status === 'awaiting_review');
    if (rev.length && !G.needsHuman(p, 'development')) rev.forEach(m => later(`${p.id}:${m.id}`, 700, () => approveModule(p, m.id, 'AI auto-approve', { source: 'auto' })));
    return;
  }

  if (st.status === 'awaiting_review') {
    const gaps = st.id === 'wbs' ? wbsGaps(p) : [];
    if (!G.needsHuman(p, st.id) && !gaps.length) later(`${p.id}:${st.id}`, 700, () => approveStage(p, st.id, 'AI auto-approve', { source: 'auto' }));
    else if (gaps.length && !st.human_hold) {           // 網羅漏れのある WBS は auto でも人に回す
      st.human_hold = true;
      pushEvent(p, { stage: st.id, kind: 'gate', text: `⏸ ${st.name}: ${gaps.length} ledger ID(s) uncovered — human review required` });
      save();
    }
    else if (p.mode === 'auto' && !st.human_hold) {      // auto モードでも高リスク段階はここで止まる(一度だけ記録)
      st.human_hold = true;
      pushEvent(p, { stage: st.id, kind: 'gate', text: `⏸ ${st.name}: high-risk gate — human approval required even in auto mode (human_gates: ${G.humanGatesOf(p).join(', ')})` });
      save();
    }
    return;
  }
  if (st.status === 'pending' || st.status === 'rejected' || st.status === 'failed') {
    if (st.status === 'failed' && (st.attempts || 0) >= 3) return;   // 自动retry封顶(3 attempts)；再多就得人点"重跑"，别一直刷真实模型
    guarded(p.id, () => runStage(p, st.id, opts));
  }
}

function guardAdvance(p, st) {
  const idx = p.stages.indexOf(st);
  const pendingBefore = p.stages.slice(0, idx).find(s => s.status !== 'approved');
  if (pendingBefore) throw new HttpError(409, `Predecessor stage "${pendingBefore.name}" not approved; cannot run "${st.name}"`);
}

/* ---------- stageexecute ---------- */

export function checkStageRunnable(p, stageId) {
  const st = p.stages.find(s => s.id === stageId);
  if (!st) throw new HttpError(404, `Stage not found: ${stageId}`);
  if (st.status === 'approved') throw new HttpError(409, 'Stage already approved — cannot re-run');
  if (st.status === 'running') throw new HttpError(409, 'Stage is currently running');
  if (st.status === 'awaiting_review') throw new HttpError(409, 'Stage awaiting review — approve or reject first');
  guardAdvance(p, st);
  if (st.kind === 'development' && !p.modules.length && workflowOf(p).id !== 'devflow') throw new HttpError(409, 'WBS not done — no modules to develop');
  return st;
}

export async function runStage(p, stageId, opts = {}) {
  const st = checkStageRunnable(p, stageId);
  // DevFlow workflow has no WBS stage; auto-generate modules from architecture on first development run
  if (st.kind === 'development' && !p.modules.length && workflowOf(p).id === 'devflow') {
    st.status = 'running'; st.attempts += 1; st.started_at = st.started_at || now(); st.error = null;
    setProgress(p, st, 0, 'generating WBS');
    pushEvent(p, { stage: st.id, kind: 'run', text: `▶ ${st.name} · DevFlow auto-WBS starting (model: ${channelTag(p, st.id)})` });
    refreshWsSkills(p);
    try {
      const r = PROVIDER === 'sim' ? sim.planWbs(p) : await agent.wbs(p);
      if (!p._removed && st.attempts > 0) {
        storeWbs(p, r);
        save();
        pushEvent(p, { stage: st.id, kind: 'artifact', text: `DevFlow auto-WBS: ${p.modules.length} module(s) generated from architecture (${p.wbs.task_count} tasks across ${p.wbs.epics.length} epics)` });
      }
    } catch (e) {
      const msg = e.message || String(e);
      if (!transientBounce(p, st, st.id, 'DevFlow auto-WBS', msg)) {
        st.status = 'failed'; st.error = `DevFlow auto-WBS failed: ${msg}`;
        pushEvent(p, { stage: st.id, kind: 'error', text: `✕ DevFlow auto-WBS failed: ${st.error}` });
      }
      save();
      return kick(p, opts);
    }
  }
  if (st.kind === 'development') return runDevelopment(p, st, opts);

  st.status = 'running'; st.attempts += 1; st.started_at = st.started_at || now(); st.error = null;
  const setProg = (percent, label) => setProgress(p, st, percent, label);
  setProg(0, 'started');
  pushEvent(p, { stage: st.id, kind: 'run', text: `▶ ${st.name} · ${st.agent} started (attempt # ${st.attempts} , model: ${channelTag(p, st.id)})` });
  refreshWsSkills(p);                                    // 工作区自带skill优先：每次调模型前按磁盘刷一次

  const d = opts.delay || delay;
  // "重新构建"会把 st.attempts 归零 / project被删 → 这一轮的结果一律不落地(人点了重建，旧结果不该再回来)
  const stale = () => p._removed || st.attempts === 0;
  try {
    const steps = sim.planSteps(p, st);
    for (const [i, s] of steps.entries()) {
      await d(s.ms); if (stale()) return;
      setProg(Math.round(20 * (i + 1) / steps.length), 'preparing');
      pushEvent(p, { stage: st.id, kind: 'step', text: s.text });
    }

    if (st.kind === 'wbs') {
      setProg(35, 'generating WBS');
      pushEvent(p, { stage: st.id, kind: 'step', text: PROVIDER === 'sim' ? 'offline channel · generating WBS' : ` calling ${modelFor(p, 'wbs')}  to decompose tasks…` });
      const r = PROVIDER === 'sim' ? sim.planWbs(p) : await agent.wbs(p);
      if (stale()) return;
      storeWbs(p, r);
      setProg(85, 'planned');
      const cv = G.coverage(p), dagFrom = p.wbs.epics[0]?.deps_from;
      pushEvent(p, { stage: st.id, kind: 'step', text: `dependency graph: ${p.modules.filter(m => m.deps.length).length}/${p.modules.length} module(s) have deps (${dagFrom === 'wbs' ? 'declared by WBS' : 'inferred from layer order'}); DAG order ${G.dagOrder(p.modules).join(' → ')}` });
      if (cv.total) pushEvent(p, { stage: st.id, kind: cv.uncovered.length ? 'error' : 'step', text: `traceability: ${cv.planned}/${cv.total} ledger ID(s) assigned to modules${cv.uncovered.length ? ` · ${cv.uncovered.length} uncovered: ${cv.uncovered.slice(0, 20).join(', ')}${cv.uncovered.length > 20 ? ' …' : ''}` : ''}` });
      pushEvent(p, { stage: st.id, kind: 'artifact', text: `decomposed into ${p.wbs.epics.length} Epics / ${p.wbs.task_count} Tasks → generated ${p.modules.length} dev module(s) (per architecture, assigned to ${archLayers(p).join(' / ')}  layer(s); language: ${prof(p).label})` });
    } else {
      if (st.id === 'requirements') {
        setProg(25, 'building requirements ledger');
        await buildLedger(p, st);
        if (stale()) return;
      }
      setProg(35, 'generating artifacts');
      const r = PROVIDER === 'sim'
        ? { artifacts: sim.planArtifacts(p, st).map(a => ({ ...a, status: 'generated', version: st.attempts })) }
        : await agent.stageArtifacts(p, st, lastFeedback(st), (n, total, a) => {
            if (stale()) return;
            setProg(Math.round(35 + 50 * n / total), 'generating artifacts');
            pushEvent(p, { stage: st.id, kind: 'step', text: `model wrote ${n}/${total}: "${a.name}》(${a.content.length}  chars)` });
          });
      if (stale()) return;
      st.artifacts = r.artifacts.map(a => ({ ...a, status: 'generated', version: st.attempts, at: now() }));
      if (st.id === 'requirements' && G.ledgerItems(p).length)
        st.artifacts.unshift({ id: 'REQ-00', name: '要件台帳', type: 'markdown', content: G.ledgerMarkdown(p), status: 'generated', version: st.attempts, at: now() });
      if (st.id === 'ux') {
        setProg(80, 'generating prototypes');
        await buildPrototypes(p, st, stale);
        if (stale()) return;
      }
      const docs = writeDocs(p, st);
      if (r.model) pushEvent(p, { stage: st.id, kind: 'step', text: `Model ${r.model} returned, tokens: ${r.usage?.total_tokens ?? '—'}` });
      const docArts = st.artifacts.filter(a => !a.group), screens = st.artifacts.filter(a => a.group === 'screens' && a.type === 'html');
      pushEvent(p, { stage: st.id, kind: 'artifact', text: `produced ${st.artifacts.length} artifact(s): ${docArts.map(a => a.name).join('、')}${screens.length ? ` + ${screens.length} screen prototype(s)` : ''}${docs ? `(written to workspace/${p.id}/docs/)` : ''}` });
      if (st.id === 'architecture') {
        p.arch = readLayout(p, st);
        const dv = stackDeviation(p);           // 宣言スタックと実行器のずれはアーキのゲートで見えるようにする
        if (dv.deviates) pushEvent(p, { stage: st.id, kind: 'error', text: `⚠ stack deviation: ${dv.note}` });
      }
    }

    // 真实execute证据：测试 / 部署stage跑的是工作区里真实存在的代码
    setProg(90, 'verifying');
    const real = await runRealEvidence(p, st, d);
    if (stale()) return;
    real.forEach(t => pushEvent(p, { stage: st.id, kind: 'test', text: t }));

    st.status = 'awaiting_review';
    setProg(100, 'awaiting review');
    pushEvent(p, { stage: st.id, kind: 'gate', text: `⏸ ${st.name} done → awaiting manual approval (gate: must approve manually)` });
  } catch (e) {
    const msg = e.message || String(e);
    if (!transientBounce(p, st, st.id, 'stage', msg)) {
      st.status = 'failed'; st.error = msg;
      pushEvent(p, { stage: st.id, kind: 'error', text: `✕ ${st.name} execution failed: ${st.error}` });
    }
  }
  save();
  kick(p, opts);
}

/**
 * 要件台帳：入力資料を「全文」走査して ID を決定的に抽出(LLM 不使用)→ ID の無い FR/NFR だけモデルで補完。
 * 入力が無い/ID が無い小規模案件は概要文から FR を立てる(オフラインでも同じ)。
 */
async function buildLedger(p, st) {
  const files = G.readInputs(p, exec.wsDir(p.id));
  const { items, scanned } = G.scanLedger(files, Array.isArray(p.ledger_patterns) && p.ledger_patterns.length ? p.ledger_patterns : undefined);
  let extra = [];
  if (PROVIDER !== 'sim') {
    try { extra = (await agent.ledgerSupplement(p, items)).items; }
    catch (e) { pushEvent(p, { stage: st.id, kind: 'error', text: `ledger supplement (FR/NFR) skipped: ${e.message}` }); }
  }
  if (!items.length && !extra.length) {
    extra = String(p.brief || p.name).split(/[。．.!\n]+/).map(x => x.trim()).filter(x => x.length > 3).slice(0, 8)
      .map((name, i) => ({ id: `FR-${String(i + 1).padStart(3, '0')}`, kind: 'requirement', name: name.slice(0, 40), parent: null, refs: 0, sources: [], origin: 'brief' }));
  }
  p.ledger = { items: [...items, ...extra], scanned, generated_at: now() };
  const by = {};
  for (const it of p.ledger.items) by[it.kind] = (by[it.kind] || 0) + 1;
  pushEvent(p, { stage: st.id, kind: 'artifact', text: `requirements ledger: scanned ${scanned.files} input file(s) in full (${Math.round(scanned.bytes / 1024)}KB) → ${p.ledger.items.length} ID(s) (${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(' / ')}); ${extra.length} added by ${PROVIDER === 'sim' || !items.length ? 'brief' : 'model'}` });
  save();
}

/**
 * UX 段階の見える成果物：台帳の画面・帳票 ID ごとに HTML プロトタイプ（共通テンプレート 1 本 + 画面ごとの中身）を
 * workspace/<pid>/prototypes/ に書き、ブラウザがあれば PNG を撮る（無ければ skipped のイベントだけ）。
 * 成果物：UX-DS（デザインシステム, html）・UXP-<ID>（画面, html）・UXS-<ID>（撮影, image）。本文は DB に持たずファイルを指す。
 */
async function buildPrototypes(p, st, stale = () => false) {
  const screens = PX.screensOf(p);
  if (!screens.length) {
    pushEvent(p, { stage: st.id, kind: 'step', text: 'prototypes: no screen/report IDs in the requirements ledger → HTML prototypes skipped' });
    return;
  }
  const root = exec.wsDir(p.id);
  const at = now(), version = st.attempts;
  let ds;
  try { ds = PROVIDER === 'sim' ? sim.uxDesign(p) : await agent.uxDesign(p); }
  catch (e) { ds = sim.uxDesign(p); pushEvent(p, { stage: st.id, kind: 'error', text: `design system: model call failed (${e.message}) → default tokens` }); }
  if (stale()) return;
  const template = PX.designSystem(ds.tokens, ds.system);
  const files = [{ path: `${PX.DIR}/_template.html`, content: template }, { path: PX.TEMPLATE_FILE, content: PX.templatePreview(template) }];
  const arts = [{ id: 'UX-DS', name: 'デザインシステム（共通テンプレート）', type: 'html', path: PX.TEMPLATE_FILE, status: 'generated', version, at }];
  const imp = PX.importantOf(p, screens);
  let hiOk = 0, fromAsIs = 0;
  for (const scr of screens) {
    const asis = PX.asIsOf(p, root, scr.id);
    if (asis.title && (!scr.name || /[IＩ][DＤ]$/.test(scr.name))) scr.name = asis.title;   // 台帳名が定型（「画面ＩＤ」等）なら現行資料の見出しを使う
    const base = { ...PX.specFromAsIs(scr, asis), source: asis.file || '', fkeys: ds.fkeys };
    if (base.from === 'as-is') fromAsIs++;
    let spec = base;
    if (scr.important) {
      try { spec = { ...base, ...(PROVIDER === 'sim' ? sim.uxHifi(p, scr, base) : await agent.uxScreen(p, scr, asis, base)) }; hiOk++; }
      catch (e) { spec = { ...base, ...sim.uxHifi(p, scr, base) }; pushEvent(p, { stage: st.id, kind: 'error', text: `hi-fi ${scr.id}: model call failed (${e.message}) → template content` }); }
      if (stale()) return;
    }
    const fidelity = scr.important ? 'high' : 'low';
    files.push({ path: PX.fileOf(scr.id), content: PX.renderScreen(template, scr, spec, { fidelity }) });
    arts.push({ id: `UXP-${scr.id}`, name: `${scr.id} ${scr.name || (scr.form === 'report' ? '帳票' : '画面')}`, type: 'html', path: PX.fileOf(scr.id), group: 'screens',
      screen: scr.id, form: scr.form, fidelity, important: !!scr.important, spec_from: base.from, asis: asis.found ? { file: asis.file, line: asis.line } : null, status: 'generated', version, at });
  }
  exec.writeFiles(root, files);
  pushEvent(p, { stage: st.id, kind: 'artifact', text: `prototypes: design-system template ×1 + ${screens.length} screen(s) (1:1 with ledger IDs) → workspace/${p.id}/${PX.DIR}/ · hi-fi ${screens.filter(s => s.important).length}${imp.auto ? ' (auto-picked by refs; mark important screens to choose)' : ''} · fields from AS-IS docs ${fromAsIs}/${screens.length}` });

  const max = Number(process.env.AI_PLATFORM_SHOT_MAX || 400);
  const jobs = [{ id: 'UX-DS', html: path.join(root, PX.TEMPLATE_FILE), png: path.join(root, PX.shotOf('_design-system')) },
    ...screens.slice(0, max).map(s => ({ id: `UXP-${s.id}`, html: path.join(root, PX.fileOf(s.id)), png: path.join(root, PX.shotOf(s.id)) }))];
  const shot = await capture.capture(jobs);
  if (stale()) return;
  if (shot.skipped) pushEvent(p, { stage: st.id, kind: 'step', text: `screenshots skipped: ${shot.skipped} (HTML prototypes are still viewable)` });
  else {
    const ok = new Set(shot.shots);
    for (const j of jobs) {
      if (!ok.has(j.png)) continue;
      const rel = path.relative(root, j.png).split(path.sep).join('/');
      const a = arts.find(x => x.id === j.id);
      a.shot = rel;
      if (a.group) arts.push({ id: `UXS-${a.screen}`, name: `${a.screen} 撮影`, type: 'image', path: rel, group: 'screens', of: a.id, screen: a.screen, status: 'generated', version, at });
    }
    pushEvent(p, { stage: st.id, kind: 'artifact', text: `screenshots: ${shot.shots.length}/${jobs.length} PNG captured in ${(shot.ms / 1000).toFixed(1)}s (${path.basename(shot.browser || '')})${jobs.length < screens.length + 1 ? ` · capped at AI_PLATFORM_SHOT_MAX=${max}` : ''}${shot.errors.length ? ` · ${shot.errors.length} failed: ${shot.errors.slice(0, 3).map(e => e.error).join('; ')}` : ''}` });
  }
  st.artifacts.push(...arts.map(a => ({ ...a })));
}

/** 重要画面（ハイファイ対象）の指定：次回 UX 実行で反映。 */
export function markImportant(p, screenId, on = true) {
  const known = PX.screensOf(p).map(s => s.id);
  if (!known.includes(screenId)) throw new HttpError(404, `Screen not in ledger: ${screenId}`);
  const cur = Array.isArray(p.ux_important) ? p.ux_important : PX.importantOf(p, PX.screensOf({ ...p, ux_important: undefined })).ids;
  p.ux_important = on ? [...new Set([...cur, screenId])] : cur.filter(id => id !== screenId);
  pushEvent(p, { stage: 'ux', kind: 'info', text: `${on ? '★ marked' : '☆ unmarked'} ${screenId} as an important screen (hi-fi on next UX run) · ${p.ux_important.length} important` });
  save();
  return { ux_important: p.ux_important };
}

/** AS-IS（現行資料）の抜粋：UX ゲートの比較表示用。 */
export function asIs(p, screenId) {
  if (!/^[\w.-]{2,40}$/.test(screenId)) throw new HttpError(400, 'screen id required');
  return PX.asIsOf(p, exec.wsDir(p.id), screenId);
}

/** WBS ゲートで止める理由：台帳の ID がどのモジュールにも割り当てられていない。 */
export function wbsGaps(p) {
  if (!G.ledgerItems(p).length || !p.modules.length) return [];
  return G.coverage(p).uncovered;
}

/** 测试/部署stage：真的在工作区跑一遍代码与用例。 */
async function runRealEvidence(p, st, d) {
  if (st.id !== 'testing' && st.id !== 'deployment') return [];
  const root = exec.wsDir(p.id);
  const files = exec.listFiles(root);
  if (!files.length) {
    st.artifacts.push({ id: 'TST-99', name: '実行レポート', type: 'markdown', status: 'generated', version: st.attempts, at: now(), content: 'Workspace is empty: integration tests require generated module artifacts.' });
    return ['Workspace is empty; execution skipped'];
  }
  const lines = [];
  if (st.id === 'deployment') {
    await d(150);
    const syn = await exec.checkSyntax(root);
    lines.push(`構文チェック ${syn.checked} files(${Object.entries(syn.byLang || {}).map(([k, v]) => `${k} ${v}`).join(' / ')}；java checked by javac)→ ${syn.ok ? 'すべて成功' : syn.errors.length + ' errors'}`);
    st.artifacts.push({
      id: 'DPL-02', name: 'ビルド検証レポート（実行結果）', type: 'markdown', status: generated(st), version: st.attempts, at: now(),
      content: `# ビルド検証レポート · ${p.name}\n\nワークスペース：\`workspace/${p.id}\`\n\n- 構文チェック：${syn.checked} files，${syn.ok ? 'すべて成功' : 'エラーあり'}\n${syn.errors.map(e => `  - \`${e.file}\`：${e.error}`).join('\n')}\n`,
    });
  }
  const cdsAll = exec.checkCds(root);
  if (cdsAll.files) {
    await d(120);
    lines.push(`CDS 構造検証：${cdsAll.files} CDS files → ${cdsAll.ok ? '構造正常' : cdsAll.errors.length + ' issues'}`);
    st.artifacts.push({
      id: st.id === 'testing' ? 'TST-03' : 'DPL-04', name: 'CDS モデルレポート(構造検証)', type: 'markdown', status: generated(st), version: st.attempts, at: now(),
      content: `# CDS モデルレポート · ${p.name}\n\nファイル：${cdsAll.files} files\n\n${
        cdsAll.ok ? '- 構造正常(balanced braces / namespace or entity / key on each entity)' : cdsAll.errors.map(e => `- \`${e.file}\`：${e.error}`).join('\n')}\n\n> 説明：cds-dk (@sap/cds-dk) is unavailable; **this is not \`cds compile\` compilation output**. This is a structural check only. Install cds-dk and run \`cds compile db/ srv/\`。\n`,
    });
  }
  await d(200);
  const tr = await exec.runWorkspaceTests(root);            // 工作区里有什么语言就真跑什么
  execNotes(p, st.id, tr);
  lines.push(`real-ran \`${tr.cmd}\`(ワークスペース) → PASS=${tr.passed} FAIL=${tr.failed}${tr.skipped ? ` SKIPPED=${tr.skipped}` : ''} 終了コード=${tr.exit_code} ${tr.ms}ms`);
  if (tr.db && tr.db.status === 'skipped') lines.push(`PostgreSQL 統合テスト：未実行（${tr.db.why}）— 合格扱いにしない`);
  st.artifacts.push({
    id: st.id === 'testing' ? 'TST-02' : 'DPL-03',
    name: st.id === 'testing' ? '結合テストレポート（実行結果）' : 'スモークテストレポート（実行結果）',
    type: 'markdown', status: generated(st), version: st.attempts, at: now(),
    content: `# ${st.id === 'testing' ? '結合テスト' : 'スモークテスト'}レポート · ${p.name}

コマンド：\`${tr.cmd}\`(cwd = \`workspace/${p.id}\`)
終了コード：${tr.exit_code} · 所要時間 ${tr.ms}ms
PASS=${tr.passed} FAIL=${tr.failed} TESTS=${tr.total}

| 指標 | 値 |
|---|---|
| tests | ${tr.total} |
| pass | ${tr.passed} |
| fail | ${tr.failed} |
${tr.skipped ? `| skipped（未実行・合格扱いにしない） | ${tr.skipped} |\n` : ''}${tr.db ? `| PostgreSQL | ${tr.db.status}${tr.db.why ? `：${tr.db.why}` : ''} |\n` : ''}
\`\`\`
${tr.tail}
\`\`\`
`,
  });
  if (tr.failed > 0) throw new Error(`real tests failed: FAIL=${tr.failed} (see integration test report)`);
  if (tr.install && !tr.install.ok) throw new Error(`dependency install failed — tests did not run: ${String(tr.install.why || '').slice(0, 200)}`);
  return lines;
}
const generated = (st) => (st.review?.decision === 'approved' ? 'approved' : 'generated');

/* ---------- artifact落盘路径规约：docs/<两位流程序>-<流程名>/<artifactID>.md ---------- */
/** stage doc 目录：序 + 服务端stage名(磁盘路径不跟界面语言走，保证同一份artifact的路径稳定)。moduleartifact归到"module开发"。
    名字里的 `/`(UI/UX 设计)折成 `-`，否则会被当成多级目录。 */
export const docDirOf = (ownerId, p = null) => {
  const list = (p && Array.isArray(p.stages) && p.stages.length) ? p.stages : STAGES;   // 序跟project自己的Workflow走(精简流程没 has UX，架构就是 02)
  let i = list.findIndex(s => s.id === ownerId);
  if (i < 0 && /^M\d+$/i.test(String(ownerId || ''))) i = list.findIndex(s => s.id === 'development');
  if (i < 0) return `docs/${ownerId}`;
  return `docs/${String(i + 1).padStart(2, '0')}-${list[i].name.replace(/[/\\]/g, '-')}`;
};
export const docPathOf = (ownerId, artifactId, p = null) => `${docDirOf(ownerId, p)}/${artifactId}.md`;

function writeArtifactFile(p, ownerId, artifact) {
  if (p._removed) return null;                    // 已delete的project不许再把文件写回来
  const file = { path: docPathOf(ownerId, artifact.id, p), content: artifact.content };
  try { exec.writeFiles(exec.wsDir(p.id), [file]); return file.path; } catch { return null; }
}

function writeDocs(p, st) {
  return st.artifacts.filter(a => !a.type || a.type === 'markdown').map(a => writeArtifactFile(p, st.id, a)).filter(Boolean).length;
}

/* ---------- Humaneditartifact / 工作区文件 ---------- */

const unitTestsOf = (tr) => ({ total: tr.total, passed: tr.passed, failed: tr.failed, exit_code: tr.exit_code, cmd: tr.cmd, ms: tr.ms, at: tr.at, timed_out: !!tr.timed_out, tail: tr.tail,
  ...(tr.skipped ? { skipped: tr.skipped } : {}), ...(tr.db ? { db: tr.db } : {}) });

/** 依存インストールと PostgreSQL の実行状況をイベントに出す：skip は「通過」ではないと明記する。 */
function execNotes(p, stage, tr) {
  const i = tr.install;
  if (i && i.ok && !i.cached) pushEvent(p, { stage, kind: 'step', text: `npm install (${i.mode || 'online'}) done in ${i.ms}ms${i.added && i.added.length ? ` · added ${i.added.join(', ')}` : ''}` });
  if (i && !i.ok) pushEvent(p, { stage, kind: 'error', text: `✕ dependency install failed: ${String(i.why || '').slice(0, 300)}` });
  if (tr.db && tr.db.status === 'skipped')
    pushEvent(p, { stage, kind: 'step', text: `⚠ PostgreSQL integration tests SKIPPED — not counted as passed: ${tr.db.why}${tr.skipped ? ` (${tr.skipped} test(s) skipped)` : ''}` });
  else if (tr.db) pushEvent(p, { stage, kind: 'step', text: `PostgreSQL for integration tests: ${tr.db.status}${tr.db.container ? ` (${tr.db.image} · ${tr.db.container})` : ''}` });
}

function buildModuleReport(p, mod, tr, cdsChk) {
  return {
    id: `${mod.id}-CODE`, name: `${mod.name} · コードと単体テスト`, type: 'markdown',
    status: mod.status === 'approved' ? 'approved' : 'generated', version: mod.attempts, at: now(),
    content: `# module ${mod.id} · ${mod.name}

**目標**：${mod.goal || '—'}
**説明**：${mod.summary || '—'}
**言語プロファイル**：${prof(p).label}
**アーキテクチャレイヤー**：${mod.layer || '—'} · **コードパス**：\`${mod.dir || '—'}/\` · **テストパス**：\`${mod.test_path_planned || mod.test_path || '—'}\`

## 成果ファイル(workspace/${p.id})
${mod.files.map(f => `- \`${f.path}\`(${f.loc}  lines)`).join('\n')}
${cdsChk ? `\n## CDS モデル(構造検証。cds-dk によるコンパイルは未実施)\n${cdsChk.files} CDS files · ${cdsChk.ok ? '構造正常(balanced braces / namespace or entity / key on each entity)' : cdsChk.errors.map(e => `- \`${e.file}\`：${e.error}`).join('\n')}\n` : ''}
## 単体テスト（実行結果）
コマンド：\`${tr.cmd}\` · exit code ${tr.exit_code} · ${tr.ms}ms

| tests | pass | fail |
|---|---|---|
| ${tr.total} | ${tr.passed} | ${tr.failed} |

\`\`\`
${tr.tail}
\`\`\`

> 規則：単体テスト FAIL=0 と人の承認が次モジュールへの進行条件です。
`,
  };
}

export function findArtifact(p, aid) {
  for (const s of p.stages) { const a = s.artifacts.find(x => x.id === aid); if (a) return { owner: s, ownerId: s.id, artifact: a }; }
  for (const m of p.modules) { const a = m.artifacts.find(x => x.id === aid); if (a) return { owner: m, ownerId: 'development', artifact: a }; }
  return null;
}

/** 工作区文件 → 归属module：先按module生成records里的原路径精确匹配；否则看文件所在的use folder里是否只有一modules。
    (文件名不带 WBS 序，所以不再靠名字里's module认领 —— records + 目录唯一性就够了。) */
function moduleOfFile(p, rel) {
  for (const m of p.modules) if ((m.files || []).some(f => f.path === rel)) return m;
  const dir = String(rel || '').split('/').slice(0, -1).join('/');
  const cands = p.modules.filter(m => m.dir === dir);
  return cands.length === 1 ? cands[0] : null;
}
/** 该文件是否属于这modules：测试文件精确匹配 → 生成records → 该use folder里只有这一modules。 */
function belongsToModule(p, mod, f, testRel) {
  if (f === testRel || (mod.files || []).some(x => x.path === f)) return true;
  const dir = String(f || '').split('/').slice(0, -1).join('/');
  return mod.dir === dir && p.modules.filter(m => m.dir === dir).length === 1;
}

function assertEditable(owner) {
  if (owner.status === 'approved') throw new HttpError(409, `"${owner.name}" approved and locked; to edit, reject first`);
}

/** Humaneditartifact正文：落库 + 落盘。已批准的stage/module锁定，避免批准后偷改。 */
export function editArtifact(p, aid, { content, editor = 'Human' } = {}) {
  const hit = findArtifact(p, aid);
  if (!hit) throw new HttpError(404, `Artifact not found: ${aid}`);
  if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
  assertEditable(hit.owner);
  const a = hit.artifact;
  if (a.type && a.type !== 'markdown') throw new HttpError(409, `"${a.name}" is a ${a.type} file artifact: edit workspace/${p.id}/${a.path} in the Workspace tab instead`);
  if (a.content === content) return a;
  a.content = content;
  a.version = (a.version || 1) + 1;
  a.edited = { by: editor, at: now(), count: (a.edited?.count || 0) + 1 };
  a.status = 'edited';
  const path = writeArtifactFile(p, hit.ownerId, a);
  pushEvent(p, { stage: hit.ownerId, kind: 'edit', text: `✎ manually edited artifact "${a.name}" → v${a.version}(${content.length}  chars${path ? `, written to ${path}` : ''})` });
  save();
  return a;
}

/** Humanedit工作区ファイル：真实写盘；若是module代码/测试，必须重跑真实测试，否则门禁会基于过期结果放行。 */
export async function editWorkspaceFile(p, relPath, content, { editor = 'Human' } = {}) {
  if (p._removed) throw new HttpError(409, 'Project deleted — cannot write its workspace');
  const rel = exec.safeRel(relPath);
  if (!rel) throw new HttpError(400, 'invalid path');
  if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
  const mod = moduleOfFile(p, rel);
  if (mod) assertEditable(mod);
  const root = exec.wsDir(p.id);
  const written = exec.writeFiles(root, [{ path: rel, content }])[0];
  if (!written) throw new HttpError(400, 'file not written (invalid path or content)');
  pushEvent(p, { stage: mod ? 'development' : 'system', kind: 'edit', text: `✎ manually edited workspace file ${rel}(${written.loc}  lines)` });

  const out = { path: rel, bytes: written.bytes };
  if (mod && rel.endsWith(prof(p).ext)) {                          // 按言語プロファイル判"这是不是源码"(Java/Python 也要重跑，不再只认 .mjs)
    const testRel = mod.test_path || (mod.files.find(f => !f.path.startsWith((mod.dir || '') + '/')) || {}).path;
    if (testRel) {
      const tr = await exec.runTests(root, testRel, prof(p), [...mod.files.map(f => f.path), rel]);   // ← 改过代码就必须真跑(只编本module + 刚改的文件)
      execNotes(p, 'development', tr);
      mod.unit_tests = unitTestsOf(tr);
      mod.files = exec.listFiles(root)
        .filter(f => belongsToModule(p, mod, f, testRel))
        .map(f => ({ path: f, ...exec.statOf(root, f) }));
      const old = mod.artifacts[0];
      mod.artifacts = [{ ...buildModuleReport(p, mod, tr), version: (old?.version || 1) + 1, edited: { by: editor, at: now() } }];
      if (!tr.ok) mod.error = `tests failed after manual edit: FAIL=${tr.failed}(exit code ${tr.exit_code})`;
      else mod.error = null;
      // Human改过's module不再自动重生成(否则会把人的改动冲掉)，交回Human处理
      if (mod.status !== 'approved') mod.status = 'awaiting_review';
      pushEvent(p, { stage: 'development', kind: 'test', text: `re-ran ${tr.cmd} → PASS=${tr.passed} FAIL=${tr.failed} exit code ${tr.exit_code}` });
      out.test = { total: tr.total, passed: tr.passed, failed: tr.failed, exit_code: tr.exit_code };
    }
  }
  syncDevelopment(p);
  save();
  return out;
}

/* ---------- 开发stage：逐module ---------- */

async function runDevelopment(p, st, opts = {}) {
  kick(p, opts);            // 统一由 kick 按并发槽位补满(并 lines)
}

export function checkModuleRunnable(p, moduleId) {
  const mod = p.modules.find(m => m.id === moduleId);
  if (!mod) throw new HttpError(404, 'Module not found');
  if (mod.status === 'approved') throw new HttpError(409, 'Module already approved');
  if (mod.status === 'awaiting_review') throw new HttpError(409, 'Module awaiting review — approve or reject first');
  if (mod.status === 'running') throw new HttpError(409, 'Module is being developed');
  const held = G.heldBy(p, mod);
  if (held.length) throw new HttpError(409, `Module ${mod.id} is on hold: open question(s) ${held.map(q => q.id).join(', ')} must be answered first`);
  const st = p.stages.find(s => s.id === 'development');
  guardAdvance(p, st);
  const wait = G.blockedBy(p, mod);
  if (wait.length) throw new HttpError(409, `Module ${mod.id} depends on unapproved module(s): ${wait.map(m => `${m.id} "${m.name}"`).join(', ')}`);
  // 串行模式(并发=1)才要求前序module先批准；并行模式/发令顺序由 Agent 池决定
  if (CONC === 1) {
    const idx = p.modules.indexOf(mod);
    const prev = p.modules.slice(0, idx).find(m => m.status !== 'approved');
    if (prev) throw new HttpError(409, `Predecessor module "${prev.name}" not approved`);
  }
  return mod;
}

export async function runModule(p, mod, opts = {}) {
  checkModuleRunnable(p, mod.id);
  const st = p.stages.find(s => s.id === 'development');
  mod.status = 'running'; mod.attempts += 1; mod.error = null;
  mod.agent = freeAgent(p);                      // 先占 Agent 槽位，事件里能看出是谁在做
  st.status = 'running'; st.started_at = st.started_at || now();
  pushEvent(p, { stage: 'development', kind: 'run', text: `▶ ${mod.agent} picked up module ${mod.id}"${mod.name}" (attempt # ${mod.attempts} , model: ${channelTag(p, 'development')}; concurrency ${CONC})` });
  refreshWsSkills(p);                                    // 工作区自带skill优先：每次调模型前按磁盘刷一次
  const setProg = (pct, label) => setProgress(p, mod, pct, label);
  setProg(0, 'started');

  const d = opts.delay || delay;
  const root = exec.wsDir(p.id);
  try {
    for (const s of sim.planSteps(p, { id: 'development', agent: st.agent })) { await d(s.ms); pushEvent(p, { stage: 'development', kind: 'step', text: s.text }); }
    setProg(20, 'planned');
    pushEvent(p, { stage: 'development', kind: 'step', text: PROVIDER === 'sim' ? 'offline channel · generating template code' : ` calling ${modelFor(p, 'development')} to generate code + unit tests…` });
    setProg(35, 'generating code');

    const code = PROVIDER === 'sim' ? sim.moduleCode(p, mod) : await agent.moduleCode(p, mod, lastFeedback(mod));
    if (p._removed || !p.modules.includes(mod)) return;      // project已删 / 已被"重新构建"清掉：别把文件写回已清理的工作区
    const testRel = exec.safeRel(code.test.path);
    if (!testRel) throw new Error(`invalid test path from model: ${code.test.path}`);
    mod.files = exec.writeFiles(root, [...code.files, code.test]);
    if (!mod.files.length) throw new Error('model produced no writeable files');
    if (prof(p).deps) {                                          // 依存ありの栈：要求された依存を許可リストで篩って package.json に追記（版は平台固定）
      const pk = exec.ensurePackageJson(root, { stack: stackOf(p), deps: code.deps });
      if (pk.added.length) pushEvent(p, { stage: 'development', kind: 'step', text: `package.json: added ${pk.added.join(', ')} (versions pinned by platform allowlist)` });
      if (pk.rejected.length) pushEvent(p, { stage: 'development', kind: 'error', text: `⚠ ${mod.id} requested dependencies outside the allowlist (not installed): ${pk.rejected.join(', ')}` });
    }
    setProg(70, 'files written');
    if (code.usage) pushEvent(p, { stage: 'development', kind: 'step', text: `Model returned, token usage ${code.usage.total_tokens ?? '—'}` });
    pushEvent(p, { stage: 'development', kind: 'artifact', text: `wrote ${mod.files.length}  file(s): ${mod.files.map(f => f.path).join('、')}` });
    // 规约偏差可见：不许建module子目录、文件名不许带 WBS 序；不合规不拦截，但必须在事件流里看得见
    const wbsNo = /^m?\d+/i;                                     // M1OrderService / m1_order_service / 1_order 这类
    const off = mod.files.filter(f => {
      if (f.path === testRel || /^(db|srv)\/.*\.cds$/.test(f.path)) return false;
      if (!(mod.dir && f.path.startsWith(mod.dir + '/'))) return true;   // 没落进这一层的目录
      const rest = f.path.slice(mod.dir.length + 1);
      return rest.includes('/') || wbsNo.test(rest);                     // 又建了一层module子目录 / 文件名带了 WBS 序
    });
    if (off.length) pushEvent(p, { stage: 'development', kind: 'step', text: `⚠ ${mod.id}  has ${off.length}  file(s) not following layer convention (must be placed directly in ${mod.dir}/ / layer, named by business meaning, no WBS module/task numbers, no module subdirs): ${off.map(f => f.path).join('、')}` });
    // 同层重名会互相覆盖：写盘前先跟别's module的records比一遍，撞了就报出来
    const dup = [...(code.files || []), code.test].filter(x => x && x.path)
      .filter(x => p.modules.some(m => m !== mod && (m.files || []).some(f => f.path === x.path)));
    if (dup.length) pushEvent(p, { stage: 'development', kind: 'error', text: `⚠ ${mod.id}  file clashes with another module (same-layer overwrite — use a more specific name): ${dup.map(x => x.path).join('、')}` });

    // 仕様が曖昧なら推測で作らず疑問を返す（§6 疑問・変更台帳）：草稿ファイルは残し、テストは回答後の再実行で
    const qs = G.cleanQuestions(p, code.questions, mod);
    if (qs.length) {
      const added = raiseQuestions(p, mod, qs, mod.agent || 'Dev-Agent');
      mod.summary = code.summary || mod.summary || '';
      mod.status = 'on_hold'; mod.progress = 100; mod.progress_label = 'on hold';
      pushEvent(p, { stage: 'development', kind: 'gate', text: `⏸ module ${mod.id}"${mod.name}" on hold: ${added.length} open question(s) ${added.map(q => `${q.id} [${q.req_ids.join(', ') || '—'}]`).join('、')} → answer them in Traceability to resume` });
    } else {

      await d(200);
      setProg(85, 'running tests');
      const tr = await exec.runTests(root, testRel, prof(p), mod.files.map(f => f.path));   // ← 真实execute(按栈选run器；Java 只编本module，别的层同名类不该拖垮它)
      execNotes(p, 'development', tr);
      mod.unit_tests = unitTestsOf(tr);
      mod.summary = code.summary || mod.summary || '';
      mod.test_path = testRel;
      const cdsChk = prof(p).cds ? exec.checkCds(root) : null;
      mod.artifacts = [buildModuleReport(p, mod, tr, cdsChk)];
      pushEvent(p, { stage: 'development', kind: 'test', text: `real-ran ${tr.cmd} → PASS=${tr.passed} FAIL=${tr.failed}，exit code ${tr.exit_code}` });
      if (cdsChk) {
        pushEvent(p, { stage: 'development', kind: 'step', text: cdsChk.files
          ? `CDS 構造検証：${cdsChk.files} CDS files ${cdsChk.ok ? '構造正常' : 'Issues: ' + cdsChk.errors.map(e => `${e.file}：${e.error}`).join('；')}`
          : 'CDS 構造検証：No CDS files were produced by this module; CAP data/service layers should include db/schema.cds and srv/*.cds' });
      }
      if (tr.ok === false && tr.exit_code === -1 && /missing JDK|missing python3|JDK not found|python3 not found|npm missing|npm install failed|outside the allowlist|tsx not installed/i.test(tr.tail)) throw new Error(`module ${mod.id} could not run tests: ${tr.tail.split('\n')[0]}`);
      const pass = tr.exit_code === 0 && tr.failed === 0 && tr.total > 0;
      if (pass) {
        const broken = await reverifyApprovedModules(p, mod);      // 本module可能重写了同层文件 → 复核别人还成不成立
        mod.status = 'awaiting_review';
        mod.progress = 100; mod.progress_label = 'awaiting review';
        pushEvent(p, { stage: 'development', kind: 'gate', text: `⏸ module ${mod.id}"${mod.name}"done → awaiting manual approval (unit tests FAIL=0: PASS=${tr.passed})${broken.length ? `· same-layer audit found ${broken.length} module(s) sent back: ${broken.join('、')}` : ''}` });
      } else {
        // 门禁不通过 = modulefailed(不是"等人批准"): 这样 kick() 才会重排retry，并把真实failed输出喂回模型
        const bad = (tr.tail || '').split('\n').filter(l => /^✖ /.test(l)).map(l => l.replace(/^✖ /, '').replace(/\s*\(\d[\d.]*ms\)\s*$/, '').trim()).slice(0, 3);
        const more = (mod.attempts || 0) < 3 ? `→ Automatic retry (attempt ${(mod.attempts || 0) + 1}/3 attempts)` : '→ Three attempts failed. Inspect the actual output or reject the module to retry.';
        mod.status = 'failed';
        mod.error = (tr.timed_out
          ? `単体テストtimeout(${tr.ms}ms: test process did not exit; check open handles, timers, or pending promises)`
          : `単体テスト failed: PASS=${tr.passed} FAIL=${tr.failed}(exit code ${tr.exit_code})`)
          + (bad.length ? `· failed cases: ${bad.join('；')}` : '');
        pushEvent(p, { stage: 'development', kind: 'error', text: `✕ module ${mod.id}"${mod.name}"${mod.error} ${more}` });
      }
    }
  } catch (e) {
    const msg = e.message || String(e);
    if (!transientBounce(p, mod, 'development', 'module', msg)) {
      mod.status = 'failed'; mod.error = msg;
      pushEvent(p, { stage: 'development', kind: 'error', text: `✕ module ${mod.id}"${mod.name}"failed: ${mod.error}` });
    }
  }
  if (mod.requeue) {                       // 実行中に関係する疑問が回答された：この結果は古い前提なので作り直す
    delete mod.requeue;
    mod.status = G.heldBy(p, mod).some(q => q.module === mod.id) ? 'on_hold' : 'pending';
    pushEvent(p, { stage: 'development', kind: 'gate', text: `↻ module ${mod.id}"${mod.name}" re-queued: a related question was answered while it was running` });
  }
  syncDevelopment(p);
  save();
  kick(p, opts);
}

function syncDevelopment(p) {
  const st = p.stages.find(s => s.id === 'development');
  if (!st) return;
  const mods = p.modules;
  if (!mods.length) return;
  if (mods.every(m => m.status === 'approved')) {
    if (st.status !== 'approved') {
      st.status = 'approved'; st.finished_at = now();
      st.review = { decision: 'approved', by: 'Per-module approval', at: now() };
      const n = mods.reduce((a, m) => a + (m.unit_tests?.total || 0), 0);
      pushEvent(p, { stage: 'development', kind: 'gate', text: `✓ All ${mods.length}   module(s) approved · total real unit tests: ${n} tests · Development stage closed → enter integration testing` });
    }
  } else if (mods.some(m => m.status === 'failed')) {
    // 「failed が 1 件ある」＝即「開発停止」ではない。まだ走れる/再試行できる余地があれば
    // 実行中として扱う（UI に「停止」と出て実態と食い違うのを防ぐ）。
    const canProgress = mods.some(m => m.status === 'running')
      || mods.some(m => ['pending', 'rejected'].includes(m.status))
      || mods.some(m => m.status === 'failed' && (m.attempts || 0) < 3);
    st.status = canProgress ? 'running' : 'failed';
  }
  else if (mods.some(m => m.status === 'running')) st.status = 'running';
  else if (mods.some(m => m.status === 'awaiting_review' || m.status === 'on_hold')) st.status = 'awaiting_review';   // 人の判断待ち（承認 or 疑問への回答）
  else st.status = 'running';
}

/* "批准"= 对**current代码树**成立：同一层的文件会被别's module重写，所以一modules跑完(真通过)后，
   复核其它已批准module的用例，谁的用例挂了就把谁打回 failed —— retry循环会带着真实error让它重做(≤3 attempts)。
   ponytail: 逐modules重跑它的测试文件(ms 级)；要更省就把依赖图建起来只测受影响's module，等真的变慢再说。 */
export async function reverifyApprovedModules(p, changed, opts = {}) {
  const root = exec.wsDir(p.id);
  const broken = [];
  // 影響範囲を「実際に書き換えたファイル」に限定する。同層でも別ファイルなら再検証しない
  // （以前はレイヤー単位で再検証していたため、無関係なモジュールまで打ち戻されて永久に振動した）。
  const changedPaths = new Set((changed.files || []).map(f => f.path));
  for (const other of (p.modules || []).filter(m => m !== changed && m.status === 'approved' && m.test_path)) {
    const overlap = (other.files || []).some(f => changedPaths.has(f.path));
    if (!overlap) continue;
    const rel = exec.safeRel(other.test_path);
    if (!rel || !fs.existsSync(path.join(root, rel))) continue;
    const tr = await exec.runTests(root, rel, prof(p), (other.files || []).map(f => f.path));
    if (tr.ok) continue;
    other.unit_tests = unitTestsOf(tr);
    other.status = 'failed';
    other.error = `same-layer file changed: ${changed.id} — tests no longer passing：PASS=${tr.passed} FAIL=${tr.failed}(exit code ${tr.exit_code})`;
    broken.push(other.id);
    pushEvent(p, { stage: 'development', kind: 'error', text: `⚠ module ${other.id}"${other.name}"'s tests failed after rewrite by same-layer file → sent back: ${changed.id}: ${other.error}` });
  }
  return broken;
}

/* ---------- 审核(核心门禁) ---------- */

export function approveStage(p, stageId, reviewer = 'Human', { source = 'direct', ackGaps = false } = {}) {
  const st = p.stages.find(s => s.id === stageId);
  if (!st) throw new HttpError(404, 'Stage not found');
  if (st.kind === 'development') throw new HttpError(409, 'Development stage approves per module — cannot approve whole stage');
  if (st.status !== 'awaiting_review') throw new HttpError(409, `current status is "${st.status}" — cannot approve`);
  const bad = G.approvalViolation(p, st.id, reviewer, source);
  if (bad) { pushEvent(p, { stage: st.id, kind: 'error', text: `✕ ${st.name}: ${bad}` }); save(); throw new HttpError(403, bad); }
  const gaps = st.id === 'wbs' ? wbsGaps(p) : [];
  if (gaps.length && !ackGaps) throw new HttpError(409, `${gaps.length} requirements-ledger ID(s) are not assigned to any module: ${gaps.slice(0, 15).join(', ')}${gaps.length > 15 ? ' …' : ''}. Reject to re-plan, or approve with ack_gaps to accept the gaps.`);
  if (gaps.length) pushEvent(p, { stage: st.id, kind: 'gate', text: `⚠ ${st.name} approved with ${gaps.length} uncovered ledger ID(s) acknowledged by ${reviewer}` });
  st.status = 'approved'; st.finished_at = now(); delete st.human_hold;
  st.review = { decision: 'approved', by: reviewer, at: now(), source };
  st.artifacts.forEach(a => { a.status = 'approved'; });
  pushEvent(p, { stage: st.id, kind: 'gate', text: `✓ ${st.name} " approved (${reviewer}) → release next stage` });
  save(); kick(p); return st;
}

export function rejectStage(p, stageId, { category = 'Uncategorized', comment = '', reviewer = 'Human' } = {}) {
  const st = p.stages.find(s => s.id === stageId);
  if (!st) throw new HttpError(404, 'Stage not found');
  if (st.kind === 'development') throw new HttpError(409, 'Development stage rejects per module');
  if (st.status !== 'awaiting_review') throw new HttpError(409, `current status is "${st.status}" — cannot reject`);
  st.status = 'rejected'; delete st.human_hold;
  st.review = { decision: 'rejected', by: reviewer, at: now(), category, comment };
  pushEvent(p, { stage: st.id, kind: 'gate', text: `✕ ${st.name} rejected [${category}]${comment ? '：' + comment : ''} → feedback fed to model, retrying` });
  if (String(comment).trim()) draftLesson(p, { from: 'rejection', ref: st.id, stage: st.id, draft: G.lessonDraft({ kind: 'rejection', category, comment, stage: st.id }) });
  save();
  guarded(p.id, () => runStage(p, st.id));
  return st;
}

export function approveModule(p, moduleId, reviewer = 'Human', { source = 'direct' } = {}) {
  const mod = p.modules.find(m => m.id === moduleId);
  if (!mod) throw new HttpError(404, 'Module not found');
  if (mod.status !== 'awaiting_review') throw new HttpError(409, `module current status is "${mod.status}" — cannot approve`);
  const bad = G.approvalViolation(p, 'development', reviewer, source);
  if (bad) { pushEvent(p, { stage: 'development', kind: 'error', text: `✕ module ${mod.id}: ${bad}` }); save(); throw new HttpError(403, bad); }
  if (!mod.unit_tests) throw new HttpError(409, 'missing unit-test record — cannot approve');
  if (mod.unit_tests.exit_code !== 0 || mod.unit_tests.failed > 0) {
    const u = mod.unit_tests;
    // total=0 一般是"编译就没过"/"跑崩了"——别一律报"缺少単体テストrecords"，那会把人引到错方向
    const why = u.total > 0 ? `FAIL=${u.failed}`
      : /compilation failed/.test(u.tail || '') ? 'compilation failed'
      : 'Tests produced no results (see raw execution records)';
    throw new HttpError(409, `unit tests failed (${why}，exit code ${u.exit_code}) — cannot approve`);
  }
  if (mod.unit_tests.total <= 0) throw new HttpError(409, 'unit tests produced no cases (total=0) — cannot approve');
  const wait = G.blockedBy(p, mod);
  if (wait.length) throw new HttpError(409, `cannot approve ${mod.id} before its dependencies: ${wait.map(m => `${m.id} "${m.name}"`).join(', ')}`);
  if (CONC === 1) {                              // 串行模式才要求前序module先批准
    const idx = p.modules.indexOf(mod);
    const prev = p.modules.slice(0, idx).find(m => m.status !== 'approved');
    if (prev) throw new HttpError(409, `Predecessor module "${prev.name}" not approved`);
  }

  mod.status = 'approved'; delete mod.feedback;
  mod.review = { decision: 'approved', by: reviewer, at: now(), source };
  mod.artifacts.forEach(a => { a.status = 'approved'; });
  pushEvent(p, { stage: 'development', kind: 'gate', text: `✓ ${mod.agent || 'Dev-Agent'} 's module ${mod.id}"${mod.name}"" approved (${reviewer})· ${mod.unit_tests.cmd} PASS=${mod.unit_tests.passed}` });
  syncDevelopment(p);
  save(); kick(p); return mod;
}

export function rejectModule(p, moduleId, { category = 'Uncategorized', comment = '', reviewer = 'Human' } = {}) {
  const mod = p.modules.find(m => m.id === moduleId);
  if (!mod) throw new HttpError(404, 'Module not found');
  // failed も人から差し戻せる（自動再試行の上限 3 回に達した後の救済路）。
  if (!['awaiting_review', 'approved', 'failed'].includes(mod.status)) throw new HttpError(409, `module current status is "${mod.status}" — cannot reject`);
  const wasApproved = mod.status === 'approved';               // 已批准也能撤回重做：后来发现它把同层别's module写坏了是常事
  const wasFailed = mod.status === 'failed';
  mod.status = 'rejected'; mod.version += 1; mod.attempts = (wasApproved || wasFailed) ? 0 : mod.attempts;   // 人给的机会不计入自动retry的 3 轮
  mod.review = { decision: 'rejected', by: reviewer, at: now(), category, comment };
  pushEvent(p, { stage: 'development', kind: 'gate', text: `✕ module ${mod.id}"${mod.name}"${wasApproved ? '(approved → retracted)' : ''}rejected [${category}]${comment ? '：' + comment : ''} → feedback fed to model, retrying` });
  if (String(comment).trim()) draftLesson(p, { from: 'rejection', ref: mod.id, stage: 'development', draft: G.lessonDraft({ kind: 'rejection', category, comment, module: mod.id, name: mod.name }) });
  syncDevelopment(p);
  save();
  kick(p);                  // reject即重做，并由 kick 把其余并发槽位也补上
  return mod;
}

/* ---------- 疑問・変更台帳（§6）+ 教訓ループ（§10-7） ---------- */

const nextId = (list, prefix) => `${prefix}-${list.reduce((mx, x) => Math.max(mx, Number(String(x.id).replace(/\D/g, '')) || 0), 0) + 1}`;

/** 開発エージェントの疑問を台帳に登録（同じモジュール・同じ文面の未回答は重複登録しない）。 */
function raiseQuestions(p, mod, qs, by) {
  const list = (p.questions ||= []);
  const added = [];
  for (const q of qs) {
    const dup = list.find(x => x.status === 'open' && x.module === mod.id && x.text === q.text);
    if (dup) { added.push(dup); continue; }
    const item = { id: nextId(list, 'Q'), module: mod.id, req_ids: q.req_ids, text: q.text, status: 'open', asked_by: String(by).slice(0, 40), asked_at: now() };
    list.push(item); added.push(item);
  }
  return added;
}

/** 回答は人の判断：API 直叩き・自動化名義は拒否（ゲート方針と同じ基準）。 */
function humanOnly(p, what, by, source) {
  const why = source === 'api' ? `${what} must come from the dashboard (requests without x-approval-source: dashboard are treated as automated)`
    : source === 'auto' ? `${what} cannot be automated`
    : !String(by || '').trim() ? `${what} needs a named person`
    : G.looksAutomated(by) ? `${what}: "${by}" looks automated` : null;
  if (why) { pushEvent(p, { stage: 'development', kind: 'error', text: `✕ ${why}` }); save(); throw new HttpError(403, why); }
}

/**
 * 疑問に回答 → 影響分析：req_ids が重なるモジュール + 質問元 + それらに依存するモジュールだけを pending に戻し、
 * 回答をフィードバックとして渡す（無関係なモジュールは触らない）。回答は教訓の下書きにもなる。
 */
export function answerQuestion(p, qid, { answer = '', by = 'Human', source = 'direct' } = {}) {
  const q = G.questionsOf(p).find(x => x.id === qid);
  if (!q) throw new HttpError(404, `Question not found: ${qid}`);
  if (q.status !== 'open') throw new HttpError(409, `Question ${qid} is already ${q.status}`);
  const text = String(answer || '').trim().slice(0, 4000);
  if (!text) throw new HttpError(400, 'Answer cannot be empty');
  humanOnly(p, `Answer to ${qid}`, by, source);
  q.status = 'answered'; q.answer = text; q.answered_by = String(by).slice(0, 40); q.answered_at = now(); q.source = source;
  const imp = G.impactOf(p, q);
  q.impact = imp;
  const fb = { category: `Answer ${q.id}`, comment: `Question ${q.id} [${q.req_ids.join(', ')}]: ${q.text}\nAnswer (${q.answered_by}): ${text}\nApply this decision; do not ask it again.` };
  const reset = [], requeued = [];
  for (const id of imp.all) {
    const m = p.modules.find(x => x.id === id);
    if (!m) continue;
    m.feedback = fb;
    if (m.status === 'running') { m.requeue = true; requeued.push(id); continue; }
    if (m.status === 'pending' && !m.attempts) continue;               // 未着手：次の実行で回答を受け取るだけ
    const had = m.status !== 'pending';
    m.status = G.heldBy(p, m).some(x => x.module === m.id) ? 'on_hold' : 'pending';
    if (had) m.version = (m.version || 1) + 1;
    m.attempts = 0; m.error = null; delete m.transient;
    if (m.review && m.review.decision === 'rejected') delete m.review;  // 前回の差し戻しより回答を優先
    reset.push(id);
  }
  pushEvent(p, { stage: 'development', kind: 'gate', text: `✓ ${q.id} answered by ${q.answered_by} → impact: ${imp.direct.join(', ') || '—'}${imp.dependents.length ? ` (+ dependents ${imp.dependents.join(', ')})` : ''} · reset to pending: ${reset.join(', ') || 'none'}${requeued.length ? ` · re-queue after run: ${requeued.join(', ')}` : ''} · other modules untouched` });
  draftLesson(p, { from: 'question', ref: q.id, stage: 'development', draft: G.lessonDraft({ kind: 'question', req_ids: q.req_ids, question: q.text, answer: text }) });
  syncDevelopment(p);
  save(); kick(p);
  return { question: q, impact: imp, reset, requeued };
}

/** 教訓の下書きを作る（人が承認するまでスキルには入らない）。 */
function draftLesson(p, { from, ref, stage, draft }) {
  const list = (p.lessons ||= []);
  const l = { id: nextId(list, 'L'), from, ref, stage: stage || '', draft, status: 'draft', created_at: now() };
  list.push(l);
  if (list.length > 200) { const i = list.findIndex(x => x.status !== 'draft'); if (i >= 0) list.splice(i, 1); }   // 処理済みの古いものから捨てる
  pushEvent(p, { stage: stage || 'project', kind: 'info', text: `✎ lesson draft ${l.id} from ${from} ${ref} — approve it to append to the project skill "${G.lessonSkillName(l.stage)}"` });
  return l;
}

/** 教訓を承認：段階ごとの案件専用スキル（role: project）に 1 行追記。無ければ作る。body で文面を直せる。 */
export function approveLesson(p, lid, { body, by = 'Human', source = 'direct' } = {}) {
  const l = G.lessonsOf(p).find(x => x.id === lid);
  if (!l) throw new HttpError(404, `Lesson not found: ${lid}`);
  if (l.status !== 'draft') throw new HttpError(409, `Lesson ${lid} is already ${l.status}`);
  const line = String(body ?? l.draft).trim();
  if (!line) throw new HttpError(400, 'Lesson text cannot be empty');
  humanOnly(p, `Approving lesson ${lid}`, by, source);
  const name = G.lessonSkillName(l.stage);
  let skill = skillsOf(p).find(s => s.name === name && (s.stage || '') === l.stage && G.roleOf(s) === 'project');
  if (skill) {
    const next = `${skill.body}\n${line}`;
    if (next.length > SKILL_LIMIT.body) throw new HttpError(400, `Skill "${name}" would exceed ${SKILL_LIMIT.body} characters — consolidate it on the Skills page first`);
    skill.body = next;
    pushEvent(p, { stage: 'project', kind: 'artifact', text: `Lesson ${lid} appended to skill ${skill.id}"${name}" (${by})` });
  } else {
    skill = addSkill(p, { name, body: `Lessons from rejections and answered questions in this project. Follow them.\n${line}`, stage: l.stage, role: 'project', editor: `Lesson ${lid}` }, { silent: true });
    pushEvent(p, { stage: 'project', kind: 'artifact', text: `Lesson ${lid} → new project skill ${skill.id}"${name}" (${by})` });
  }
  l.status = 'approved'; l.text = line; l.skill = skill.id; l.by = String(by).slice(0, 40); l.at = now();
  save();
  return { lesson: l, skill };
}

export function dismissLesson(p, lid, { by = 'Human' } = {}) {
  const l = G.lessonsOf(p).find(x => x.id === lid);
  if (!l) throw new HttpError(404, `Lesson not found: ${lid}`);
  if (l.status !== 'draft') throw new HttpError(409, `Lesson ${lid} is already ${l.status}`);
  l.status = 'dismissed'; l.by = String(by).slice(0, 40); l.at = now();
  pushEvent(p, { stage: l.stage || 'project', kind: 'info', text: `Lesson ${lid} dismissed (${l.by})` });
  save();
  return l;
}

/* ---------- 汇总指标 ---------- */

/** 架构stage的 ARC-01 声明"source folder layout"→ 解析成层清单；没声明/非法 → 平台default层。
    不阻断流水线：模型格式不合规只是退回default，并由事件流标明来源。 */
function readLayout(p, st) {
  const arc = st.artifacts.find(a => a.id === 'ARC-01');
  const { layers: declared, stack } = agent.parseLayout(arc ? arc.content : '');
  const layers = declared.length ? declared : (p.arch && p.arch.layers && p.arch.layers.length ? p.arch.layers : agent.DEFAULT_LAYERS);   // ARC-01 优先 → 分类自带的Folder convention → 平台default
  const resolved = stack || p.tech || '';
  const pro = exec.profileOf(resolved);
  pushEvent(p, { stage: 'architecture', kind: 'step', text: `Tech stack: ${resolved || '(not specified)'}${stack ? ' (from ARC-01; ' + (!p.tech ? 'user did not specify; model chose' : stack === p.tech ? 'matches user input' : `differs from user input "${p.tech}"`) + ')' : ''}` });
  pushEvent(p, { stage: 'architecture', kind: 'step', text: `Language profile: ${pro.label} → source ${pro.id === 'java' || pro.id === 'cap-java' ? 'src/main/java/<layer>/' : 'src/<layer>/'}, test/ ${pro.testPath('layer', 'order-service.test' + pro.ext)}; ${pro.cds ? 'includes CDS modeling (db/schema.cds, srv/*.cds)' : 'no CDS'}; gate checks real runner exit code` });
  pushEvent(p, { stage: 'architecture', kind: 'step', text: declared.length
    ? `Source folder convention: ${layers.join(' / ')} (from ARC-01 "source folder layout") → module source goes directly to src/<layer>/ (named by business meaning, no WBS index)`
    : `ARC-01 did not declare a valid layer list → using the category's default folder convention: ${layers.join(' / ')} (category ${typeOf(p.type).name}; reverts on type-change or rebuild)` });
  return { layers, declared: declared.length > 0, from: declared.length ? 'ARC-01' : (p.arch && p.arch.from === 'type-default' ? 'type-default' : 'platform-default'), stack: resolved, stackFrom: stack ? 'ARC-01' : (p.tech ? 'user-input' : 'none'), profile: pro.id, at: now() };
}
const archLayers = (p) => (p.arch && p.arch.layers && p.arch.layers.length) ? p.arch.layers : agent.DEFAULT_LAYERS;

/* ---------- Tech stack → 言語プロファイル(决定代码扩展名、Folder convention、真跑命令) ---------- */
export const stackOf = (p) => (p.arch && p.arch.stack) || p.tech || '';
export const prof = (p) => exec.profileOf(stackOf(p));

/** WBS 結果を保存：deps を DAG に正規化(未指定ならレイヤー順で推定)してからモジュールを計画。 */
function storeWbs(p, r) {
  const layers = archLayers(p);
  const epics = G.normalizeDeps(r.epics.map((e, i) => ({ ...e, layer: agent.validLayer(layers, String(e.layer || '').toLowerCase()) || agent.layerAt(layers, i) })), layers);
  p.wbs = { epics, task_count: r.task_count, generated_at: r.generated_at || now(), model: r.model || null };
  p.modules = planModules(p, p.wbs, layers);
}

/** 每个 Epic 一modules；use folder来自架构规约(Epic 自报 layer，非法则按序回落)。 */
function planModules(p, wbs, layers) {
  const ls = (layers && layers.length) ? layers : agent.DEFAULT_LAYERS;
  const profile = prof(p);                                    // 语言决定目录/测试路径规约
  const used = new Set();
  return wbs.epics.map((e, i) => {
    const layer = agent.validLayer(ls, String(e.layer || '').toLowerCase()) || agent.layerAt(ls, i);
    let slugName = agent.slug(e.name);                        // business-name(不带 WBS 序)；重名才加 -2/-3 兜底
    for (let k = 2; used.has(slugName); k++) slugName = `${agent.slug(e.name)}-${k}`;
    used.add(slugName);
    return {
      id: `M${i + 1}`, epic: e.id, name: e.name, goal: e.goal, layer,
      deps: (e.deps || []).map(d => `M${String(d).replace(/\D/g, '')}`),                    // Epic En ↔ Module Mn
      req_ids: [...new Set([...(e.req_ids || []), ...(e.tasks || []).flatMap(t => t.req_ids || [])])],
      slug: slugName, dir: agent.modDirOf(profile, layer), test_path_planned: agent.testPathOf(profile, layer, i, e.name),
      profile: profile.id,
      status: 'pending', version: 0, attempts: 0, agent: null, files: [], unit_tests: null, artifacts: [], review: null, error: null,
    };
  });
}

export function summary(p) {
  const done = p.stages.filter(s => s.status === 'approved').length;
  const cur = currentStage(p);
  const unitTests = p.modules.reduce((a, m) => a + (m.unit_tests?.total || 0), 0);
  return {
    stages_total: p.stages.length, stages_done: done,
    current: cur ? { id: cur.id, name: cur.name, status: cur.status } : null,
    progress: p.stages.length ? done / p.stages.length : 0,
    epics: p.wbs.epics.length, tasks: p.wbs.task_count,
    modules_total: p.modules.length, modules_done: p.modules.filter(m => m.status === 'approved').length,
    modules_running: p.modules.filter(m => m.status === 'running').length,
    concurrency: CONC, agents: AGENTS,
    unit_tests: unitTests,
  };
}
