/* ============================================================
   agent.mjs — 真实模型通道（OpenAI 兼容 + Anthropic 兼容 双 adapter）
   Provider 来源（优先级）：
     1. settings.mjs 里配置的 provider（用户 UI 写的）
     2. 环境变量 AI_PLATFORM_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY + AI_PLATFORM_BASE_URL + AI_PLATFORM_MODEL（向后兼容老启动方式）
   项目里按阶段定义在 p.models[stageId]，格式 "providerId/modelName"（如 "minimax/MiniMax-M3"）。
   没定义 / 找不到 provider → 用 settings.mjs 的默认 provider（getDefaultProvider）→ 最后用 env→legacy。
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import { PROFILES, profileOf } from './exec.mjs';
import * as settings from './settings.mjs';
import * as exec from './exec.mjs';
import * as G from './governance.mjs';

const TIMEOUT_MS = Number(process.env.AI_PLATFORM_TIMEOUT_MS || 180000);
const MAX_OUT = 65536;             // 单次输出上限（重试时直接给满，不再小步试探）

/* ---------- 环境变量 key（向后兼容） ---------- */

function loadEnvKey() {
  if (process.env.AI_PLATFORM_API_KEY) return process.env.AI_PLATFORM_API_KEY;
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  // ~/.hermes/.env 只读 key（不读 BASE_URL/MODEL — 那俩走 settings.mjs）
  try {
    const m = fs.readFileSync(`${os.homedir()}/.hermes/.env`, 'utf8').match(/^\s*(?:DEEPSEEK|AI_PLATFORM|OPENAI)_API_KEY\s*=\s*"?([^"\n\r]+)"?/m);
    if (m) return m[1].trim();
  } catch { /* 没有就没有 */ }
  return null;
}
const ENV_KEY = loadEnvKey();
const ENV_MODEL = process.env.AI_PLATFORM_MODEL || null;
const ENV_BASE = process.env.AI_PLATFORM_BASE_URL || null;

/* ---------- 向后兼容的硬编码默认（无任何 provider/无 env 时的兜底） ---------- */
const LEGACY_MODEL = 'deepseek-v4-flash';
const LEGACY_BASE = 'https://api.deepseek.com/v1';

/** 解析"用哪个 provider"：settings → 默认 provider → env legacy → null。 */
function pickProvider() {
  if (process.env.AI_PLATFORM_PROVIDER === 'sim') return null;
  const def = settings.getDefaultProvider();
  if (def) return def;
  if (ENV_KEY && ENV_BASE) {
    return {
      id: '_env', name: 'env-legacy', apiStyle: 'openai',
      baseUrl: ENV_BASE, apiKey: ENV_KEY,
      models: ENV_MODEL ? [ENV_MODEL] : [], defaultModel: ENV_MODEL || LEGACY_MODEL,
      enabled: true,
    };
  }
  return null;
}

/** 取 provider + model：优先按项目-阶段；再默认 provider；再 env legacy。 */
export function resolveFor(project, stageId) {
  const ref = settings.resolveModelRef(project, stageId);
  if (ref) return { provider: ref.provider, model: ref.model };
  const def = pickProvider();
  if (def) return { provider: def, model: def.defaultModel || ENV_MODEL || LEGACY_MODEL };
  return null;
}

/** 显示用的模型名（去 provider/ 前缀）。 */
export function modelFor(project, stageId) {
  const ref = resolveFor(project, stageId);
  if (ref) return ref.model;
  return ENV_MODEL || LEGACY_MODEL;
}

/** 给老代码的 default 常量——首选默认 provider 的 defaultModel。 */
export const DEFAULT_MODEL = (() => {
  const def = settings.getDefaultProvider();
  if (def) return def.defaultModel;
  return ENV_MODEL || LEGACY_MODEL;
})();

export const available = () => !!pickProvider();
export const info = () => {
  if (process.env.AI_PLATFORM_PROVIDER === 'sim') return { channel: 'sim', provider: 'offline', model: null };
  const p = pickProvider();
  if (!p) return { channel: 'sim', provider: 'offline', model: null };
  let host = p.name || p.id;
  try { host = new URL(p.baseUrl).host; } catch { /* baseUrl 可能不合法 */ }
  return { channel: 'live', provider: host, model: p.defaultModel || LEGACY_MODEL };
};

export class ProviderError extends Error {}

/* ---------- 主调度 ---------- */

async function chat(messages, opts = {}) {
  messages = messages.map(m => m.role === 'system' ? { ...m, content: `${m.content}\n\n出力言語：すべての成果物、説明、名称、コメント、テスト名は日本語で記述し、技術用語とコード識別子には English を使用してください。中国語は出力しないでください。指定の JSON だけを返し、思考過程や <think> タグは含めないでください。` } : m);
  const { json = false, maxTokens = 4000, temperature = 0.3 } = opts;
  // 决定 provider：优先用 opts.provider（已 resolve 过的），否则按 project+stageId 解析
  let provider = opts.provider;
  let model = opts.model;
  if (!provider) {
    const ref = resolveFor(opts.project, opts.stageId);
    if (ref) { provider = ref.provider; model = model || ref.model; }
  }
  if (!provider) throw new ProviderError('No model API key configured (add a provider in LLM Providers, or set env var AI_PLATFORM_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY)');
  if (!provider.apiKey) throw new ProviderError(`provider "${provider.name}" has no API key`);
  model = model || provider.defaultModel || LEGACY_MODEL;
  if (provider.apiStyle === 'anthropic') return callAnthropic(messages, { json, maxTokens, temperature, model, provider });
  return callOpenAI(messages, { json, maxTokens, temperature, model, provider });
}

/* ---------- OpenAI 兼容（OpenAI / DeepSeek / MiniMax / 任何 OpenAI-风格代理） ---------- */

async function callOpenAI(messages, { json, maxTokens, temperature, model, provider }) {
  const base = String(provider.baseUrl || '').replace(/\/$/, '');
  const url = `${base}/chat/completions`;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const budget = attempt === 1 ? maxTokens : MAX_OUT;
    const body = { model, messages, max_tokens: budget, temperature, stream: false };
    if (json) body.response_format = { type: 'json_object' };
    // 思考量（DeepSeek V4.x / OpenAI o 系が受ける）。既定は送らない＝プロバイダ既定。
    // AI_PLATFORM_REASONING_EFFORT=none|low|high|max で上書き（ない場合は未送信）。
    if (process.env.AI_PLATFORM_REASONING_EFFORT) body.reasoning_effort = process.env.AI_PLATFORM_REASONING_EFFORT;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ProviderError(`Model returned ${r.status}: ${j.error?.message || j.message || 'unknown'}`);
      const choice = j.choices?.[0] || {};
      const text = choice.message?.content || '';
      if (!text.trim()) throw new ProviderError('Model returned empty content');
      if (choice.finish_reason === 'length') {
        lastErr = new ProviderError(`Model output truncated (finish_reason=length, hit ${budget} tokens)`);
        continue;
      }
      return { text, usage: j.usage, model: j.model || model, finishReason: choice.finish_reason };
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new ProviderError(`Model call timed out (${TIMEOUT_MS}ms)`) : e;
    } finally { clearTimeout(timer); }
    if (attempt === 1) await new Promise(r => setTimeout(r, 1200));
  }
  throw lastErr;
}

/* ---------- Anthropic 兼容（Anthropic Claude / MiniMax Anthropic 端点） ---------- */

async function callAnthropic(messages, { json, maxTokens, temperature, model, provider }) {
  const base = String(provider.baseUrl || '').replace(/\/$/, '');
  const url = `${base}/v1/messages`;

  // OpenAI 的 messages → Anthropic 的 system + messages
  let system = '';
  const conv = [];
  for (const m of messages) {
    if (m.role === 'system') system += (system ? '\n\n' : '') + m.content;
    else conv.push({ role: m.role, content: m.content });
  }

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const budget = attempt === 1 ? maxTokens : MAX_OUT;
    const body = {
      model,
      max_tokens: budget,
      temperature,
      ...(system ? { system } : {}),
      messages: conv,
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ProviderError(`Model returned ${r.status}: ${j.error?.message || j.message || 'unknown'}`);
      // Anthropic response: { content: [{ type: 'text', text: '...' }], stop_reason, usage }
      const blocks = Array.isArray(j.content) ? j.content : [];
      const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
      if (!text.trim()) {
        // 没有 text block 时把 thinking / tool_use 也作为错误信息暴露
        const sample = blocks.slice(0, 2).map(b => `[${b.type}]`).join(',') || 'empty';
        throw new ProviderError(`Model returned empty content（${sample}）`);
      }
      if (j.stop_reason === 'max_tokens') {
        lastErr = new ProviderError(`Model output truncated (stop_reason=max_tokens, hit ${budget} tokens)`);
        continue;
      }
      return { text, usage: j.usage, model: j.model || model, finishReason: j.stop_reason || 'stop' };
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new ProviderError(`Model call timed out (${TIMEOUT_MS}ms)`) : e;
    } finally { clearTimeout(timer); }
    if (attempt === 1) await new Promise(r => setTimeout(r, 1200));
  }
  throw lastErr;
}

const stripFences = (t) => String(t).replace(/<think>[\s\S]*?<\/think>/gi, '').trim().replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();

/** 走字符串：取到第 1 个 openChar 开始、与 openChar 同深度的首个 closeChar 闭合的平衡子串。
    不考虑跨字符串边界的括号/外突。失败返 null。 */
function balancedSlice(text, openChar, closeChar) {
  const start = text.indexOf(openChar);
  if (start < 0) return null;
  let depth = 0, inString = false, escape = false;
  for (let k = start; k < text.length; k++) {
    const c = text[k];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === openChar) depth++;
    else if (c === closeChar) { depth--; if (depth === 0) return text.slice(start, k + 1); }
  }
  return null;
}

/** 常见「近似 JSON」修复：去掉尾随逗号（仅在 } 或 ] 之前）。 */
const repairJSON = (s) => String(s).replace(/,(\s*[}\]])/g, '$1');

function parseJSON(text, what) {
  const t = stripFences(text);
  // 1) 原文直接 parse（response_format=json_object 时多数走这里）
  try { return JSON.parse(t); } catch {}
  // 2) 平衡括号切片：拿首个完整 {…}（处理「文字 + JSON + 文字」场景）
  const obj = balancedSlice(t, '{', '}');
  if (obj) {
    try { return JSON.parse(obj); } catch {}
    try { return JSON.parse(repairJSON(obj)); } catch {}
  }
  // 3) 数组变体：WBS 偶尔会被包成 [{…}]
  const arr = balancedSlice(t, '[', ']');
  if (arr) {
    try { return JSON.parse(repairJSON(arr)); } catch {}
    try { return JSON.parse(arr); } catch {}
  }
  // 4) 最后一招：去尾随逗号后硬 parse
  try { return JSON.parse(repairJSON(t)); }
  catch (e) { throw new ProviderError(`${what}: model did not return valid JSON (${e.message})`); }
}

/* ============================================================
   以下是各阶段业务函数（保持原 API 不变，把 chat 调用改成传 project+stageId 让调度器挑 provider）
   ============================================================ */

/* ---------- 源码目录结构规约（结构由平台定，层清单由架构阶段填） ---------- */

export const DEFAULT_LAYERS = ['core', 'domain', 'service', 'api'];

export function parseLayout(md) {
  for (const m of String(md || '').matchAll(/```json\s*([\s\S]*?)```/g)) {
    try {
      const o = JSON.parse(m[1]);
      const arr = Array.isArray(o);
      const dirs = arr ? o : (o.layers || []);
      const out = dirs
        .map(d => String(typeof d === 'string' ? d : (d && d.dir) || '').trim().toLowerCase())
        .filter(d => /^[a-z][a-z0-9_-]*$/.test(d));
      if (out.length) return { layers: [...new Set(out)], stack: String((arr ? '' : o.stack) || '').trim().slice(0, 160) };
    } catch { /* 这个块不是 JSON，跳过 */ }
  }
  return { layers: [], stack: '' };
}

export const parseLayers = (md) => parseLayout(md).layers;

export const validLayer = (layers, name) => ((layers || []).includes(name) ? name : null);
export const layerAt = (layers, i) => (layers && layers.length ? layers[i % layers.length] : DEFAULT_LAYERS[i % DEFAULT_LAYERS.length]);

/* ---------- 路径规约（按栈档案：Node/Python 一套，Java 一套） ---------- */

export function modDirOf(profile, layer) { return profile.modDir(layer); }
export function codeNameOf(profile, name) {
  const s = slug(name || 'module');
  if (profile.id === 'java' || profile.id === 'cap-java')
    return s.split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Module';
  if (profile.id === 'python') return s.replace(/-/g, '_');
  return s;
}
export const srcFileOf = (profile, name) => `${codeNameOf(profile, name)}${profile.ext}`;
export const testFileOf = (profile, name) => (profile.id === 'java' || profile.id === 'cap-java')
  ? `${codeNameOf(profile, name)}Test.java` : `${codeNameOf(profile, name)}.test${profile.ext}`;
export function testPathOf(profile, layer, i, name) { return profile.testPath(layer, testFileOf(profile, name)); }
function defaultFiles(layers, i, profile, name) {
  return `${profile.modDir(layerAt(layers, i))}/${srcFileOf(profile, name || 'module')}`;
}

export const slug = (s) => String(s).normalize('NFC').toLowerCase()
  .replace(/[^\w\u3040-\u30ff\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'mod';

/** 上传的输入materials → 提示词片段（每份截断，总量有上限）。 */
export function inputsBrief(project, totalCap = 6000, perCap = 1800) {
  const ins = (project && project.inputs) || [];
  if (!ins.length) return '';
  let left = totalCap;
  const parts = [];
  for (const f of ins) {
    if (left <= 0) break;
    const take = Math.min(perCap, left);
    const text = String(f.excerpt || '').slice(0, take);
    left -= text.length;
    parts.push(`--- ファイル：${f.name}（${f.bytes} 字节）---\n${text}${(f.excerpt || '').length > take ? '\n…（截断）' : ''}`);
  }
  return `\n项目输入materials（用户上传，共 ${ins.length} 份；以这些内容为准，不要自己臆造）：
${parts.join('\n\n')}\n`;
}

/* ---------- 项目技能库 → 提示词片段（按阶段过滤） ---------- */

const SKILL_PROMPT_MAX = 18000;

/** チェックリスト用の抜粋：Verification / Red Flags 節だけ（無ければ冒頭）。本文全体は注入しない。 */
const CHECK_MAX = 700;
export function checklistExcerpt(body) {
  const b = String(body || '');
  const md = [...b.matchAll(/^##\s*(Verification|Red Flags)[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/gm)].map(m => `${m[1]}: ${m[2].trim()}`);
  const agx = md.length ? [] : [...b.matchAll(/【(Verification|Red Flags)】([\s\S]*?)(?=【|$)/g)].map(m => `${m[1]}: ${m[2].trim()}`);
  const pick = (md.length ? md : agx).join('\n') || b;
  const t = pick.replace(/\n{2,}/g, '\n');
  return t.length > CHECK_MAX ? `${t.slice(0, CHECK_MAX).trimEnd()} …` : t;
}

const ROLE_MARK = { primary: '（主軸ワークフロー：手順はこれに従う）', checklist: '（チェックリスト：提出前に照合）' };

/**
 * 2 段階注入：① 索引（全スキルの名前と区分）は常に、② 本文は 主軸ワークフロー・案件専用 だけ全文、
 * チェックリストは Verification / Red Flags の抜粋だけ。段階が違うスキルは索引にも入れない。
 */
export function skillsBrief(project, stageId = '') {
  const ok = (s) => s && s.name && s.body;
  const forStage = (a) => (stageId ? a.filter(s => !s.stage || s.stage === stageId) : a);
  const ws = forStage((project && Array.isArray(project.ws_skills) ? project.ws_skills : []).filter(ok));
  const own = forStage((project && Array.isArray(project.skills) ? project.skills : []).filter(ok));
  const order = { primary: 0, project: 1, checklist: 2 };
  const list = [...ws, ...own.sort((a, b) => order[G.roleOf(a)] - order[G.roleOf(b)])];
  if (!list.length) return '';
  const kept = []; let used = 0, dropped = 0;
  for (const s of list) {
    const role = G.roleOf(s);
    const mark = s.from === 'workspace' ? '（本项目工作区自带 · 优先）' : (ROLE_MARK[role] || '');
    const line = `- 【${s.name}】${mark}${role === 'checklist' ? checklistExcerpt(s.body) : s.body}`;
    if (used + line.length > SKILL_PROMPT_MAX) { dropped++; continue; }
    kept.push(line); used += line.length;
  }
  const index = list.length > 1 ? `スキル索引（${list.length} 件）：${list.map(s => `${s.name}[${s.from === 'workspace' ? 'workspace' : G.roleOf(s)}]`).join('、')}\n` : '';
  const tag = '本项目「技能库」（逐条遵守；**优先级：工作区自带技能 > 项目技能库 > 平台通用默认**；冲突时以更靠前的为准）'
    + (stageId ? '' : '（本次不带阶段过滤）');
  const tail = dropped ? `\n- （另有 ${dropped} 条技能因提示词预算未注入：请精简技能或按阶段拆分）` : '';
  return `\n${tag}：\n${index}${kept.join('\n')}${tail}\n`;
}

/* ---------- 阶段交付物 ---------- */

const ARTIFACT_SPECS = {
  requirements: [['REQ-01', '要件定義書'], ['US-01', 'ユーザーストーリー集'], ['AC-01', '受入基準']],
  ux: [['UX-01', '情報構造とナビゲーション'], ['UX-02', '画面プロトタイプ仕様']],
  architecture: [['ARC-01', 'アーキテクチャ設計書'], ['ARC-02', 'データモデル設計'], ['ARC-03', 'API 仕様']],
  operations: [['SRE-01', '監視・アラート計画'], ['SRE-02', '運用手順書']],
  testing: [['TST-01', 'テスト計画']],
  deployment: [['DPL-01', 'デプロイ計画']],
};
const LAYOUT_RULE =
`本文档的附加硬性要求（技術スタック与源码目录结构规约）：
- 必须明确写出最终技術スタック：用户指定了技術スタック就照抄；用户**没有指定**时，由你选定一套最合适的（运行时 / 框架 / 数据库 / 测试方式）并説明选型理由。
- 正文必须有一节「源码目录结构」，先用 Markdown 表格列出各レイヤーディレクトリ（\`src/<层>/\`）的責務，再给一个 json 代码块，格式固定为：
\`\`\`json
{"stack":"Next.js + NestJS + PostgreSQL","layers":[{"dir":"core","responsibility":"…"},{"dir":"domain","responsibility":"…"}]}
\`\`\`
- 层名只用小写字母/数字/连字符，3–6 层；后续每个开发模块的源码都会按这个清单归档到 \`src/<层>/（直接放在レイヤーディレクトリ里，**不许再建模块子目录、文件名也不带 WBS 序号**；用业务语义命名，如 OrderService.java、order-service.mjs、order_service.py）\`，层要与模块划分对得上。
- 技術スタック要与实际能落地的代码一致。执行器能真跑的栈：① TypeScript + NestJS / Next.js + PostgreSQL 16（npm 依存许可清单内的包由平台写进 package.json 并真 npm install；単体テスト = tsx + node --test；PostgreSQL 由 Docker 起 postgres:16 供集成测试，没有 Docker 时明确记为 skipped）② Node.js ESM（无依存）③ Python 3 標準ライブラリ ④ Java（JDK のみ、Spring 等は実行不可）。用户指定了这些可执行的栈就**原样采用，不要为了「零依赖」把它改写成别的栈**；DB アクセスは Repository 層（インターフェース + InMemory 実装 + PostgreSQL 実装）で隔离；目录规约必须是可执行的。`;

/** UX 段階：文書だけで終わらせない（以前の「thin spec / no pixel design」は撤廃）。HTML プロトタイプはこの後に台帳の画面 ID ごとに生成・撮影される。 */
const UX_RULE =
`本文档的附加硬性要求（UX は「見える成果物」で確認する）：
- 実寸の画面プロトタイプ（HTML）と撮影画像を台帳の画面・帳票 ID ごとに 1 枚ずつ作る前提で書くこと。「薄い仕様だけ・ピクセルデザインはしない」方針は採らない。
- 共通テンプレート（ヘッダ：システム名・画面 ID・画面名／検索条件／一覧／明細／ファンクションキー F1〜F12、F2=検索・F5=登録・F12=終了は全画面共通）を定義し、全画面がそれに従うこと。
- 画面 ID ごとに：検索項目・一覧項目・明細項目（項目名・型・桁数・必須・初期値・エラー時表示）と状態（読込中・0 件・エラー・権限なし・閲覧のみ）を表で示すこと。
- 全画面はローファイ、業務上重要な画面（利用頻度・件数が多い画面）はハイファイで職員のユーザビリティ確認に使うことを明記すること。

`;

async function oneArtifact(project, stage, spec, feedback, allNames, extra = '') {
  const [id, name] = spec;
  const sys = `你是软件交付流水线里的${stage.agent}，负责「${stage.name}」阶段，正在写其中一份交付物。`;
  const user =
`项目名称：${project.name}
项目概要：${project.brief || '（未指定）'}
技術スタック：${project.tech || '（未指定）'}
${inputsBrief(project)}${skillsBrief(project, stage.id)}${feedback ? `上一轮被驳回的意见（必须吸收）：〔${feedback.category}〕${feedback.comment}\n` : ''}
请写出这一份交付物：**${id} ${name}**
（本阶段共 ${allNames.length} 份：${allNames.join('、')}；本份与其他份不重复）

${extra}要求：
1. 上記プロジェクトに即した Markdown 本文を日本語で作成してください。技術用語・コード識別子には English を使用できます。中国語は使用せず、汎用的な定型文だけで済ませないでください。
2. 篇幅 800–1500 字；表格用 Markdown 表格。
3. 只输出 JSON：{"content":"# ${name}\\n\\n..."}`;
  const { text, usage, model } = await chat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { json: true, maxTokens: 4096, project, stageId: stage.id },
  );
  let parsed;
  try { parsed = String(parseJSON(text, `${name}`).content || '').trim(); }
  catch { parsed = stripFences(text); }
  return { artifact: { id, name, type: 'markdown', content: parsed || `# ${name}\n\n（模型未返回内容）`, status: 'generated' }, usage, model };
}

export const artifactSpec = (stageId) => ARTIFACT_SPECS[stageId] || [['DOC-01', 'ステージ成果物']];

/** 段階ごとに要件台帳から渡す索引（要約ではなく ID そのもの）。 */
function ledgerExtra(project, stageId) {
  if (!G.ledgerItems(project).length) return '';
  if (stageId === 'requirements') return `要件台帳（入力資料の全文から抽出済み。ID\t種別\t名称）：\n${G.ledgerIndex(project, { max: 10000 })}\n本文はこの ID を見出し・表で参照し、要件を要約で丸めないこと。台帳に無い要件を書く場合だけ FR-/NFR- 番号を新設する。\n\n`;
  if (stageId === 'architecture') return `要件台帳のテーブル・IF（データモデルと API はこの ID と 1 対 1 で設計すること）：\n${G.ledgerIndex(project, { kinds: ['table', 'interface'], max: 8000 })}\n\n`;
  if (stageId === 'ux') return `要件台帳の画面・帳票・機能 ID（画面定義はこの ID と 1 対 1）：\n${G.ledgerIndex(project, { kinds: ['function', 'output', 'screen', 'report'], max: 8000 })}\n\n`;
  if (stageId === 'testing') {
    const cv = G.coverage(project);
    return `要件カバレッジ：台帳 ${cv.total} 件中 実装承認済み ${cv.implemented} 件・計画のみ ${cv.planned - cv.implemented} 件・未割当 ${cv.uncovered.length} 件${cv.uncovered.length ? `（未割当：${cv.uncovered.slice(0, 40).join(', ')}）` : ''}。テスト計画は ID ごとの判定とし、未実装 ID は「未検証」と明記すること。\n\n`;
  }
  return '';
}

/**
 * 要件台帳の補完：ID 付きで抽出できなかった機能要件・非機能要件だけを FR-/NFR- 番号で追加する（1 回の呼び出し）。
 * 抽出済み ID の書き換えはしない（決定的に取れるものは LLM に任せない）。
 */
export async function ledgerSupplement(project, scanned) {
  const counts = {};
  for (const it of scanned) counts[it.kind] = (counts[it.kind] || 0) + 1;
  const sys = '你是业务分析师，负责补全需求台账。你只输出 JSON。';
  const user =
`项目：${project.name}
概要：${project.brief || '（未指定）'}
${inputsBrief(project, 12000, 2400)}
已从输入资料全文中机械抽取的 ID：${Object.entries(counts).map(([k, n]) => `${k} ${n} 件`).join('、') || 'なし'}（例：${scanned.slice(0, 30).map(it => it.id).join(', ')}）

请只补充**没有 ID 的**机能要件与非机能要件（稼働時間・RPO・性能・セキュリティ・移行・外部連携など），不要重复上面已有 ID 的内容。
最多 40 条。只输出 JSON：
{"items":[{"id":"FR-001","kind":"requirement","name":"…（40 字以内）","source":"根拠となる資料名"},{"id":"NFR-001","kind":"nfr","name":"…","source":"…"}]}`;
  const { text, usage, model } = await chat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { json: true, maxTokens: 6000, project, stageId: 'requirements' },
  );
  const out = parseJSON(text, 'Ledger supplement');
  const seen = new Set(scanned.map(it => it.id));
  const items = (Array.isArray(out.items) ? out.items : []).slice(0, 40).map((it, i) => {
    const kind = it.kind === 'nfr' ? 'nfr' : 'requirement';
    let id = String(it.id || '').trim().toUpperCase();
    if (!/^(FR|NFR)-\d{2,4}$/.test(id) || seen.has(id)) id = `${kind === 'nfr' ? 'NFR' : 'FR'}-${String(900 + i).padStart(3, '0')}`;
    seen.add(id);
    return { id, kind, name: String(it.name || '').slice(0, 40), parent: null, refs: 0, sources: it.source ? [{ file: String(it.source).slice(0, 60), line: 0 }] : [], origin: 'model' };
  });
  return { items, usage, model };
}

export async function stageArtifacts(project, stage, feedback, onProgress) {
  const specs = artifactSpec(stage.id);
  const names = specs.map(s => s[1]);
  const artifacts = [];
  let usage = null, model = null;
  const led = ledgerExtra(project, stage.id);
  for (let i = 0; i < specs.length; i++) {
    const extra = led + ((stage.id === 'architecture' && specs[i][0] === 'ARC-01') ? LAYOUT_RULE : '') + (stage.id === 'ux' ? UX_RULE : '');
    const r = await oneArtifact(project, stage, specs[i], feedback, names, extra);
    artifacts.push(r.artifact);
    usage = r.usage || usage; model = r.model || model;
    if (onProgress) onProgress(i + 1, specs.length, r.artifact);
  }
  return { artifacts, usage, model };
}

/* ---------- WBS ---------- */

export async function wbs(project) {
  const layers = (project.arch && project.arch.layers && project.arch.layers.length) ? project.arch.layers : DEFAULT_LAYERS;
  const stack = (project.arch && project.arch.stack) || project.tech || '（未指定）';
  const profile = profileOf(stack);
  const sys = '你是任务规划师，负责把软件需求拆成可独立开发、可単体テスト的模块。你只输出 JSON。';
  // 要件台帳がある = 機能 ID 単位の縦割りスライスに切る（規模に応じて Epic 数を増やす）。無ければ従来どおり 4–7 Epic。
  const funcs = G.ledgerItems(project).filter(it => it.kind === 'function' || it.kind === 'requirement').length;
  const maxEpics = funcs > 14 ? Math.min(60, Math.ceil(funcs / 2)) : 7;
  const minEpics = funcs > 14 ? Math.min(maxEpics, Math.max(8, Math.ceil(funcs / 4))) : 4;
  const ledger = G.ledgerIndex(project, { max: 14000 });
  const user =
`项目：${project.name}
概要：${project.brief || '（未指定）'}
技術スタック：${stack}
${inputsBrief(project)}${skillsBrief(project, 'wbs')}架构已定的源码レイヤーディレクトリ（一个 Epic 一个模块，源码就落在它所属的レイヤーディレクトリ下）：${layers.join(' / ')}
${ledger ? `\n要件台帳（入力資料の全文から抽出した ID。WBS はこの ID で追跡される。ID\t種別\t名称）：\n${ledger}\n` : ''}
把项目拆成 ${minEpics}–${maxEpics} 个 Epic，每个 Epic 2–4 个 Task。每个 Epic 之后会作为一个开发模块，由工程师写代码 + 単体テスト。
要求：
1. 每个 Epic 必须带 layer，值只能取上面列出的层之一（决定源码落到哪一レイヤーディレクトリ）。
2. Task 要小到能用一个模块实现并写单测；files 写成 ${defaultFiles(layers, 0, profile, '基础框架')}。
3. 每个 Epic 必须带 deps：它依赖的**前面** Epic 的编号（"E1" 形式，从 1 开始，按输出顺序）。Epic 按依赖顺序排列（マスタ → 台帳 → 業務処理 → 締め → 帳票），被依赖的放前面；没有依赖就给 []。
${ledger ? `4. 按「縦割りスライス」切分：一个 Epic 对应一组相关的機能 ID（画面 → API → DB → テスト一气通贯），不要按技术层横切。每个 Epic 和 Task 必须带 req_ids（只能用上面台帳里的 ID），台帳里的每个 ID 至少被一个 Epic 覆盖；Task 的 acceptance 要写出该 ID 的業務上の判定条件（テーブル ID・項目・桁数など原文の制約）。\n` : ''}${ledger ? '5' : '4'}. 只输出 JSON：
{"epics":[{"name":"基础框架","layer":"${layers[0]}","goal":"一句话目標","deps":[],"req_ids":[],"tasks":[{"name":"任务名","files":"${defaultFiles(layers, 0, profile, '基础框架')}","acceptance":"可机器判定的受入基準","req_ids":[]}]}]}`;
  const { text, usage, model } = await chat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { json: true, maxTokens: maxEpics > 7 ? 32000 : 4000, project, stageId: 'wbs' },
  );
  const out = parseJSON(text, 'WBS');
  const epics = (Array.isArray(out.epics) ? out.epics : []).slice(0, Math.max(8, maxEpics)).map((e, i) => ({
    id: `E${i + 1}`,
    name: String(e.name || `Epic ${i + 1}`).slice(0, 60),
    layer: validLayer(layers, String(e.layer || '').trim().toLowerCase()) || layerAt(layers, i),
    goal: String(e.goal || '').slice(0, 200),
    deps: Array.isArray(e.deps) ? e.deps : undefined,          // 欠落 = governance がレイヤー順で推定
    req_ids: G.cleanReqIds(project, e.req_ids),
    tasks: (Array.isArray(e.tasks) ? e.tasks : []).slice(0, 6).map((t, j) => ({
      id: `E${i + 1}-T${j + 1}`,
      name: String(t.name || `Task ${j + 1}`).slice(0, 80),
      files: String(t.files || defaultFiles(layers, i, profile, e.name)).slice(0, 120),
      acceptance: String(t.acceptance || '単体テスト通过').slice(0, 300),
      req_ids: G.cleanReqIds(project, t.req_ids),
      status: 'todo',
    })),
  })).filter(e => e.tasks.length);
  if (!epics.length) throw new ProviderError('WBS: model returned no usable epics');
  return { epics, task_count: epics.reduce((a, e) => a + e.tasks.length, 0), layers, generated_at: new Date().toISOString(), usage, model };
}

/* ---------- 模块：真实生成代码 + 单测 ---------- */

/** TypeScript 档案（NestJS / Next.js / PostgreSQL）：依存は許可リストから「名前だけ」要求、DB は Repository 層経由。 */
function tsSpec(dir, testPath) {
  const up = '../'.repeat(testPath.split('/').length - 1);
  const allow = Object.keys(exec.npmAllow()).join(' / ');
  return {
    role: '你是资深 TypeScript 工程师（NestJS / Next.js / PostgreSQL），产出能被 tsx + node --test 真跑通的代码。你只输出 JSON。',
    rules: `1. 可以用第三方包，但**只能用许可清单里的**：${allow}。本模块用到的包名写进输出 JSON 的 "deps"（只写包名，版本由平台固定）；package.json / tsconfig.json / npm install 由平台负责，**不要输出 package.json**。清单外的包不会被安装，import 会直接失败、模块判失败。
2. 数据库访问一律经过 Repository 层：先定义接口（如 \`export interface OrderRepository { findById(id: string): Promise<Order | null> }\`），同时提供 \`InMemoryOrderRepository\`（単体テスト用）与用 \`pg\` Pool 实现的 \`PgOrderRepository\`（参数化 SQL \`$1\`，禁止拼接字符串）；Service / Controller 只依赖接口、经构造函数注入，不直接 import pg。NestJS 的 @Injectable / @Controller 可以用，用装饰器的文件首行 \`import 'reflect-metadata';\`；非类 token 用 \`@Inject(TOKEN)\`。Next.js 页面组件只做展示，把可测逻辑抽成同层 .ts 纯函数。
3. 时间、随机数、ID 由参数/构造函数注入（不要 Date.now / Math.random）；模块为 CommonJS 解析：相对 import **不写扩展名**（\`from '${up}${dir}/order-service'\`）。`,
    files: `源码只能放 ${dir}/ 下的 .ts（React 组件可用 .tsx；架构规约指定的レイヤーディレクトリ，不许改到别处）；**不许建模块子目录**，文件名用业务语义的 kebab-case（如 order-service.ts、order-repository.ts），**不要带 WBS 模块号/任务号**`,
    test: `単体テスト放 ${testPath}，用 node:test（执行侧是 \`node --import tsx --test ${testPath}\`）：
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { OrderService } from '${up}${dir}/order-service';
単体テストは InMemory リポジトリを直接 new して注入する（Nest の DI コンテナや本物の DB に依存しない）。
本物の PostgreSQL が要る統合ケースは必ずこの形にする（平台は Docker があれば postgres:16 を起動して DATABASE_URL を渡し、無ければ skipped として記録し合格扱いにしない）：
test('PgOrderRepository 往復', { skip: !process.env.DATABASE_URL && 'PostgreSQL unavailable' }, async () => {
  const { Pool } = await import('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try { await pool.query('CREATE TABLE IF NOT EXISTS ...'); /* 断言 */ } finally { await pool.end(); }
});`,
  };
}

function langSpec(profile, dir, testPath) {
  const testClass = testPath.split('/').pop().replace(/\.[a-z]+$/, '');
  if (profile.id === 'java' || profile.id === 'cap-java') return {
    role: '你是资深 Java 工程师，产出能被 javac 编译、被 java 真跑通的 Java 代码。你只输出 JSON。',
    rules: `1. 只用 JDK 標準ライブラリ（java.util / java.math / java.time / java.util.stream 等）；**禁止任何第三方依赖，也禁止 Spring / JPA / SAP CAP 注解**——执行侧只有 javac，没有 Maven 仓库，import 不到的包会直接编译失败。需要存储/状态就用内存集合模拟。
2. 不要写 package 声明（编译走默认包）；类名用**业务语义**的 PascalCase 英文（例：OrderRule / OrderService），文件名 = public 类名；**整个工作区里类名必须全局唯一**——没有 package，各层的 .java 一起进同一个 classpath，两个层各写一个 Order 或 ApiResponse 就是 「クラスOrderが重複しています」、整个项目全红：同一个业务实体的实体类**只在一个层定义**，别的层复用它或换更具体的名字（写 OrderRepositoryItem 而不是再写一个 Order）；**类名里不要带 WBS 模块号/任务号**（不写 M1OrderRule、E2T1OrderRule）。
3. 不要 System.currentTimeMillis / new Random()（时间、随机等外部输入请作为参数传入）。`,
    files: `源码只能放 ${dir}/ 下的 .java（架构规约指定的レイヤーディレクトリ，不许改到别处）`,
    test: `単体テスト放 ${testPath}，public 类名 = 被测模块名 + Test（如 ${testClass}），且必须是可直接执行的 main（执行侧就是 \`java ${testClass}\`）：
public class ${testClass} {
  static int pass = 0, fail = 0;
  static void check(String name, boolean ok) { if (ok) pass++; else { fail++; System.out.println("not ok - " + name); } }
  public static void main(String[] args) {
    check("具体断言名", 期望值 == 实际值);   // 断言要具体，别只 check("ok", true)
    System.out.println("tests " + (pass + fail));
    System.out.println("pass " + pass);
    System.out.println("fail " + fail);
    System.exit(fail == 0 ? 0 : 1);
  }
}`,
  };
  if (profile.id === 'python') return {
    role: '你是资深 Python 工程师，产出能被 python3 + 標準ライブラリ unittest 真跑通的代码。你只输出 JSON。',
    rules: `1. 只用 Python 標準ライブラリ；**禁止第三方包**（fastapi/flask/pydantic/requests/pytest 一律不要——它们没安装，import 就 ModuleNotFoundError）。需要存储/状态就用内存结构模拟。
2. 模块文件名用 ASCII snake_case 的业务语义名（例：order_service.py），不要带模块号，不要有 import 时的副作用。
3. 不要 time.time() / random（时间、随机等外部输入请作为参数传入）。`,
    files: `源码只能放 ${dir}/ 下的 .py（架构规约指定的レイヤーディレクトリ，不许改到别处）；**不许建模块子目录**，文件名用业务语义的 snake_case（如 order_service.py），**不要带 WBS 模块号/任务号**（不写 m1_order_service.py），同层靠business-name区分`,
    test: `単体テスト放 ${testPath}：標準ライブラリ unittest，头部把源码目录加进 sys.path 再按文件名 import，文件尾部必须有 unittest.main()：
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '${dir}'))
from <你的模块文件名去 .py> import <被测函数>

class TestX(unittest.TestCase):
    def test_xxx(self): self.assertEqual(...)

if __name__ == '__main__':
    unittest.main()`,
  };
  if (profile.deps) return tsSpec(dir, testPath);
  return {
    role: '你是资深 Node.js 工程师，产出可运行、可测试的 ES Module 代码。你只输出 JSON。',
    rules: `1. 只允许 Node 内置模块与纯函数；**禁止引入任何第三方包**（pg / express / axios / dotenv / uuid 等一律不要——它们没安装，import 会直接报 ERR_MODULE_NOT_FOUND）。需要存储/状态就用内存对象或纯数据结构模拟。
2. 不要网络、不要文件系统、不要 Date.now/Math.random（时间请由参数传入）。`,
    files: `源码只能放 ${dir}/ 下的 .mjs（架构规约指定的レイヤーディレクトリ，不许改到别处）；**不许建模块子目录**，文件名用业务语义的 kebab-case（如 order-service.mjs），**不要带 WBS 模块号/任务号**（不写 m1-order-service.mjs、M1OrderService.mjs），同层靠business-name区分`,
    test: `単体テスト放 ${testPath}，必须用：
import { test } from 'node:test'; import assert from 'node:assert/strict';
并从 '${'../'.repeat(testPath.split('/').length - 1)}${dir}/xxx.mjs' 导入被测函数（测试目录比源码浅一层，相对路径以 ${'../'.repeat(testPath.split('/').length - 1)} 开头）。`,
  };
}

/**
 * モジュール用コンテキストパック：上流の要約ではなく、
 *  ① 担当する要件 ID の原文行（入力資料の該当箇所 ±2 行）
 *  ② 依存モジュールの実ソース（mock せず import して使うため）
 * をそれぞれ上限付きで渡す。
 */
export function moduleContext(project, mod, { reqCap = 6000, depCap = 8000 } = {}) {
  const parts = [];
  const items = G.ledgerItems(project).filter(it => (mod.req_ids || []).includes(it.id) || (it.parent && (mod.req_ids || []).includes(it.parent)));
  if (items.length) {
    const root = exec.wsDir(project.id);
    const cache = new Map();
    const lines = (file) => {
      if (!cache.has(file)) { let t = ''; try { t = fs.readFileSync(`${root}/inputs/${file}`, 'utf8'); } catch {} cache.set(file, t.split(/\r?\n/)); }
      return cache.get(file);
    };
    let used = 0; const out = [];
    for (const it of items) {
      const src = (it.sources || []).slice(0, 2).map(s => {
        const ls = lines(s.file); if (!ls.length) return '';
        return `  〔${s.file}:${s.line}〕\n` + ls.slice(Math.max(0, s.line - 3), s.line + 2).map(l => `    ${l.slice(0, 200)}`).join('\n');
      }).filter(Boolean).join('\n');
      const block = `- ${it.id}（${it.kind}）${it.name || ''}\n${src}`;
      if (used + block.length > reqCap) { out.push(`- …（残り ${items.length - out.length} 件は ID のみ：${items.slice(out.length).map(x => x.id).join(', ')}）`); break; }
      out.push(block); used += block.length;
    }
    parts.push(`\n本模块负责的要件 ID（原文抜粋。業務ルール・桁数・コード値は原文どおりに実装し、単体テストで検証すること）：\n${out.join('\n')}\n`);
  }
  const deps = (mod.deps || []).map(id => (project.modules || []).find(m => m.id === id)).filter(Boolean);
  if (deps.length) {
    const root = exec.wsDir(project.id);
    let used = 0; const out = [];
    for (const d of deps) {
      for (const f of (d.files || []).filter(f => f.path !== d.test_path)) {
        let body = ''; try { body = fs.readFileSync(`${root}/${f.path}`, 'utf8'); } catch { continue; }
        const block = `--- ${d.id} ${d.name}：${f.path} ---\n${body.slice(0, 2500)}`;
        if (used + block.length > depCap) { out.push(`--- （${f.path} ほかは省略：パスだけ参照可）`); break; }
        out.push(block); used += block.length;
      }
    }
    parts.push(`\n依存モジュール（承認済みの実コード。**同じ機能を再実装・mock せず、相対パスで import して使う**）：${deps.map(d => `${d.id} ${d.name}`).join('、')}\n${out.join('\n')}\n`);
  }
  // 疑問・変更台帳の回答済み決定事項：担当 ID が重なるもの・自分が出したものは必ず従う（再質問しない）
  const mine = new Set(mod.req_ids || []);
  const decided = G.questionsOf(project).filter(q => q.status === 'answered' && (q.module === mod.id || (q.req_ids || []).some(id => mine.has(id))));
  if (decided.length) parts.push(`\n確定した仕様判断（疑問・変更台帳。原文より優先し、同じ疑問を再度出さない）：\n${decided.map(q => `- ${q.id} [${(q.req_ids || []).join(', ')}] Q：${q.text}\n  A（${q.answered_by}）：${q.answer}`).join('\n')}\n`);
  return parts.join('');
}

export async function moduleCode(project, mod, feedback) {
  const stack = (project.arch && project.arch.stack) || project.tech || 'Node.js';
  const profile = profileOf(stack);
  const dir = mod.dir || `src/${mod.layer || 'core'}`;
  const testPath = mod.test_path_planned || testPathOf(profile, mod.layer || 'core', 0, mod.name);
  const tasks = (project.wbs.epics.find(e => e.id === mod.epic)?.tasks) || [];
  const spec = langSpec(profile, dir, testPath);
  const cds = profile.cds ? `\n8. 本项目是 SAP CAP：本模块若涉及Data models或服务定义，必须同时产出真实 CDS 文件（db/schema.cds、srv/<名>-service.cds）：namespace + entity（**每个实体必须有 key**）+ service/projection；不要用 Java 注解或任何 ORM 替代 CDS 建模。` : '';
  const exFile = profile.ext;
  const ctx = moduleContext(project, mod);
  const sys = spec.role;
  const user =
`项目：${project.name}（技術スタック：${stack} → 言語プロファイル：${profile.label}）
模块：${mod.name}
模块所属源码层：${mod.layer || 'core'}（架构规约；源码直接放在 ${dir}/ 这一层，**不要再建模块子目录**）
模块目標：${mod.goal || '（未给出）'}
任务清单：
${tasks.map(t => `- ${t.name}${t.acceptance ? `（验收：${t.acceptance}）` : ''}`).join('\n') || '- （无）'}
${ctx}${feedback ? `\n上一轮被驳回的意见（必须修正）：〔${feedback.category}〕${feedback.comment}\n` : ''}${skillsBrief(project, 'development')}
硬性要求：
${spec.rules}
4. ${spec.files}；単体テスト放 ${testPath}。
5. ${spec.test}
6. 每files ≤ 150 行；被测函数要导出（Java 用 public static）。
7. 単体テスト要确实覆盖任务清单里的行为，断言要具体（断言值，不要只 check("ok", true) / assert.ok(x)）。${cds}
9. 原文に無い・矛盾する・解釈が分かれる業務ルール（端数処理、境界値、コード値、例外時の扱いなど）は**推測で決めず** questions に挙げる（関係する要件 ID 付き、1 件 1 論点、最大 5 件）。それでも files / test は現時点の最善の草稿として出す（人の回答後に作り直す）。疑問が無ければ questions は [] にする。
10. 只输出 JSON：
{"summary":"本模块实现了什么","files":[{"path":"${dir}/<业务文件名>${exFile}","content":"..."}],"test":{"path":"${testPath}","content":"..."},"questions":[{"req_ids":["<要件 ID>"],"text":"<人に確認したいこと>"}]${profile.deps ? ',"deps":["<许可清单内的包名>"]' : ''}}`;
  const budget = profile.id === 'java' || profile.id === 'cap-java' ? 24000 : profile.deps ? 16000 : 8000;
  let out = null, usage = null, model = null, text = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryNote = attempt === 1 ? '' : `\n\n上一次返回不合格：${!out ? 'JSON 解析失败' : (!(out.files || []).length ? 'files 为空' : '缺少 test 字段（必须是 {path, content}）')}。这次务必带上 test，且保证 JSON 完整：必要时减少源码文件数、精简每段代码，宁可少而全，不要多而缺。`;
    const r = await chat(
      [{ role: 'system', content: sys }, { role: 'user', content: user + retryNote }],
      { json: true, maxTokens: budget, temperature: attempt === 1 ? 0.2 : 0.1, project, stageId: 'development' },
    );
    text = r.text; usage = r.usage; model = r.model;
    try { out = parseJSON(text, `Module ${mod.id} code`); } catch (e) { out = null; if (attempt === 2) throw e; continue; }
    if ((out.files || []).length && out.test && typeof out.test.content === 'string') break;
    if (attempt === 2) break;
  }
  const files = Array.isArray(out && out.files) ? out.files : [];
  const test = out && out.test && typeof out.test.content === 'string' ? out.test : null;
  const shape = ` (fields: ${Object.keys(out || {}).join(', ') || 'none'}; files=${files.length}${test ? '' : '; test is missing or is not {path,content}'}; ${text.length} characters)`;
  if (!files.length) throw new ProviderError(`Module ${mod.id}: model returned no source files${shape}`);
  if (!test) throw new ProviderError(`Module ${mod.id}: model returned no unit test${shape}`);
  const questions = Array.isArray(out.questions) ? out.questions : [];
  const deps = profile.deps && Array.isArray(out.deps) ? out.deps.map(String).slice(0, 20) : [];
  return { summary: String(out.summary || '').slice(0, 300), files, test, questions, deps, usage, model, profile: profile.id };
}

/* ---------- UX：デザインシステム（1 回）と重要画面のハイファイ内容（画面ごと） ---------- */

/** 共通テンプレートのトークンとファンクションキー割当を 1 回だけ決める。HTML 自体はプラットフォームのテンプレートで組む（壊れた HTML を出させない）。 */
export async function uxDesign(project) {
  const sys = '你是业务系统的 UX 设计师，负责为整个系统定一套设计系统（共通テンプレート）。你只输出 JSON。';
  const user =
`项目：${project.name}
概要：${project.brief || '（未指定）'}
${inputsBrief(project, 6000, 1500)}${skillsBrief(project, 'ux')}
请为该业务系统（现行是检索条件 + 一览 + 明细 + ファンクションキー的端末画面）决定共通テンプレートのトークン与ファンクションキー割当。
只输出 JSON：
{"system":"システム名（20 字以内）","tokens":{"brand":"#0b5394","ink":"#1f2328","muted":"#5b6470","line":"#c9d1da","panel":"#f4f6f9","accent":"#0b7a3e","danger":"#b42318","density":"compact"},
 "fkeys":[{"key":"F1","label":"ヘルプ"},{"key":"F2","label":"検索"},{"key":"F5","label":"登録"},{"key":"F12","label":"終了"}]}
约束：F2=検索・F5=登録・F12=終了 必须保留；label 6 字以内；颜色必须 #hex，需满足文字对比度 4.5:1。`;
  const { text, usage, model } = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, maxTokens: 1200, project, stageId: 'ux' });
  const out = parseJSON(text, 'UX design system');
  return { system: String(out.system || project.name).slice(0, 20), tokens: out.tokens || {}, fkeys: out.fkeys || [], usage, model };
}

/** 重要画面 1 枚のハイファイ内容。項目は現行資料から抽出済み（base）を出発点に、並び・初期値・メッセージ・注記を詰める。 */
export async function uxScreen(project, scr, asis, base) {
  const sys = '你是业务系统的 UX 设计师，正在把一张现行画面做成高保真原型（供职员做可用性测试）。你只输出 JSON。';
  const user =
`项目：${project.name}
画面 ID：${scr.id}　画面名：${scr.name || '（不明）'}　種別：${scr.form === 'report' ? '帳票' : '画面'}
現行資料（${asis.file || 'なし'}）：
${String(asis.text || '（現行資料に記載なし）').slice(0, 3500)}

从现行资料抽取的项目（出発点，不得遗漏）：
${JSON.stringify({ search: base.search, columns: base.columns, detail: base.detail }).slice(0, 4000)}

请输出这一画面的高保真内容。只输出 JSON：
{"search":[{"label":"…","type":"text|number|date|check","len":10,"note":"…"}],"columns":[…同形…],"detail":[…同形…],"rows":8,"message":"画面下部のガイダンス（40 字以内）","notes":["状態：0 件時は…","権限なし時は…"]}
约束：现行项目全部保留（可改顺序、可补充）；label 24 字以内；notes 最多 5 条。`;
  const { text, usage, model } = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, maxTokens: 3000, project, stageId: 'ux' });
  const out = parseJSON(text, `UX screen ${scr.id}`);
  const fields = (a, fb) => (Array.isArray(a) && a.length ? a : fb).slice(0, 40).map(f => ({ label: String(f.label || '').slice(0, 24), type: ['text', 'number', 'date', 'check'].includes(f.type) ? f.type : 'text', len: Number(f.len) || null, note: String(f.note || '').slice(0, 60) })).filter(f => f.label);
  return {
    search: fields(out.search, base.search), columns: fields(out.columns, base.columns), detail: fields(out.detail, base.detail),
    rows: Number(out.rows) || 8, message: String(out.message || '').slice(0, 60),
    notes: (Array.isArray(out.notes) ? out.notes : []).slice(0, 5).map(n => String(n).slice(0, 80)), usage, model,
  };
}
