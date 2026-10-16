/* ============================================================
   app.js — 单页应用：视图 / 门禁操作 / SSE 实时刷新
   ============================================================ */
import { treeRows, sourceFiles } from './tree.mjs';
import { progressOf, stageExecution } from './progress.mjs';
import { t, setLang, applyStatic, LANGS, lang, audit, has } from './i18n.mjs';

let DB = { projects: [], active: null };
const S = { view: 'projects', project: null, stage: null, module: null, artifact: null, artTab: 'artifacts', wbsTab: 'tree', epicOpen: {}, wsOpen: {}, reject: null, editArt: null, editFile: null, skillEdit: null, form: { mode: 'human_gate' } };
let WS = { projectId: null, files: [], path: null, content: '', loading: false, modCount: -1, at: 0 };
/** 模块已落盘的文件总数：工作区列表的缓存失效依据（模块完成会变，文件系统被外部改动不会变）。 */
const modFileCount = (p) => (p?.modules || []).reduce((n, m) => n + (m.files || []).length, 0);
/** 缓存是否过期：换了项目 / 模块文件数变了 / 上次加载卡住超过 5 秒（否则「工作区里后来才有文件」会一直显示空列表）。 */
const wsStale = (p) => !p || WS.projectId !== p.id || WS.modCount !== modFileCount(p) || (WS.loading && Date.now() - WS.at > 5000);
let DRAFT = { key: null, text: '' };   // 编辑中的草稿（SSE 重渲染时不丢字）
let PICKS = [];                        // 新建项目时选中的上传文件（File 对象，重渲染不丢）
let EPICKS = [];                       // 编辑项目时补的输入资料（同 PICKS，两个表单互不干扰）
let SKDRAFT = { name: '', body: '', stage: '' };   // 技能表单草稿：SSE 重渲染时不丢用户正在输的字
let SKPICK = new Set();                            // 技能列表里勾选待批量删除的（按 id，重渲染不丢）
let PEDIT = null;                                  // 正在编辑的项目信息（右侧那一栏变成「编辑项目」表单；SSE 重渲染不丢）
let NPTYPE = null, NPWF = null;                    // 新建表单里用户选的分类/流程（SSE 重渲染不丢，提交后清空）
let CATALOG = null, catalogLoading = false;        // 预设技能库（skills/*.md），进技能页时拉一次
const LS = 'aids.';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => (iso || '').replace('T', ' ').slice(0, 19);

const STS = { pending: { get t() { return t('st.pending'); }, c: 'bare' }, running: { get t() { return t('st.running'); }, c: 'run' }, awaiting_review: { get t() { return t('st.awaiting'); }, c: 'warn' }, approved: { get t() { return t('st.approved'); }, c: 'ok' }, rejected: { get t() { return t('st.rejected'); }, c: 'fail' }, failed: { get t() { return t('st.failed'); }, c: 'fail' } };
const MSTS = { pending: { get t() { return t('st.awaiting_dev'); }, c: 'bare' }, running: { get t() { return t('st.developing'); }, c: 'run' }, awaiting_review: { get t() { return t('st.awaiting_appr'); }, c: 'warn' }, approved: { get t() { return t('st.approved'); }, c: 'ok' }, rejected: { get t() { return t('st.rejected'); }, c: 'fail' }, failed: { get t() { return t('st.failed'); }, c: 'fail' } };
const FLOWSTATE = { approved: 'delivered', running: 'running', awaiting_review: 'review', rejected: 'rejected', failed: 'rejected', pending: 'pending' };
// 分类值保持稳定（会发给服务端并存库），只有显示文案跟着语言走
const REJECT_CATS = [['requirement', 'cat.requirement'], ['architecture', 'cat.arch'], ['ux', 'cat.ux'], ['technical', 'cat.tech'], ['security', 'cat.security'], ['business', 'cat.business']];
// 各阶段可选的调用模型；选「缺省」= 不定义，服务端用 deepseek（AI_PLATFORM_MODEL 可改）。要别的模型直接调 POST /api/projects/:id/models
const MODEL_OPTS = ['deepseek-v4-flash', 'deepseek-reasoner'];          // 兜底：settings 还没拉到时显示这两个老默认
let ENABLED_MODELS = [];                              // [{providerId, providerName, model}] —— 来自 /api/settings/enabled-models
let SETTINGS_CACHE = null;                            // 全量 provider 列表（settings 视图渲染用）
const SETTINGS_DRAFT = {};                            // providerId → 表单草稿（SSE 重渲染时不被服务端返回覆盖）
/** 写入 p.models[stageId] 和下拉框 value 都用这个 "providerId/modelName" 形式。 */
const modelKey = (m) => `${m.providerId}/${m.model}`;
/** 取一个 provider 的本地"输入态"——草稿、SSE 重渲染都不丢。 */
const settingsDraft = (id) => (SETTINGS_DRAFT[id] = SETTINGS_DRAFT[id] || {});

const P = () => DB.projects.find(p => p.id === S.project) || null;
const pill = (status, map) => { const s = (map || STS)[status] || { t: status, c: 'bare' }; return `<span class="pill ${s.c}">${s.t}</span>`; };

const PROGRESS_PHASES = {
  started: 'starting', preparing: 'preparing', planned: 'planned',
  'generating code': 'code', 'files written': 'written', 'running tests': 'tests',
  'generating artifacts': 'artifacts', 'generating WBS': 'wbs', verifying: 'verifying',
};
function executionBar(item, label, compact = false) {
  const percent = progressOf(item);
  let phase = item.progress_label === 'modules'
    ? t('progress.modules', { done: item.completed, total: item.total })
    : t(`progress.${PROGRESS_PHASES[item.progress_label] || 'starting'}`);
  if (item.status === 'pending' || item.status === 'rejected') phase = t('st.pending');
  else if (item.status === 'approved') phase = t('st.approved');
  else if (item.status === 'awaiting_review') phase = t('progress.review');
  else if (item.status === 'failed') phase = item.progress_label && item.progress_label !== 'failed'
    ? t('progress.stopped', { step: phase }) : t('st.failed');
  else if (item.status === 'running' && DB.channel?.channel === 'live' && ['generating code', 'generating artifacts', 'generating WBS'].includes(item.progress_label)) phase += ` · ${t('progress.waiting')}`;
  return `<div class="execution-progress${compact ? ' compact' : ''}" data-status="${esc(item.status)}" title="${esc(label)} · ${esc(phase)}">
    <div class="progress-heading"><span>${esc(label)}</span><strong>${percent}%</strong></div>
    <div class="execution-track" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${percent}% · ${esc(phase)}"><i style="width:${percent}%"></i></div>
    ${compact ? '' : `<div class="progress-phase">${esc(phase)}</div>`}
  </div>`;
}

function renderLiveProgress() {
  const p = P();
  const stage = p && (p.stages.find(s => s.status === 'running') || summary(p).cur || p.stages.at(-1));
  document.getElementById('liveProgress').innerHTML = stage
    ? executionBar(stageExecution(p, stage), stageLabel(stage)) : '';
}

/** 产物编号里的数字（REQ-01 → 1；WBS 这种没编号的 → -1，排在本阶段最前）。 */
const artNum = (id) => { const m = String(id || '').match(/\d+/); return m ? Number(m[0]) : -1; };

/** 阶段名跟着界面语言走：服务端只存中文名，界面按阶段 id 查 i18n，缺键就回落原名。 */
const stageLabelById = (id, fallback) => (id && has(`stage.${id}`) ? t(`stage.${id}`) : (fallback || id || '—'));
const stageLabel = (s) => (s ? stageLabelById(s.id, s.name) : '—');
/** 阶段序号（跟流水线一致：01..08），用于标题/归属这类「流程名」出现的地方。 */
const stageNo = (p, id) => { const i = (p?.stages || []).findIndex(s => s.id === id); return i < 0 ? '' : String(i + 1).padStart(2, '0'); };
/** 「01 需求分析」——名字跟着语言走，序号跟着流水线顺序。 */
const stageLabelN = (p, s) => { const n = stageNo(p, s && s.id); return (n ? `${n} ` : '') + stageLabel(s); };
/** 产物归谁：模块产物显示模块名（项目数据，不翻译），阶段产物显示「序号 + 翻译后的阶段名」。 */
const artOwnerLabel = (p, a) => (a.module ? a.stageName : stageLabelN(p, { id: a.stage, name: a.stageName }));
/** 工作流名：优先词条（三语），没有就用服务端给的名字（跟阶段名同一套口径：服务端只存中文）。 */
const wfName = (id) => (has(`wf.${id}`) ? t(`wf.${id}`) : ((DB.workflows || []).find(w => w.id === id)?.name || id));
const wfChip = (p) => `<span class="pill" title="${esc(wfHintOf(p && p.workflow))}">${esc(wfName(p && p.workflow))} · ${p ? p.stages.length : 0}</span>`;
const wfHintOf = (id) => { const w = (DB.workflows || []).find(x => x.id === id); return w ? `${w.name}：${w.stages.map(s => stageLabelById(s, s)).join(' → ')}` : ''; };
/** 项目类型（决定默认流程）：名字/说明/流程文本都来自后端 /api/state 的 types。 */
const typeMeta = (id) => (DB.types || []).find(y => y.id === id) || {};
const typeName = (id) => (has(`type.${id}`) ? t(`type.${id}`) : (typeMeta(id).name || id || ''));
const typeFlowText = (id) => { const w = (DB.workflows || []).find(x => x.id === typeMeta(id).workflow); return w ? w.stages.map(s => stageLabelById(s, s)).join(' → ') : ''; };
const typeTechs = (id) => (typeMeta(id).techs || []).filter(Boolean);
/** 工作流说明：通用解释 + 当前这条流程的阶段序列（放在下拉框下面那行，会换行）。 */
const wfFlowText = (id) => { const w = (DB.workflows || []).find(x => x.id === id); if (!w) return t('proj.workflow.hint'); return `${t('proj.workflow.hint')} · ${t('proj.type.flow')}：${w.stages.map(s => stageLabelById(s, s)).join(' → ')}`; };
const modeDesc = (v) => (v === 'auto' ? t('proj.mode.auto') : t('proj.mode.human'));
/** 分类自带的配置包说明：技能条数 + 目录规约（层清单）。 */
const typePackText = (id) => { const m = typeMeta(id); return t('proj.type.pack', { n: (m.skills || []).length, dirs: (m.layers || []).join(' / ') }); };
/** 产物名显示规约：「序号-流程点名-生成的名字」（序号/流程点名跟着流水线与语言走）。 */
const artFullName = (p, a) => { const n = stageNo(p, a.stage); return `${n ? `${n}-` : ''}${stageLabelById(a.stage, a.stageName)}-${a.name}`; };
/** 技能列表排序用：空阶段（所有阶段）排最前，其余按流水线顺序。 */
const skillStageOrder = (p, stageId) => (stageId ? (p?.stages || []).findIndex(s => s.id === stageId) + 1 || 99 : 0);

function allArtifacts(p) {
  const out = [];
  p.stages.forEach(s => (s.artifacts || []).forEach(a => out.push({ ...a, stage: s.id, stageName: s.name })));
  p.modules.forEach(m => (m.artifacts || []).forEach(a => out.push({ ...a, stage: 'development', stageName: m.name, module: m.id })));
  if (p.wbs.epics.length) out.push({ id: 'WBS', name: 'WBS Breakdown', type: 'wbs', stage: 'wbs', stageName: 'WBS 分解', status: 'generated' });
  // 按「阶段顺序 → 编号数字」排（sort 稳定，同阶段同编号保持生成顺序：REQ → US → AC）；模块产物也回到开发阶段的位置上
  const order = new Map((p.stages || []).map((s, i) => [s.id, i]));
  return out.sort((a, b) =>
    (order.get(a.stage) ?? 99) - (order.get(b.stage) ?? 99) ||
    artNum(a.id) - artNum(b.id));
}
/** 产物归谁（阶段或模块）——用来判断是否已批准锁定。 */
function artifactOwner(p, a) {
  return p.stages.find(s => (s.artifacts || []).some(x => x.id === a.id))
    || p.modules.find(m => (m.artifacts || []).some(x => x.id === a.id)) || null;
}
/** 工作区文件 → 归属模块：生成记录里精确匹配 → 该文件所在层目录里只有这一个模块。
    （文件名用业务语义、不带 WBS 序号，所以不靠名字里的模块号认领。） */
function moduleOfFile(p, rel) {
  for (const m of p.modules) if ((m.files || []).some(f => f.path === rel)) return m;
  const dir = String(rel || '').split('/').slice(0, -1).join('/');
  const cands = p.modules.filter(m => m.dir === dir);
  return cands.length === 1 ? cands[0] : null;
}
function summary(p) {
  const done = p.stages.filter(s => s.status === 'approved').length;
  const cur = p.stages.find(s => s.status !== 'approved') || null;
  return {
    done, total: p.stages.length, cur,
    progress: p.stages.length ? done / p.stages.length : 0,
    epics: p.wbs.epics.length, tasks: p.wbs.task_count,
    modTotal: p.modules.length, modDone: p.modules.filter(m => m.status === 'approved').length,
    unit: p.modules.reduce((a, m) => a + (m.unit_tests?.total || 0), 0),
  };
}
function md(src) {
  let out = '', code = false;
  for (const ln of String(src || '').split('\n')) {
    if (ln.trim().startsWith('```')) { out += code ? '</pre>' : '<pre class="log">'; code = !code; continue; }
    if (code) { out += esc(ln) + '\n'; continue; }
    if (/^#{1,3} /.test(ln)) out += `<h3>${esc(ln.replace(/^#{1,3}\s/, ''))}</h3>`;
    else if (/^\|/.test(ln)) out += `<div class="mono tiny">${esc(ln)}</div>`;
    else if (/^\s*[-*] /.test(ln)) out += `<div>· ${esc(ln.replace(/^\s*[-*] /, ''))}</div>`;
    else if (ln.trim() === '') out += '<div style="height:6px"></div>';
    else out += `<div>${esc(ln)}</div>`;
  }
  return out + (code ? '</pre>' : '');
}

/* ---------- 左树右码：产物页签与「源码」模块共用同一套渲染 ---------- */

/** 左侧目录树 + 右侧预览/编辑。返回各块 HTML，调用方自己拼页面。 */
function codeBrowser(p, files, opts = {}) {
  const rows = treeRows(files.map(f => f.path), S.wsOpen);
  const sizeOf = Object.fromEntries(files.map(f => [f.path, f.bytes]));
  const left = rows.map(r => r.kind === 'dir'
    ? `<div class="trow dir" data-dir="${esc(r.path)}" style="padding-left:${8 + r.depth * 14}px">
         <span class="tri">${r.open ? '▾' : '▸'}</span><span class="nm">${esc(r.name)}</span><span class="num">${r.count}</span></div>`
    : `<div class="trow file ${r.path === WS.path ? 'sel' : ''}" data-file="${esc(r.path)}" style="padding-left:${8 + r.depth * 14}px">
         <span class="tri"></span><span class="nm mono">${esc(r.name)}</span><span class="num">${((sizeOf[r.path] || 0) / 1024).toFixed(1)}K</span></div>`
  ).join('') || `<div class="empty tiny">${opts.empty || t('code.emptyWs')}${WS.loading ? t('msg.loading') : ''}</div>`;

  const fmod = WS.path ? moduleOfFile(p, WS.path) : null;
  const fLocked = fmod && fmod.status === 'approved';
  let mid, acts = '';
  if (WS.path && S.editFile === WS.path) {
    mid = `<textarea class="field" data-edit-area style="min-height:52vh;font:400 12px/1.6 var(--font-mono)">${esc(DRAFT.key === 'file:' + WS.path ? DRAFT.text : WS.content)}</textarea>`;
    acts = `<button class="btn primary" data-save-file="${esc(WS.path)}">${esc(t('act.saveFile'))}</button><button class="btn" data-cancel-edit>${esc(t('act.cancel'))}</button>`;
  } else {
    mid = WS.content ? `<pre class="log">${esc(WS.content)}</pre>` : '';    // 没文件/没选中 → 内容区留空（提示只放左侧列表）
    if (WS.path) acts = fLocked
      ? `<span class="pill v2">${esc(t('gate.lockedModule'))}</span>`
      : `<button class="btn warn" data-edit-file="${esc(WS.path)}">${esc(t('act.edit'))}</button>`;
  }
  const foot = `<div class="foot">${esc(t('code.realFs', { n: files.length }))}${fmod ? esc(t('code.ownerNote', { id: fmod.id })) + (fLocked ? '' : esc(t('code.rerunNote'))) : ''}</div>`;
  return { left, mid, acts, foot, fmod, title: WS.path || opts.untitled || t('art.tab.files') };
}

/* 三栏骨架：左树 / 中预览编辑 / 右元数据（产物页与「源码」模块共用） */
function codeGrid(pane, { leftTitle = null, leftKicker = '', meta = '', wideLeft = false } = {}) {
  return `<div class="grid g-tree${wideLeft ? ' g-wideleft' : ''}">
        <div class="card"><header><h2>${esc(leftTitle || t('art.files'))}</h2><span class="kicker">${leftKicker}</span></header><div class="body flush tablewrap">${pane.left}</div></div>
        <div class="card"><header><h2>${esc(pane.title)}</h2><span class="kicker mono">${esc(pane.kicker || '')}</span><span class="right" style="display:flex;gap:8px;align-items:center">${pane.acts || ''}</span></header>
          <div class="body">${pane.mid}</div>${pane.foot || ''}
        </div>
        <div class="card"><header><h2>${esc(t('code.meta'))}</h2><span class="kicker">Meta</span></header><div class="body">${meta}</div></div>
      </div>`;
}

/* ============================ 视图 ============================ */

const VIEWS = {

  projects: { name: 'Projects', render() {
    const npType = NPTYPE || (DB.types || [])[0]?.id || '';
    const npWf = NPWF || typeMeta(npType).workflow || '';
    const editCard = PEDIT ? `                    <!-- 编辑项目：占右侧那一栏，字段与「新建项目」一致；分类/工作流只在没批准过阶段时可改 -->
        <div class="card">
          <header><h2>${esc(t('proj.edit.title'))}</h2><span class="kicker">${esc(PEDIT.id)}</span><span class="right"></span></header>
          <form class="body insp" id="editProject" data-id="${esc(PEDIT.id)}">
            <div><label class="lb">${esc(t('proj.name'))}</label><input class="field" name="name" value="${esc(PEDIT.name)}" required></div>
            <div><label class="lb">${esc(t('proj.brief'))}</label><textarea class="field" name="brief">${esc(PEDIT.brief)}</textarea></div>
            <div><label class="lb">${esc(t('proj.type'))}</label>
              <select class="field" name="type" id="editTypeSel">
                ${(DB.types || []).map(y => `<option value="${esc(y.id)}"${y.id === PEDIT.type ? ' selected' : ''}>${esc(typeName(y.id))}</option>`).join('')}
              </select>
              <div class="hint" id="editTypeHint">${esc(typeMeta(PEDIT.type).hint || '')} · ${esc(t('proj.type.flow'))}：${esc(typeFlowText(PEDIT.type))} · ${esc(typePackText(PEDIT.type))}</div>
            </div>
            <div><label class="lb">${esc(t('proj.tech'))}</label>
              <input class="field" name="tech" list="editTechSug" value="${esc(PEDIT.tech)}">
              <datalist id="editTechSug">${typeTechs(PEDIT.type).map(x => `<option value="${esc(x)}"></option>`).join('')}</datalist>
              <div class="hint">${esc(t('proj.tech.sug'))}</div>
            </div>
            <div><label class="lb">${esc(t('proj.workflow'))}</label>
              <select class="field" name="workflow">
                ${(DB.workflows || []).map(w => `<option value="${esc(w.id)}"${w.id === PEDIT.workflow ? ' selected' : ''}>${esc(wfName(w.id))}</option>`).join('')}
              </select>
              <div class="hint big" id="editWfHint">${esc(wfFlowText(PEDIT.workflow))}</div>
              <div class="hint">${esc(t('proj.edit.flowHint'))}</div>
            </div>
            <div><label class="lb">${esc(t('proj.mode'))}</label>
              <select class="field" name="mode" id="editModeSel">
                <option value="human_gate"${PEDIT.mode === 'auto' ? '' : ' selected'}>${esc(t('proj.mode.humanShort'))}</option>
                <option value="auto"${PEDIT.mode === 'auto' ? ' selected' : ''}>${esc(t('proj.mode.autoShort'))}</option>
              </select>
              <div class="hint big" id="editModeHint">${esc(PEDIT.mode === 'auto' ? t('proj.mode.auto') : t('proj.mode.human'))}</div>
            </div>
            <div>
              <label class="lb">${esc(t('proj.inputs'))}</label>
              <input class="field" type="file" name="files" multiple
                     accept=".md,.txt,.json,.yaml,.yml,.csv,.mjs,.js,.cjs,.ts,.html,.css,.sql,.xml,.rst,.adoc">
              <div class="hint">${esc(t('proj.inputs.hint'))}</div>
              ${EPICKS.length ? `<div class="steps-mini" style="margin-top:8px">
                ${EPICKS.map(f => `<div class="s"><span class="mono tiny">${esc(f.name)}</span><span class="tiny muted">${(f.size / 1024).toFixed(1)} KB</span><span></span></div>`).join('')}
              </div>
              <button type="button" class="btn" data-clear-epicks style="margin-top:6px">${esc(t('act.clearPicks'))}（${EPICKS.length}）</button>` : ''}
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <button class="btn primary" type="submit">${esc(t('act.save'))}</button>
              <button class="btn" type="button" data-cancel-edit>${esc(t('act.cancel'))}</button>
            </div>
            <div class="hint">${esc(t('proj.edit.note'))}</div>
          </form>
        </div>` : '';
    const cards = DB.projects.map(p => {
      const s = summary(p);
      const body = `
        <div class="pname" title="${esc(p.brief || '')}">${esc(p.name)}</div>
        <div class="progress"><i class="${s.done === s.total ? 'ok' : 'acc'}" style="width:${Math.round(s.progress * 100)}%"></i></div>
        <div class="mono tiny muted" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.type ? `${esc(typeName(p.type))} · ` : ''}<span class="pid">${esc(p.id)} · </span>${esc(t('proj.stats', { done: s.done, total: s.total, md: s.modDone, mt: s.modTotal, unit: s.unit, cur: s.cur ? `${stageLabelN(p, s.cur)}（${STS[s.cur.status].t}）` : t('st.allDone') }))}${p.inputs?.length ? ` · ${esc(t('proj.inputsBadge', { n: p.inputs.length }))}` : ''}</div>`;
      return `<div class="proj-card ${p.id === S.project ? 'sel' : ''}" data-project="${p.id}">
        <div class="head">
          ${modeBlock(p)}
          ${wfChip(p)}
        </div>
        ${body}
        <div class="card-acts">
          <button class="btn" type="button" data-edit-project="${esc(p.id)}">${esc(t('act.edit'))}</button>
          <button class="btn warn" data-rebuild-project="${esc(p.id)}" title="${esc(t('proj.rebuild.title'))}">${esc(t('act.rebuild'))}</button>
          <button class="btn danger" data-del-project="${esc(p.id)}" title="${esc(t('proj.del.title'))}">${esc(t('act.delete'))}</button>
        </div>
      </div>`;
    }).join('') || `<div class="empty"><h2>${esc(t('proj.empty.title'))}</h2><div class="tiny">${esc(t('proj.empty.desc'))}</div></div>`;

    return `
      <div class="page-head">
        <div>${viewTitle('projects', esc(t('view.projects')))}<p>${esc(t('view.projects.desc'))}</p></div>
      </div>
      <div class="grid g-side g-fill">
        <div class="card">
          <header><h2>${esc(t('proj.list'))}</h2><span class="kicker">${esc(t('proj.listCount', { n: DB.projects.length }))}</span><span class="right"></span></header>
          <div class="body"><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">${cards}</div></div>
        </div>
        ${PEDIT ? editCard : `<div class="card">
          <header><h2>${esc(t('proj.create'))}</h2><span class="kicker">Start</span></header>
          <form class="body insp" id="newProject">
            <div><label class="lb">${esc(t('proj.name'))}</label><input class="field" name="name" placeholder="${esc(t('proj.name.ph'))}" required></div>
            <div><label class="lb">${esc(t('proj.brief'))}</label><textarea class="field" name="brief" placeholder="${esc(t('proj.brief.ph'))}"></textarea></div>
            <div><label class="lb">${esc(t('proj.type'))}</label>
              <select class="field" name="type" id="typeSel">
                ${(DB.types || []).map(y => `<option value="${esc(y.id)}"${y.id === npType ? ' selected' : ''}>${esc(typeName(y.id))}</option>`).join('')}
              </select>
              <div class="hint" id="typeHint">${esc(t('proj.type.hint'))}${typeFlowText(npType) ? ` · ${esc(t('proj.type.flow'))}：${esc(typeFlowText(npType))}` : ''} · ${esc(typePackText(npType))}</div>
            </div>
            <div><label class="lb">${esc(t('proj.tech'))}</label>
              <input class="field" name="tech" list="techSug" placeholder="${esc(typeTechs(npType)[0] || t('proj.tech.ph'))}">
              <datalist id="techSug">${typeTechs(npType).map(x => `<option value="${esc(x)}"></option>`).join('')}</datalist>
              <div class="hint" id="techHint">${esc(t('proj.tech.sug'))}</div>
            </div>
            <div><label class="lb">${esc(t('proj.workflow'))}</label>
              <select class="field" name="workflow">
                ${(DB.workflows || []).map(w => `<option value="${esc(w.id)}"${w.id === npWf ? ' selected' : ''}>${esc(wfName(w.id))}</option>`).join('')}
              </select>
              <div class="hint big" id="wfHint">${esc(wfFlowText(npWf))}</div>
            </div>
            <div><label class="lb">${esc(t('proj.mode'))}</label>
              <select class="field" name="mode" id="modeSel">
                <option value="human_gate">${esc(t('proj.mode.humanShort'))}</option>
                <option value="auto">${esc(t('proj.mode.autoShort'))}</option>
              </select>
              <div class="hint big" id="modeHint">${esc(t('proj.mode.human'))}</div>
            </div>
            <div>
              <label class="lb">${esc(t('proj.inputs'))}</label>
              <input class="field" type="file" name="files" multiple
                     accept=".md,.txt,.json,.yaml,.yml,.csv,.mjs,.js,.cjs,.ts,.html,.css,.sql,.xml,.rst,.adoc">
              <div class="hint">${esc(t('proj.inputs.hint'))}</div>
              ${PICKS.length ? `<div class="steps-mini" style="margin-top:8px">
                ${PICKS.map(f => `<div class="s"><span class="mono tiny">${esc(f.name)}</span><span class="tiny muted">${(f.size / 1024).toFixed(1)} KB</span><span></span></div>`).join('')}
              </div>
              <button type="button" class="btn" data-clear-picks style="margin-top:6px">${esc(t('act.clearPicks'))}（${PICKS.length}）</button>` : ''}
            </div>
            <button class="btn primary" type="submit" style="padding:9px 12px">${esc(t('act.create'))}</button>
            <div class="hint">${esc(t('proj.inputs.hint2'))}</div>
          </form>
        </div>`}
      </div>`;
  }},

  overview: { name: 'Overview', render() {
    const p = P(); if (!p) return noProject();
    const s = summary(p);
    const recent = p.events.slice(-60).reverse();     // 卡片有滚动条，给够条目让活动流真正填满高度
    const kpi = (k, v, d, cls = '') => `<div class="kpi ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
    return `
      <div class="page-head">
        <div>${viewTitle('overview', esc(p.name))}<p>${esc(p.brief || t('proj.noBrief'))} · ${esc(t('ov.techStack', { v: p.arch?.stack || p.tech || t('ov.techUnset') }))}${p.inputs?.length ? ` · ${esc(t('ov.inputs', { n: p.inputs.length, names: p.inputs.map(i => i.name).join('、') }))}` : ''}</p></div>
        <div class="tools"><span class="pill ${p.mode === 'auto' ? 'run' : 'acc'}">${p.mode === 'auto' ? esc(t('proj.mode.autoShort')) : esc(t('proj.mode.humanShort'))}</span>${wfChip(p)}</div>
      </div>
      <div class="kpis">
        ${kpi(esc(t('kpi.stage')), `${s.done}<small>/${s.total}</small>`, esc(t('kpi.stage.d', { cur: s.cur ? stageLabelN(p, s.cur) : t('st.allDone') })), 'acc')}
        ${kpi('Epic / Task', `${s.epics}<small>/${s.tasks}</small>`, esc(t('kpi.epicTask.d')))}
        ${kpi(esc(t('kpi.devMod')), `${s.modDone}<small>/${s.modTotal}</small>`, esc(t('kpi.devMod.d')), 'run')}
        ${kpi(esc(t('kpi.unit')), `${s.unit}`, esc(t('kpi.unit.d')), 'ok')}
        ${kpi(esc(t('kpi.pct')), `${Math.round(s.progress * 100)}<small>%</small>`, esc(t('kpi.pct.d')))}
      </div>
      <div class="grid g-2-1 g-fill">
        <div class="card">
          <header><h2>${esc(t('ov.pipeline'))}</h2><span class="kicker">Flow</span><span class="right"><button class="btn" data-goflow>${esc(t('ov.gotoFlow'))}</button></span></header>
          <div class="body">${pipe(p)}<div class="hr"></div>${gatePanel(p)}</div>
        </div>
        <div class="card">
          <header><h2>${esc(t('ov.activity'))}</h2><span class="kicker">Live</span></header>
          <div class="body flush tablewrap"><div class="tl" style="padding:14px 14px 14px 36px">
            ${recent.map(e => `<div class="tl-item ${tlClass(e.kind)}"><div class="ts mono">${fmtTime(e.ts)}</div><div class="dd">${esc(e.text)}</div></div>`).join('') || `<div class="muted tiny">${esc(t('ov.noEvents'))}</div>`}
          </div></div>
        </div>
      </div>`;
  }},

  flow: { name: 'Pipeline & Gates', render() {
    const p = P(); if (!p) return noProject();
    const sel = p.stages.find(s => s.id === S.stage) || p.stages.find(s => s.status !== 'approved') || p.stages[0];
    S.stage = sel.id;
    const arts = (sel.artifacts || []).map(a => `<div class="row" data-artifact="${esc(a.id)}"><span class="id mono">${esc(a.id)}</span><span class="nm">${esc(a.name)}</span><span class="stat">${pill(a.status === 'approved' ? 'approved' : 'pending', { approved: { t: 'approved', c: 'ok' }, pending: { t: 'generated', c: 'run' } })}</span></div>`).join('') || `<div class="muted tiny" style="padding:10px 14px">${esc(t('com.empty'))}</div>`;
    const hist = (sel.review && sel.review.decision === 'rejected') ? `<div class="gate" style="margin-top:8px"><div class="gt">${esc(t('gate.rejectTitle'))}</div><div class="gd">〔${esc(sel.review.category)}〕${esc(sel.review.comment || '—')} · ${fmtTime(sel.review.at)}</div></div>` : '';
    return `
      <div class="page-head">
        <div>${viewTitle('flow', esc(t('view.flow')))}<p>${esc(t('view.flow.desc'))}</p></div>
      </div>
      <div class="card"><div class="body">${pipe(p)}<div class="hr"></div>
        <div class="flow-legend">
          <span><i style="background:var(--ok)"></i>${esc(t('gate.legend.approved'))}</span>
          <span><i style="background:var(--accent)"></i>${esc(t('gate.legend.current'))}</span>
          <span><i style="background:var(--run)"></i>${esc(t('gate.legend.running'))}</span>
          <span><i style="background:var(--warn)"></i>${esc(t('gate.legend.awaiting'))}</span>
          <span><i style="background:var(--fail)"></i>${esc(t('gate.legend.rejected'))}</span>
          <span><i style="background:var(--line-2)"></i>${esc(t('gate.legend.pending'))}</span>
        </div>
      </div></div>
      <div class="grid g-1-2${sel.kind === 'development' ? '' : ' g-fill'}">
        <div class="card">
          <header><h2>${esc(stageLabelN(p, sel))}</h2><span class="kicker">${esc(sel.agent)}</span><span class="right">${pill(sel.status)}</span></header>
          <div class="body insp">
            ${executionBar(stageExecution(p, sel), t('progress.execution'))}
            <div class="kv">
              <div class="k">${esc(t('stage.detail'))}</div><div class="v mono">${esc(sel.id)}</div>
              <div class="k">${esc(t('art.meta.type'))}</div><div class="v">${esc(sel.kind === 'development' ? t('art.kind.dev') : sel.kind === 'wbs' ? t('art.kind.wbs') : t('art.kind.doc'))}</div>
              <div class="k">${esc(t('stage.attempts'))}</div><div class="v mono">${esc(t('stage.attempts.n', { n: sel.attempts }))}</div>
              <div class="k">${esc(t('stage.started'))}</div><div class="v mono">${sel.started_at ? fmtTime(sel.started_at) : '—'}</div>
              <div class="k">${esc(t('stage.finished'))}</div><div class="v mono">${sel.finished_at ? fmtTime(sel.finished_at) : '—'}</div>
              <div class="k">${esc(t('stage.model'))}</div><div class="v">${modelSelect(p, sel.id)}</div>
            </div>
            ${hist}
            ${gatePanel(p, sel)}
          </div>
        </div>
        <div class="card">
          <header><h2>${esc(t('stage.artifacts'))}</h2><span class="kicker">Artifacts</span><span class="right mono tiny muted">${esc(t('stage.artifactCount', { n: (sel.artifacts || []).length }))}</span></header>
          <div class="body flush">${arts}</div>
          ${gatePanel(p, sel, true)}
        </div>
      </div>
      ${sel.kind === 'development' ? devSection(p) : ''}`;
  }},

  skills: { name: 'Skills', render() {
    const p = P(); if (!p) return noProject();
    const list = [...(p.skills || [])].sort((a, b) =>        // 按流程序号排：所有阶段（空）= 最前，其余按阶段顺序 → 编号
      skillStageOrder(p, a.stage) - skillStageOrder(p, b.stage) || artNum(a.id) - artNum(b.id));
    SKPICK = new Set([...SKPICK].filter(id => list.some(s => s.id === id)));   // 换项目/删完之后自动清掉不存在的勾选
    const ed = S.skillEdit ? list.find(s => s.id === S.skillEdit) : null;
    // 技能行/表单里的「适用阶段」：空 = 所有阶段；id 已知就按界面语言显示阶段名
    const skillStageLabel = (id) => (id ? stageLabelById(id, (DB.stages || []).find(s => s.id === id)?.name) : t('sk.stage.all'));
    /** 列表里显示的「流程节点」：流程序号 + 流程名称（各自独立着色）。 */
    const skillStageText = (id) => (id
      ? `<span class="no">${esc(stageNo(p, id))}</span> <span class="sn">${esc(skillStageLabel(id))}</span>`
      : `<span class="sn">${esc(skillStageLabel(id))}</span>`);
    const rows = list.map(s => `
      <div class="row" data-skill="${esc(s.id)}" title="${esc(s.body)}">
        <span class="right" style="flex:0 0 auto"><input type="checkbox" data-skill-pick="${esc(s.id)}" ${SKPICK.has(s.id) ? 'checked' : ''} title="${esc(t('sk.pick'))}"></span>
        <span class="id mono">${esc(s.id)}</span>
        <span class="nmcol"><span class="nm">${esc(s.name)}</span><span class="stat" data-skill-stage="${esc(s.stage || '')}">${skillStageText(s.stage)}</span></span>
        <span class="right" style="display:flex;gap:6px">
          <button class="btn warn" data-skill-edit="${esc(s.id)}">${esc(t('act.edit'))}</button>
          <button class="btn danger" data-skill-del="${esc(s.id)}">✕ ${esc(t('sk.del'))}</button>
        </span>
      </div>`).join('')
      || `<div class="empty tiny">${esc(t('sk.empty'))}<br><br>${esc(t('sk.emptyHint'))}</div>`;
    const stageOpts = [['', t('sk.stage.all')], ...(DB.stages || []).map(s => [s.id, stageLabel(s)])]
      .map(([v, n]) => `<option value="${esc(v)}"${SKDRAFT.stage === v ? ' selected' : ''}>${esc(n)}</option>`).join('');
    const cat = CATALOG || [];
    const STAGES_LIST = DB.stages || [];
    return `
      <div class="page-head">
        <div>${viewTitle('skills', esc(t('view.skills')))}<p>${esc(t('view.skills.desc'))}</p></div>
      </div>
      <div class="grid g-side g-fill g-skills">
        <div class="card">
          <header><h2>${esc(t('sk.list'))}</h2><span class="kicker">${esc(t('sk.count', { n: list.length }))}</span>
            <span class="right" style="display:flex;gap:8px;align-items:center">
              <button class="btn" data-skill-all ${list.length ? '' : 'disabled'}>${esc(SKPICK.size === list.length && list.length ? t('sk.pickNone') : t('sk.pickAll'))}</button>
              <button class="btn danger" data-skill-bulk-del ${SKPICK.size ? '' : 'disabled'}>✕ ${esc(t('sk.delSel', { n: SKPICK.size }))}</button>
            </span>
          </header>
          <div class="body flush">${rows}</div>
          <div class="foot">${esc(t('skill.footNote'))}</div>
        </div>
        <div class="card">
          <header><h2>${ed ? esc(t('sk.editTitle')) : esc(t('sk.add'))}</h2><span class="kicker mono">${ed ? esc(ed.id) : 'New'}</span></header>
          <form class="body insp" id="skillForm" data-skill-id="${ed ? esc(ed.id) : ''}">
            <div><label class="lb">${esc(t('sk.name'))}</label><input class="field" name="name" required maxlength="60" value="${esc(SKDRAFT.name)}" placeholder="${esc(t('sk.name.ph'))}"></div>
            <div><label class="lb">${esc(t('sk.stage'))}</label><select class="field" name="stage">${stageOpts}</select></div>
            <div><label class="lb">${esc(t('sk.body'))}</label><textarea class="field" name="body" required style="min-height:200px" placeholder="${esc(t('sk.body.ph'))}">${esc(SKDRAFT.body)}</textarea></div>
            <div style="display:flex;gap:8px;align-items:center;flex:0 0 auto">
              <button class="btn primary" type="submit">${esc(t('sk.save'))}</button>
              ${ed ? `<button type="button" class="btn" data-skill-cancel>${esc(t('act.cancel'))}</button>` : ''}
            </div>
            ${ed ? `<div class="hint">${esc(t('sk.editing', { id: ed.id }))}</div>` : ''}
            <div class="hr"></div>
            <div>
              <label class="lb">${esc(t('sk.cat'))}</label>
              <select class="field" id="presetSel">
                <optgroup label="${esc(t('sk.cat.byRange'))}">
                  <option value="all">${esc(t('sk.cat.all', { n: cat.length }))}</option>
                  <option value="stage">${esc(t('sk.cat.stages', { n: cat.filter(c => c.stage).length }))}</option>
                  ${STAGES_LIST.map(s => `<option value="stage:${esc(s.id)}">${esc(t('sk.cat.stageOnly', { s: stageLabel(s) }))}（${cat.filter(c => c.stage === s.id).length}）</option>`).join('')}
                </optgroup>
                <optgroup label="${esc(t('sk.cat.bySkill'))}">
                  ${[...cat].sort((a, b) => (skillStageOrder(p, a.stage) - skillStageOrder(p, b.stage)) || (artNum(a.id) - artNum(b.id)))
                    .map(c => `<option value="${esc(c.id)}" title="${esc(c.desc || '')}">${stageNo(p, c.stage) ? `${stageNo(p, c.stage)}_` : ''}${esc(stageLabelById(c.stage, t('sk.stage.all')))}_${esc(c.name)}</option>`).join('')}
                </optgroup>
              </select>
              <button class="btn primary" data-preset-import style="margin-top:8px;padding:9px 12px">${esc(t('sk.import'))}</button>
              <button class="btn" data-type-import style="margin-top:8px;margin-left:8px" title="${esc(t('sk.typePack.title', { name: typeName(p.type), dirs: typeMeta(p.type).layers?.join(' / ') || '' }))}">${esc(t('sk.typePack', { n: typeMeta(p.type).skills?.length || 0 }))}</button>
              <div class="hint">${esc(t('sk.cat.hint', { n: cat.length }))}</div>
            </div>
          </form>
        </div>
      </div>`;
  }},

  wbs: { name: 'WBS / Development', render() {
    const p = P(); if (!p) return noProject();
    if (!p.wbs.epics.length) return `<div class="page-head"><div>${viewTitle('wbs', esc(t('view.wbs')))}</div></div><div class="card"><div class="empty"><h2>${esc(t('wbs.notReady'))}</h2><div class="tiny">${esc(t('wbs.notReady.desc'))}</div></div></div>`;
    const tab = S.wbsTab;
    const tree = p.wbs.epics.map(e => {
      // 任务状态 = 它所属模块的状态（平台不追踪任务级进度，模块在跑 = 该 Epic 的任务正在执行）
      const mod = p.modules.find(m => m.epic === e.id);
      const st = mod ? mod.status : 'todo';
      const open = S.epicOpen[e.id] ?? (st === 'running');          // 正在执行的自动打开（用户手动折叠过就听用户的）
      const live = st === 'running';
      return `
      <div class="tnode epic s-${st}" data-epic="${e.id}" data-status="${st}"><span class="tw">${open ? '▾' : '▸'}</span><span class="tid">${e.id}</span><span class="tn">${esc(e.name)}</span><span class="stcell">${mod ? executionBar(mod, e.name, true) + pill(st, MSTS) : `<span class="pill bare">${esc(t('wbs.noModule'))}</span>`}<span class="mono tiny muted">${esc(t('wbs.tasks', { n: e.tasks.length }))}</span></span></div>
      ${open ? e.tasks.map(tk => `<div class="tnode child s-${st}" data-task="${tk.id}" data-status="${st}"><span class="tw"></span><span class="tid">${tk.id}</span><span class="tn">${esc(tk.name)}</span><span class="stcell"><span class="dot s-${st}${live ? ' live' : ''}"></span><span class="mono tiny muted">${esc(tk.files)}</span></span></div>`).join('') : ''}
      ${open ? `<div class="tnode child"><span class="tw"></span><span class="tid"></span><span class="tn muted">${esc(t('wbs.goal'))}：${esc(e.goal)}</span><span class="stcell"></span></div>` : ''}`;
    }).join('');
    const legend = `<div class="legend">${['running', 'pending', 'awaiting_review', 'approved', 'failed']
      .map(k => `<span class="lg"><span class="dot s-${k}${k === 'running' ? ' live' : ''}"></span>${esc(MSTS[k].t)}</span>`).join('')}</div>`;
    return `
      <div class="page-head">
        <div>${viewTitle('wbs', esc(t('view.wbs')))}<p>${esc(t('view.wbs.desc', { epics: p.wbs.epics.length, tasks: p.wbs.task_count, conc: DB.runtime?.concurrency ?? 1, stack: p.arch?.stack || p.tech || t('ov.techUnset'), layers: (p.arch?.layers || []).join(' / ') || t('wbs.layersDefault'), from: t(p.arch?.from === 'ARC-01' ? 'view.wbs.fromArc' : 'view.wbs.fromDefault') }))}</p></div>
        <div class="tools"><div class="tabs tabs-eq"><button class="tab" aria-selected="${tab === 'tree'}" data-wbstab="tree">${tico(TAB_ICO.tree)}${esc(t('wbs.tree'))}</button><button class="tab" aria-selected="${tab === 'dev'}" data-wbstab="dev">${tico(TAB_ICO.dev)}${esc(t('wbs.dev'))}</button></div></div>
      </div>
      ${tab === 'tree' ? `<div class="grid g-fill"><div class="card"><header><h2>${esc(t('wbs.treeTitle'))}</h2><span class="kicker">Epic × Task</span><span class="right mono tiny muted">${esc(t('wbs.tasks', { n: p.wbs.task_count }))}</span></header><div class="body flush">${tree}</div><div class="foot">${legend}</div></div></div>` : devSection(p)}
    `;
  }},

  code: { name: 'Source', render() {
    const p = P(); if (!p) return noProject();
    const all = WS.projectId === p.id ? WS.files : [];
    const src = sourceFiles(all);
    const pane = codeBrowser(p, src, {
      untitled: t('code.listTitle'),
      empty: t('code.emptyList'),
    });
    const mod = pane.fmod;
    const ut = mod && mod.unit_tests;
    const approved = p.modules.filter(m => m.status === 'approved').length;
    const meta = `<div class="kv">
            <div class="k">${esc(t('code.workspace'))}</div><div class="v mono">workspace/${esc(p.id)}</div>
            <div class="k">${esc(t('code.srcAll'))}</div><div class="v mono">${esc(t('code.fileCount', { n: src.length, m: all.length }))}</div>
            <div class="k">${esc(t('code.modules'))}</div><div class="v mono">${esc(t('code.modulesApproved', { done: approved, total: p.modules.length }))}</div>
            <div class="k">${esc(t('code.channel'))}</div><div class="v">${DB.channel?.channel === 'live' ? esc(t('code.model', { m: DB.channel.model })) : esc(t('code.offline'))}</div>
          </div>
          ${mod ? `<div class="hr"></div><div class="kv">
            <div class="k">${esc(t('code.curFile'))}</div><div class="v mono">${esc(WS.path || '—')}</div>
            <div class="k">${esc(t('code.owner'))}</div><div class="v">${esc(mod.id)} · ${esc(mod.name)}</div>
            <div class="k">${esc(t('code.layer'))}</div><div class="v mono">${esc(mod.layer || '—')}</div>
            <div class="k">${esc(t('code.dir'))}</div><div class="v mono">${esc(mod.dir || '—')}/</div>
            <div class="k">${esc(t('code.modStatus'))}</div><div class="v">${STS[mod.status] ? STS[mod.status].t : esc(mod.status)}</div>
            ${ut ? `<div class="k">${esc(t('code.unitTests'))}</div><div class="v mono">PASS=${ut.passed} FAIL=${ut.failed} exit=${ut.exit_code}</div>
            <div class="k">${esc(t('code.testFile'))}</div><div class="v mono">${esc(mod.test_path || '—')}</div>` : `<div class="k">${esc(t('code.unitTests'))}</div><div class="v">${esc(t('code.notRun'))}</div>`}
          </div>` : `<div class="hr"></div><div class="tiny muted">${esc(t('code.noModule'))}</div>`}`;
    return `
      <div class="page-head"><div>${viewTitle('code', esc(t('view.code')))}<p>${t('view.code.desc')}</p></div>
        <div class="tools"><span class="chip">${esc(t('code.chipFiles', { n: src.length }))}</span><span class="chip">${esc(t('code.chipApproved', { done: approved, total: p.modules.length }))}</span></div></div>
      ${codeGrid(pane, { leftTitle: t('code.listTitle'), leftKicker: t('code.leftKicker', { n: src.length }), meta })}`;
  }},

  artifacts: { name: 'Artifacts', render() {
    const p = P(); if (!p) return noProject();
    const tab = S.artTab || 'artifacts';
    const arts = allArtifacts(p);
    let left, title, kicker, mid, foot = '', acts = '';
    if (tab === 'files') {
      const files = WS.projectId === p.id ? WS.files : [];
      ({ left, mid, acts, foot, title } = codeBrowser(p, files, {
        empty: t('code.emptyWs') + '<br><br>' + t('code.emptyWs.hint'),
      }));
      kicker = `workspace/${p.id}`;
    } else {
      const sel = arts.find(a => a.id === S.artifact) || arts[0];
      if (sel) S.artifact = sel.id;
      left = arts.map(a => `<div class="row ${a.id === S.artifact ? 'sel' : ''}" data-artifact="${esc(a.id)}"><span class="id mono">${esc(a.id)}</span><span class="nm">${esc(artFullName(p, a))}</span><span class="path">${esc(artOwnerLabel(p, a))}</span></div>`).join('') || `<div class="empty tiny">${esc(t('art.none'))}</div>`;
      title = sel ? artFullName(p, sel) : '—'; kicker = sel ? sel.id : '';
      const owner = sel ? artifactOwner(p, sel) : null;
      const locked = owner && owner.status === 'approved';
      const wbs = sel && sel.type === 'wbs';
      if (sel && !wbs && S.editArt === sel.id) {
        mid = `<textarea class="field" data-edit-area style="min-height:52vh;font:400 12px/1.6 var(--font-mono)">${esc(DRAFT.key === 'art:' + sel.id ? DRAFT.text : sel.content)}</textarea>`;
        acts = `<button class="btn primary" data-save-art="${esc(sel.id)}">${esc(t('act.saveArtifact'))}</button><button class="btn" data-cancel-edit>${esc(t('act.cancel'))}</button>`;
      } else {
        mid = wbs ? wbsSummary(p) : `<div class="prose">${sel ? md(sel.content) : `<div class="muted tiny">${esc(t('com.chooseArtifact'))}</div>`}</div>`;
        acts = !sel || wbs ? '' : (locked
          ? `<span class="pill v2">${esc(t('gate.lockedStage'))}</span>`
          : `<button class="btn warn" data-edit-art="${esc(sel.id)}">${esc(t('act.edit'))}</button>`);
      }
      const sel2 = sel;
      foot = sel2 ? `<div class="foot">${esc(t('art.meta.owner'))} ${esc(artOwnerLabel(p, sel2))} · v${sel2.version || 1}${sel2.edited ? ` · ${esc(t('art.edited', { n: sel2.edited.count || 1, at: fmtTime(sel2.edited.at) }))}` : ''} · ${esc(sel2.status)} · ${sel2.at ? fmtTime(sel2.at) : ''}</div>` : '';
    }
    const a0 = arts.find(x => x.id === S.artifact);
    const metaHtml = tab === 'files' ? `<div class="kv">
            <div class="k">${esc(t('code.workspace'))}</div><div class="v mono">workspace/${esc(p.id)}</div>
            <div class="k">${esc(t('code.channel'))}</div><div class="v">${DB.channel?.channel === 'live' ? esc(t('code.model', { m: DB.channel.model })) : esc(t('code.offline'))}</div>
            <div class="k">${esc(t('art.files'))}</div><div class="v mono">${WS.projectId === p.id ? WS.files.length : 0}</div>
          </div>` : (a0 ? `<div class="kv">
            <div class="k">${esc(t('art.meta.id'))}</div><div class="v mono">${esc(a0.id)}</div>
            <div class="k">${esc(t('art.meta.name'))}</div><div class="v">${esc(artFullName(p, a0))}</div>
            <div class="k">${esc(t('art.meta.stage'))}</div><div class="v">${esc(a0 ? artOwnerLabel(p, a0) : '—')}</div>
            <div class="k">${esc(t('art.meta.type'))}</div><div class="v mono">${esc(a0.type)}</div>
            <div class="k">${esc(t('art.meta.version'))}</div><div class="v mono">v${a0.version || 1}</div>
            <div class="k">${esc(t('art.meta.status'))}</div><div class="v">${esc(a0.status)}</div>
            <div class="k">${esc(t('art.meta.at'))}</div><div class="v mono">${a0.at ? fmtTime(a0.at) : '—'}</div>
          </div>` : '');
    return `
      <div class="page-head"><div>${viewTitle('artifacts', esc(t('view.artifacts')))}<p>${esc(t('view.artifacts.desc'))}</p></div>
        <div class="tools"><div class="tabs">
          <button class="tab" aria-selected="${tab === 'artifacts'}" data-arttab="artifacts">${esc(t('art.tab.artifacts', { n: arts.length }))}</button>
          <button class="tab" aria-selected="${tab === 'files'}" data-arttab="files">${esc(t('art.tab.files'))}</button>
        </div></div></div>
      ${codeGrid({ left, mid, acts, foot, title, kicker }, {
        leftTitle: tab === 'files' ? t('art.files') : t('art.list'),
        leftKicker: tab === 'files' ? 'workspace' : arts.length,
        meta: metaHtml,
        wideLeft: true,                     // 产物页：清单列加宽（产物名/流程序号比文件名长）
      })}`;
  }},

  runs: { name: 'Run Log', render() {
    const p = P(); if (!p) return noProject();
    const evs = p.events.slice().reverse();
    return `
      <div class="page-head"><div>${viewTitle('runs', esc(t('view.runs')))}<p>${esc(t('run.desc'))}</p></div>
        <div class="tools"><span class="chip"><span class="pulse"></span> ${esc(t('run.count', { n: p.events.length }))}</span></div></div>
      <div class="card"><header><h2>${esc(t('run.events'))}</h2><span class="kicker">Event Log</span></header>
        <div class="body flush tablewrap" style="max-height:70vh"><div class="steps-mini steps-time" style="padding:8px 14px">
          ${evs.map(e => `<div class="s"><span class="mono muted tiny">${fmtTime(e.ts)}</span><span>${esc(e.text)}</span><span class="mono tiny muted">${esc(e.stage)}</span></div>`).join('') || `<div class="muted tiny">${esc(t('run.none'))}</div>`}
        </div></div>
      </div>`;
  }},

  settings: { name: 'LLM Providers', render() {
    if (!SETTINGS_CACHE) return `<div class="page-head"><div>${viewTitle('settings', esc(t('view.settings')))}</div></div><div class="card"><div class="empty"><h2>${esc(t('msg.loading'))}</h2></div></div>`;
    const list = SETTINGS_CACHE.providers || [];
    const defId = SETTINGS_CACHE.defaultProvider || '';
    const enabled = list.filter(x => x.enabled && x.hasKey).length;
    const warn = enabled === 0
      ? `<div class="set-warn danger">${esc(t('set.warn.noProvider'))}</div>`
      : '';
    const defaultBox = `
      <div class="set-default">
        <span class="lb">${esc(t('set.default'))}</span>
        <select class="field" id="setDefaultSel" style="max-width:280px">
          <option value="">—</option>
          ${list.map(x => `<option value="${esc(x.id)}"${x.id === defId ? ' selected' : ''}>${esc(x.name)}${x.enabled && x.hasKey ? '' : ' (' + esc(t(x.enabled ? 'set.noKey' : 'set.disabled')) + ')'}</option>`).join('')}
        </select>
        <span class="hint">${esc(t('set.default.hint'))}</span>
        <button class="btn primary" data-set-default style="margin-left:auto">${esc(t('set.default.set'))}</button>
      </div>`;
    const cards = list.map(p => providerCard(p)).join('');
    return `
      <div class="page-head">
        <div>${viewTitle('settings', esc(t('view.settings')))}<p>${esc(t('view.settings.desc'))}</p></div>
      </div>
      ${warn}
      ${defaultBox}
      <div class="set-grid">${cards}</div>
      <div class="card" style="margin-top:var(--gap)"><div class="body tiny muted">${esc(t('set.footNote'))}</div></div>
    `;
  }},
};

/* ---------- 片段 ---------- */

/** Settings 视图：单张 provider 卡片的渲染。表单字段在 SETTINGS_DRAFT[id] 里（每张卡一个），草稿在 SSE 重渲染时不丢。 */
function providerCard(p) {
  const d = SETTINGS_DRAFT[p.id] || {};
  // 表单字段：缺省 = 当前 provider 的值
  const name = (d.name !== undefined) ? d.name : p.name;
  const enabled = (d.enabled !== undefined) ? d.enabled : p.enabled;
  const apiStyle = (d.apiStyle !== undefined) ? d.apiStyle : p.apiStyle;
  const baseUrl = (d.baseUrl !== undefined) ? d.baseUrl : p.baseUrl;
  const apiKey = (d.apiKey !== undefined) ? d.apiKey : (p.hasKey ? p.apiKeyMasked : '');
  const models = (d.models !== undefined) ? d.models : p.models.slice();
  const defaultModel = (d.defaultModel !== undefined) ? d.defaultModel : p.defaultModel;
  const showKey = !!d.showKey;
  const testing = !!d.testing;
  const testRes = d.testResult || null;            // {ok, ms, extra, err, sample} | null
  const dirty = isDirty(p, d);

  const styleOpts = [['openai', t('set.style.openai')], ['anthropic', t('set.style.anthropic')]]
    .map(([v, n]) => `<option value="${esc(v)}"${v === apiStyle ? ' selected' : ''}>${esc(n)}</option>`).join('');

  const modelChips = '';   // 旧 chip 已废；保留变量名避免下游引号错位
  const modelsText = models.join('\n');

  // 状态徽标只显示 key 情况（启用与否看右上角开关）：head 里不再重复「已启用/未启用」字样
  const status = p.hasKey
    ? `<span class="pill ok">${esc(t('set.hasKey'))}</span>`
    : `<span class="pill warn">${esc(t('set.noKey'))}</span>`;

  return `
    <div class="card set-card" data-provider="${esc(p.id)}">
      <div class="head">
        <span class="nm" title="${esc(name)}">${esc(name)}</span>
        <span class="pill">${esc(p.id)}</span>
        <span class="pill mono">${esc(apiStyle)}</span>
        ${status}
      </div>
      <label class="set-toggle" title="${esc(t('set.enabled'))}">
        <input type="checkbox" data-field="enabled" ${enabled ? 'checked' : ''}>
        <span class="set-toggle-dot"></span>
        <span class="set-toggle-text">${esc(t('set.enabled'))}</span>
      </label>
      <div class="hint">${esc(p.hint || '')}</div>
      ${p.id === 'minimax' ? `<div class="set-warn" style="margin:4px 0 2px">${esc(t('set.baseUrl.cnio'))}</div>` : ''}
      <div class="row"><label class="lb">${esc(t('set.apiStyle'))}</label>
        <select class="field" data-field="apiStyle">${styleOpts}</select>
      </div>
      <div class="row"><label class="lb">${esc(t('set.baseUrl'))}</label>
        <input class="field" type="text" data-field="baseUrl" value="${esc(baseUrl)}" spellcheck="false">
      </div>
      <div class="row"><label class="lb">${esc(t('set.apiKey'))}</label>
        <input class="field" type="${showKey ? 'text' : 'password'}" data-field="apiKey"
               value="${esc(apiKey)}" placeholder="${esc(t('set.apiKey.ph'))}" autocomplete="off" spellcheck="false">
        <button class="btn" data-toggle-key="${esc(p.id)}" style="margin-left:6px">${esc(showKey ? t('set.apiKey.hide') : t('set.apiKey.show'))}</button>
      </div>
      <div class="row" style="align-items:flex-start"><label class="lb">${esc(t('set.models'))}<span class="models-count">(${models.length})</span></label>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px">
          <textarea class="field models-text" rows="${Math.min(Math.max(models.length + 1, 3), 10)}"
            data-models-textarea="${esc(p.id)}" spellcheck="false"
            placeholder="${esc(t('set.models.placeholder'))}">${esc(modelsText)}</textarea>
          <div class="hint">${esc(t('set.models.hint'))}</div>
          <div class="row" style="gap:6px;margin-top:2px">
            <label class="lb" style="min-width:auto">${esc(t('set.defaultModel'))}</label>
            <select class="field" data-field="defaultModel" style="max-width:260px">
              ${models.map(m => `<option value="${esc(m)}"${m === defaultModel ? ' selected' : ''}>${esc(m)}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-top">
          <span class="hint preview">${esc(t('set.preview', { count: enabled && p.hasKey ? models.length : 0 }))}</span>
        </div>
        <div class="footer-actions">
          <button class="btn" data-test-provider="${esc(p.id)}" ${testing ? 'disabled' : ''}>${testing ? esc(t('set.testing')) : esc(t('set.test'))}</button>
          <button class="btn primary" data-save-provider="${esc(p.id)}" ${dirty ? '' : 'disabled'}>${esc(t('set.save'))}</button>
          <button class="btn danger" data-clear-provider="${esc(p.id)}" ${p.hasKey ? '' : 'disabled'}>${esc(t('set.clear'))}</button>
        </div>
      </div>
      ${testRes ? (testRes.ok
        ? `<div class="test-result ok">${esc(t('set.test.ok', { ms: testRes.ms, extra: testRes.style === 'openai' ? t('set.test.openai', { n: testRes.count }) : t('set.test.anthropic', { m: testRes.model }) }))}<span class="sample mono tiny">${esc((testRes.sample || []).join(', '))}</span></div>`
        : `<div class="test-result fail">${esc(t('set.test.fail', { err: testRes.err }))}</div>`) : ''}
    </div>`;
}

/** 该 provider 的表单是否被改动（决定保存按钮的 disabled）。 */
function isDirty(p, d) {
  const fields = ['name', 'enabled', 'apiStyle', 'baseUrl', 'models', 'defaultModel'];
  for (const f of fields) {
    if (d[f] === undefined) continue;                                  // 用户没碰过
    if (f === 'models') {
      const a = d.models || [], b = p.models;
      if (a.length !== b.length || a.some((x, i) => x !== b[i])) return true;
    } else if (d[f] !== p[f]) return true;
  }
  // apiKey：空字符串/掩码回显 = 没改动；新写的明文 = 改动
  if (d.apiKey !== undefined && d.apiKey !== '' && d.apiKey !== p.apiKeyMasked && d.apiKey !== p.apiKey) return true;
  return false;
}

/** 写入表单字段（同时改 settingsDraft）。 */
function setDraftField(id, field, value) {
  const d = settingsDraft(id);
  d[field] = value;
}

/* 从 model chip / input 拿一个干净的模型名：去前后空格；空就 null。 */
const cleanModel = (s) => { const m = String(s || '').trim(); return m || null; };

function noProject() { return `<div class="page-head"><div>${viewTitle('projects', t('nav.projects'))}</div></div><div class="card"><div class="empty"><h2>${esc(t('msg.noProject'))}</h2><div class="tiny">${esc(t('msg.goCreate'))}<br><br><button class="btn primary" data-view="projects">${esc(t('act.create'))}</button></div></div></div>`; }

/** 某个阶段用哪个模型：定义过就选中它，没定义就落在「缺省」。改动即时保存（下一次调用生效）。 */
function modelSelect(p, stageId) {
  const cur = (p.models || {})[stageId] || '';
  // enabled provider × model 的笛卡尔积 → "providerId/modelName"
  const opts = ENABLED_MODELS.map(modelKey);
  // 老数据 / 用户手动键入了未启用 provider 的模型：保留显示，别静默吞
  if (cur && !opts.includes(cur)) opts.unshift(cur);
  return `<select class="field" data-stage-model="${esc(stageId)}"${p.stages.some(s => s.status === 'running' && s.id === stageId) ? ' disabled' : ''}>
    <option value=""${cur ? '' : ' selected'}>${esc(t('stage.model.default', { m: DB.default_model || 'deepseek-v4-flash' }))}</option>
    ${opts.map(m => `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`).join('')}
  </select>`;
}

/* 阶段图标：内联线性 SVG（描边走 currentColor，跟设计系统的仪器灰/琥珀一致；零依赖、不用 emoji 或图标字体） */
const ICO = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const STAGE_ICO = {
  requirements: ICO('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h4"/>'),
  ux: ICO('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>'),
  architecture: ICO('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
  wbs: ICO('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>'),
  development: ICO('<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>'),
  testing: ICO('<path d="M9 3h6M10 3v6l-5 8.5A2 2 0 007 21h10a2 2 0 001.7-3.5L14 9V3"/>'),
  deployment: ICO('<path d="M12 3l5 5h-3v6h-4V8H7z"/><path d="M5 17v2h14v-2"/>'),
  operations: ICO('<path d="M3 12h4l2.5-6 3.5 12 2.5-6h5"/>'),
};

/* 界面标题图标：每个界面的 h1 前一枚线性图标（复用 ICO()）；tab 用同一套 tico() 包一层 */
const tico = (svg) => `<span class="tico">${svg || ''}</span>`;
const TAB_ICO = { tree: ICO('<rect x="9" y="3" width="6" height="4" rx="1"/><path d="M12 7v4M6 15v-4h12v4"/><rect x="3" y="15" width="6" height="4" rx="1"/><rect x="15" y="15" width="6" height="4" rx="1"/>'), dev: STAGE_ICO.development };
const VIEW_ICO = {
  projects: ICO('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'),
  overview: STAGE_ICO.wbs,
  flow: ICO('<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8M8 6h6a2 2 0 012 2v2"/>'),
  wbs: TAB_ICO.tree,
  artifacts: STAGE_ICO.requirements,
  code: ICO('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M10 12l-2 2 2 2M14 12l2 2-2 2"/>'),
  runs: STAGE_ICO.operations,
  skills: ICO('<path d="M4 5a2 2 0 012-2h13v18H6a2 2 0 01-2-2z"/><path d="M8 3v18"/>'),
  settings: ICO('<rect x="3" y="5" width="18" height="5" rx="1.2"/><rect x="3" y="14" width="18" height="5" rx="1.2"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"/>'),
};
const viewTitle = (id, text) => `<h1>${tico(VIEW_ICO[id])}${text}</h1>`;

/* 左侧菜单：图标放在序号前面（图标 / 00 / 菜单名 / 角标）。入口处调一次，之后只更新角标 */
function paintNavIcons() {
  document.querySelectorAll('#nav .navbtn').forEach((b) => {
    const ic = b.querySelector('.ic'), svg = VIEW_ICO[b.dataset.view];
    if (ic && svg && !b.querySelector('.nico')) ic.insertAdjacentHTML('beforebegin', `<span class="nico">${svg}</span>`);
  });
}

/* 执行模式图标（卡片上用「图标在上、文字在下」显示）：人工审批 = 人；AI 自动审批 = 机器人 */
const MODE_ICO = {
  human_gate: ICO('<circle cx="12" cy="8" r="3.2"/><path d="M5.5 20a6.5 6.5 0 0113 0"/>'),
  auto: ICO('<rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 4.5v3.5M8.5 13h.01M15.5 13h.01M9 19v2M15 19v2"/>'),
};
/* 流程点右上角的「谁在执行」：每个阶段一枚**不同的机器人**图标，各自真彩色（20px）。
   共同点：方/圆头 + 天线 + 白眼睛 + 机身；差异用天线、眼型、头型、手臂表达（18px 下也能一眼分辨）。 */
const ROBOT_HEAD = (h) => (h === 'round'
  ? '<rect x="5" y="6" width="14" height="9.4" rx="4.6" fill="var(--c)"/>'
  : '<rect x="4.6" y="6" width="14.8" height="9.4" rx="2.4" fill="var(--c)"/>');
const ROBOT_EYES = (e) => (e === 'visor'
  ? '<rect x="8.2" y="9.7" width="7.6" height="2.2" rx="1.1" fill="#fff"/>'
  : e === 'one'
    ? '<circle cx="12" cy="11" r="2.1" fill="#fff"/>'
    : e === 'tri'
      ? '<circle cx="8.6" cy="11" r="1.15" fill="#fff"/><circle cx="12" cy="11" r="1.15" fill="#fff"/><circle cx="15.4" cy="11" r="1.15" fill="#fff"/>'
      : e === 'square'
        ? '<rect x="8" y="9.8" width="3" height="2.4" rx=".6" fill="#fff"/><rect x="13" y="9.8" width="3" height="2.4" rx=".6" fill="#fff"/>'
        : '<circle cx="9.2" cy="11" r="1.25" fill="#fff"/><circle cx="14.8" cy="11" r="1.25" fill="#fff"/>');
const ROBOT_BODY = '<rect x="6.6" y="16.7" width="10.8" height="4.5" rx="1.8" fill="var(--c)"/>';
const STAGE_ROBOT = {
  requirements: { c: '#2563EB', ant: '<path d="M12 6V3.1"/><circle cx="12" cy="2.3" r="1.2" fill="var(--c)"/>', head: 'square', eyes: 'dot', arms: '<path d="M3.5 9.6v3.2M20.5 9.6v3.2"/>' },
  ux: { c: '#A855F7', ant: '<path d="M9 5.8 8 3M15 5.8 16 3"/>', head: 'round', eyes: 'visor', arms: '<path d="M3.8 10.4v2.6M20.2 10.4v2.6"/>' },
  architecture: { c: '#0891B2', ant: '<circle cx="12" cy="3.1" r="2"/>', head: 'square', eyes: 'one', arms: '<path d="M3.5 9.6v3.2M20.5 9.6v3.2"/>' },
  wbs: { c: '#F59E0B', ant: '<path d="M8 5.9 7.1 3.2M12 5.9V2.7M16 5.9l.9-2.7"/>', head: 'square', eyes: 'tri', arms: '<path d="M3.5 9.6v3.2M20.5 9.6v3.2"/>' },
  development: { c: '#16A34A', ant: '<path d="M4.4 8.6h-2.2v2.8h2.2M19.6 8.6h2.2v2.8h-2.2" fill="none"/>', head: 'square', eyes: 'square', arms: '<path d="M4.6 16.4 3.2 14M19.4 16.4l1.4-2.4"/>' },
  testing: { c: '#DC2626', ant: '<path d="M12 6V3.1"/><circle cx="12" cy="2.3" r="1.2" fill="var(--c)"/>', head: 'round', eyes: 'visor', arms: '<path d="M3.8 10.2v3M20.2 10.2v3"/><circle cx="20.4" cy="17.6" r="2.5"/><path d="M18.8 19.4 17.2 21"/>' },
  deployment: { c: '#6366F1', ant: '<path d="M12 5.9V3.4"/><path d="M10.4 4.2 12 2.6 13.6 4.2"/>', head: 'square', eyes: 'dot', arms: '<path d="M3.5 4.6v4.2M20.5 4.6v4.2"/>' },
  operations: { c: '#0D9488', ant: '<path d="M12 6V3.1"/><circle cx="12" cy="2.3" r="1.2" fill="var(--c)"/>', head: 'round', eyes: 'pulse', arms: '<path d="M3.8 10.4v3M20.2 10.4v3"/><rect x="8.4" y="17" width="7.2" height="2.1" rx="1" fill="#fff"/>' },
};
const stageBadge = (s) => {
  const r = STAGE_ROBOT[s.id]; if (!r) return '';
  const eyes = r.eyes === 'pulse'
    ? '<path d="M8.4 11h2l1-2.1 1.3 4.2 1.1-2.1h1.8" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
    : ROBOT_EYES(r.eyes);
  return `<span class="bot" style="--c:${r.c}" title="${esc(s.agent || 'AI Agent')} · ${esc(t('act.run'))}">`
    + `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="var(--c)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">`
    + `${r.ant}${ROBOT_HEAD(r.head)}${eyes}${r.arms || ''}${ROBOT_BODY}</svg></span>`;
};

const modeBlock = (p) => { const auto = p.mode === 'auto'; return `<span class="mode-ico ${auto ? 'run' : 'acc'}" title="${esc(auto ? t('proj.mode.auto') : t('proj.mode.human'))}">${tico(MODE_ICO[auto ? 'auto' : 'human_gate'])}<span class="mt">${esc(auto ? t('proj.mode.autoShort') : t('proj.mode.humanShort'))}</span></span>`; };

function pipe(p) {
  return `<div class="pipe">${p.stages.map((s, i) => `
    <div class="pipe-node ${s.id === S.stage ? 'sel' : ''}" data-stage="${s.id}" data-state="${FLOWSTATE[s.status] || 'pending'}">
      <div class="stripe"></div>
      ${stageBadge(s)}
      <div class="n">${String(i + 1).padStart(2, '0')}</div>
      <div class="ico">${STAGE_ICO[s.id] || ''}</div>
      <div class="t">${esc(stageLabel(s))}</div>
      <div class="meta"><span>${STS[s.status].t}</span></div>
      ${executionBar(stageExecution(p, s), stageLabel(s), true)}
    </div>`).join('')}</div>`;
}

function tlClass(kind) { return kind === 'gate' ? 'warn' : kind === 'test' ? 'ok' : kind === 'run' ? 'run' : kind === 'artifact' ? 'ok' : ''; }

function gatePanel(p, st, compact) {
  const s = st || summary(p).cur;
  if (!s) return `<div class="gate"><div class="gt">${esc(t('gate.allDone'))}</div><div class="gd">${esc(t('gate.allDoneDesc'))}</div></div>`;

  if (s.kind === 'development') {
    const rev = p.modules.filter(m => m.status === 'awaiting_review');
    const run = p.modules.filter(m => m.status === 'running');
    if (!rev.length) return `<div class="gate"><div class="gt">${esc(t('gate.devStage'))}</div><div class="gd">${run.length ? esc(t('gate.agentsWorking', { n: run.length, agents: run.map(m => `${m.agent}→${m.id}`).join(' / ') })) : esc(t(s.status === 'approved' ? 'gate.allDoneDesc' : s.status === 'failed' ? 'dev.failed' : 'gate.waitPrev'))} ${esc(t('gate.devSummary', { done: p.modules.filter(m => m.status === 'approved').length, total: p.modules.length }))}</div></div>`;
    return moduleGate(p, rev[0], compact) + (rev.length > 1 ? `<div class="hint">${esc(t('wbs.moreReviews', { n: rev.length - 1 }))}</div>` : '');
  }
  if (s.status === 'failed') return `<div class="gate" style="border-color:color-mix(in oklab,var(--fail) 45%,var(--line));background:var(--fail-dim)">
    <div class="gt" style="color:var(--fail)">${esc(t('dev.failed'))}</div>
    <div class="gd">${esc(s.error || '(no details)')}</div>
    <div class="acts"><button class="btn" data-run-stage="${esc(s.id)}">${esc(t('dev.retry'))}</button></div></div>`;
  if (s.status === 'awaiting_review') {
    if (S.reject && S.reject.kind === 'stage' && S.reject.id === s.id) return rejectForm('stage', s.id);
    return `<div class="gate">
      <div class="gt"><span class="pulse" style="background:var(--warn)"></span>${esc(t('gate.needsReview'))} · ${esc(stageLabelN(P(), s))}</div>
      <div class="gd">${esc(t('gate.awaitDesc', { n: (s.artifacts || []).length, r: s.attempts + 1 }))}</div>
      <div class="acts">
        <button class="btn primary" data-approve-stage="${esc(s.id)}">✓ ${esc(t('gate.approveStage'))}</button>
        <button class="btn danger" data-reject-stage="${esc(s.id)}">✕ ${esc(t('act.reject'))}</button>
      </div></div>`;
  }
  if (s.status === 'running') return `<div class="gate" style="border-color:var(--line);background:var(--panel-2)"><div class="gt" style="color:var(--run)">${esc(s.agent)} ${esc(t('st.running'))}…</div>${st ? '' : executionBar(s, stageLabel(s))}</div>`;
  if (s.status === 'approved') return `<div class="gate" style="border-color:color-mix(in oklab,var(--ok) 40%,var(--line));background:var(--ok-dim)"><div class="gt" style="color:var(--ok)">✓ ${esc(t('st.approved'))}</div><div class="gd">${esc(s.review?.by || t('gate.reviewBy'))} · ${fmtTime(s.review?.at)}</div></div>`;
  return `<div class="gate" style="border-color:var(--line);background:var(--panel-2)"><div class="gt" style="color:var(--muted)">${esc(t('st.pending'))}</div><div class="gd">${esc(t('gate.waitPrev'))}<button class="btn" data-run-stage="${esc(s.id)}" style="margin-left:8px">▶ ${esc(t('act.run'))}</button></div></div>`;
}

function rejectForm(kind, id) {
  const r = S.reject;
  return `<div class="gate">
    <div class="gt">${esc(t('gate.rejectTitle'))}</div>
    <div><label class="lb">${esc(t('gate.rejectReason'))}</label>
      <select class="field" data-reject-cat>${REJECT_CATS.map(([v, k]) => `<option value="${esc(v)}" ${r.category === v ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}</select></div>
    <div><label class="lb">${esc(t('gate.rejectComment'))}</label>
      <textarea class="field" data-reject-comment placeholder="${esc(t('gate.rejectHint'))}">${esc(r.comment || '')}</textarea></div>
    <div class="acts">
      <button class="btn danger" data-reject-send="${kind}:${esc(id)}">${esc(t('act.confirm'))}</button>
      <button class="btn" data-reject-cancel>${esc(t('act.cancel'))}</button>
    </div></div>`;
}

function moduleGate(p, mod, compact) {
  if (S.reject && S.reject.kind === 'module' && S.reject.id === mod.id) return rejectForm('module', mod.id);
  const ut = mod.unit_tests || {};
  return `<div class="gate">
    <div class="gt"><span class="pulse" style="background:var(--warn)"></span>${esc(t('gate.moduleWaiting', { id: mod.id, name: mod.name }))}</div>
    <div class="gd">${t('gate.moduleRule', { cmd: esc(ut.cmd || ''), total: ut.total, passed: ut.passed, failed: ut.failed, code: ut.exit_code, ms: ut.ms })}</div>
    <div class="acts">
      <button class="btn primary" data-approve-module="${esc(mod.id)}" ${ut.failed ? 'disabled' : ''}>✓ ${esc(t('gate.approveModule'))}</button>
      <button class="btn danger" data-reject-module="${esc(mod.id)}">✕ ${esc(t('act.reject'))}</button>
    </div></div>`;
}

// 语言档案显示名（与 exec.mjs 的 PROFILES.label 对应；模块自带 profile id，老数据没这个字段就按项目档案回落）
const PROF_LABEL = { node: 'Node.js（ESM / node --test）', java: 'Java（javac + java）', 'cap-java': 'SAP CAP Java（CDS + Java）', 'cap-node': 'SAP CAP Node.js（CDS + ESM）', python: 'Python（stdlib unittest）' };
const profLabel = (p, m) => PROF_LABEL[m?.profile || p?.arch?.profile] || p?.arch?.profileLabel || PROF_LABEL.node;

function devSection(p) {
  const running = p.modules.filter(m => m.status === 'running');
  const rows = p.modules.map(m => {
    const ut = m.unit_tests;
    return `<div class="mod-row ${m.id === S.module ? 'sel' : ''} ${m.status === 'running' ? 'run' : ''}" data-module="${esc(m.id)}">
      <span class="mid">${esc(m.id)}</span>
      <div class="mod-name"><span class="mn">${esc(m.name)}</span>${executionBar(m, m.name, true)}</div>
      <span>${pill(m.status, MSTS)}</span>
      <span class="mt">${ut ? esc(t('dev.modUnit', { p: ut.passed, t: ut.total, c: ut.exit_code })) : '—'}</span>
      <span class="mt">${esc(m.agent || m.epic)}</span>
    </div>`;
  }).join('') || `<div class="empty tiny">${esc(t('wbs.noModules'))}</div>`;
  const sel = p.modules.find(m => m.id === S.module) || p.modules.find(m => m.status === 'awaiting_review') || p.modules[0];
  if (sel) S.module = sel.id;
  const ut = sel?.unit_tests;
  return `<div class="grid g-side g-dev g-fill">
    <div class="card"><header><h2>${esc(t('wbs.devHeader'))}</h2><span class="kicker">${esc(t('wbs.devKicker', { conc: DB.runtime?.concurrency ?? 1 }))} · ${esc(profLabel(p))}</span><span class="right mono tiny muted">${esc(t('wbs.approvedCount', { done: p.modules.filter(m => m.status === 'approved').length, total: p.modules.length }))}${running.length ? esc(t('dev.devCount', { n: running.length })) : ''}</span></header>
      <div class="body flush">${rows}</div>
      ${running.length ? `<div class="foot">${running.map(m => `${esc(m.agent)} → ${esc(m.id)} ${esc(m.name)}`).join(' ｜ ')}</div>` : ''}</div>
    <div class="card"><header><h2>${sel ? esc(sel.name) : '—'}</h2><span class="kicker mono">${sel ? esc(sel.id) : ''}</span><span class="right">${sel ? pill(sel.status, MSTS) : ''}</span></header>
      <div class="body insp">
        ${sel ? executionBar(sel, t('progress.execution')) : ''}
        ${sel ? (S.reject && S.reject.kind === 'module' && S.reject.id === sel.id ? rejectForm('module', sel.id)
          : sel.status === 'awaiting_review' ? moduleGate(p, sel)
          : sel.status === 'failed' ? `<div class="gate" style="border-color:color-mix(in oklab,var(--fail) 45%,var(--line));background:var(--fail-dim)"><div class="gt" style="color:var(--fail)">${esc(t('dev.failed'))}</div><div class="gd">${esc(sel.error || t('dev.noDetail'))}</div><div class="acts"><button class="btn" data-run-module="${esc(sel.id)}">${esc(t('dev.retry'))}</button></div></div>`
          : `<div class="gate" style="border-color:var(--line);background:var(--panel-2)"><div class="gt" style="color:var(--ink-2)">${MSTS[sel.status].t}</div><div class="gd">${esc(sel.status === 'pending' ? t('dev.waitPrevModule') : sel.status === 'approved' ? t('dev.approvedAt', { by: sel.review?.by || '', at: fmtTime(sel.review?.at) }) : t('dev.running'))}</div>${sel.status === 'pending' && isNextModule(p, sel) ? `<div class="acts"><button class="btn" data-run-module="${esc(sel.id)}">${esc(t('dev.start'))}</button></div>` : ''}</div>`) : ''}
        ${sel && sel.dir ? `<div class="kv">
            <div class="k">${esc(t('dev.profile'))}</div><div class="v mono">${esc(profLabel(p, sel))}</div>
            <div class="k">${esc(t('code.layer'))}</div><div class="v mono">${esc(sel.layer || '—')}</div>
            <div class="k">${esc(t('code.dir'))}</div><div class="v mono">${esc(sel.dir)}/</div>
            <div class="k">${esc(t('dev.testPath'))}</div><div class="v mono">${esc(sel.test_path_planned || sel.test_path || '—')}</div>
          </div><div class="hr"></div>` : ''}
        ${ut ? `<div class="kv">
            <div class="k">${esc(t('code.unitTests'))}</div><div class="v mono">PASS=${ut.passed} FAIL=${ut.failed} exit=${ut.exit_code} ${ut.ms}ms</div>
            <div class="k">${esc(t('dev.cmd'))}</div><div class="v mono">${esc(ut.cmd || '')}</div>
            <div class="k">${esc(t('dev.testAt'))}</div><div class="v mono">${fmtTime(ut.at)}</div>
          </div>` : ''}
        ${sel && sel.files?.length ? `<div class="hr"></div><div class="list">${sel.files.map(f => `<div class="row"><span class="nm mono tiny">${esc(f.path)}</span><span class="num">${esc(t('msg.lines', { n: f.loc }))}</span></div>`).join('')}</div>` : ''}
        ${sel && sel.review?.decision === 'rejected' ? `<div class="hr"></div><div class="gate"><div class="gt">${esc(t('dev.rejectLog'))}</div><div class="gd">〔${esc(sel.review.category)}〕${esc(sel.review.comment || '')}</div></div>` : ''}
      </div></div>
  </div>`;
}
function isNextModule(p, m) { return p.modules.find(x => x.status === 'pending' || x.status === 'rejected')?.id === m.id; }

function wbsSummary(p) {
  return `<div class="prose">${md(`# WBS Breakdown\n\n${p.wbs.epics.length} Epics / ${p.wbs.task_count} Tasks.\n\n` + p.wbs.epics.map(e => `## ${e.id} ${e.name}\nGoal: ${e.goal}\n` + e.tasks.map(t => `- ${t.id} ${t.name} (\`${t.files}\`)`).join('\n')).join('\n\n'))}</div>`;
}

/* ============================ 交互 ============================ */

function render(keepScroll) {
  const p = P();
  if (p && !S.stage) { const cur = p.stages.find(s => s.status !== 'approved'); S.stage = cur?.id || p.stages[0].id; }
  const y = window.scrollY;
  const v = VIEWS[S.view] ? S.view : 'projects';
  S.view = v;
  document.getElementById('view').innerHTML = VIEWS[v].render();
  document.getElementById('crumbView').textContent = t('view.' + v);
  document.getElementById('crumbProj').textContent = p ? p.name : t('crumb.noProject');
  document.querySelectorAll('#nav .navbtn').forEach(b => b.setAttribute('aria-current', b.dataset.view === v ? 'page' : 'false'));
  document.getElementById('navStages').textContent = p ? p.stages.length : (DB.stages || []).length;
  document.getElementById('navProjects').textContent = DB.projects.length;
  document.getElementById('navTasks').textContent = p ? p.wbs.task_count : 0;
  document.getElementById('navArtifacts').textContent = p ? allArtifacts(p).length : 0;
  document.getElementById('navCode').textContent = p ? p.modules.reduce((n, m) => n + (m.files || []).length, 0) : 0;
  document.getElementById('navSkills').textContent = p ? (p.skills || []).length : 0;
  const ns = document.getElementById('navSettings');
  if (ns) {
    const enabled = (SETTINGS_CACHE && SETTINGS_CACHE.providers) ? SETTINGS_CACHE.providers.filter(x => x.enabled && x.hasKey).length : 0;
    ns.textContent = enabled || '—';
    ns.title = enabled ? `${enabled} provider enabled` : 'no provider enabled';
  }
  document.getElementById('chipMode').textContent = t('top.chipMode', { mode: p ? t(p.mode === 'auto' ? 'proj.mode.autoShort' : 'proj.mode.humanShort') : '—', conc: DB.runtime?.concurrency ?? 1 });
  document.getElementById('chipChan').textContent = DB.channel
    ? (DB.channel.channel === 'live' ? t('top.chipChanModel', { m: DB.channel.model }) : t('code.offlineChannel'))
    : '—';
  if (p) {
    const s = summary(p);
    const running = p.stages.some(x => x.status === 'running') || p.modules.some(m => m.status === 'running');
    document.getElementById('footData').textContent = t('proj.stats', { done: s.done, total: s.total, md: s.modDone, mt: s.modTotal, unit: s.unit, cur: running ? t('st.running') : t('st.allDone') });
    document.getElementById('footSrc').textContent = `${p.id} · ${p.events.length} ${t('kpi.events')}`;
  }
  renderLiveProgress();
  window.scrollTo(0, keepScroll ? y : 0);
  // 深链 / SSE 重渲染到「工作区文件」或「源码」时，文件列表还没拉过就补一次（否则左树空着）
  if (p && (v === 'code' || (v === 'artifacts' && (S.artTab || 'artifacts') === 'files')) && wsStale(p)) refreshWorkspace(p);
  if (v === 'skills' && !CATALOG && !catalogLoading) loadCatalog();     // 预设技能库：进页面时拉一次
  if (v === 'settings' && !SETTINGS_CACHE) refreshAll();                 // Settings：进页面时拉一次
}

function go(view) { S.view = view; S.reject = null; location.hash = view; render(); }

// 支持浏览器前进/后退与直接改 hash（截图脚本用 #view 切换）
window.addEventListener('hashchange', () => {
  const h = location.hash.replace('#', '');
  if (VIEWS[h] && h !== S.view) { S.view = h; S.reject = null; render(); }
});

document.addEventListener('click', (e) => {
  const el = (sel) => e.target.closest(sel);

  /* ===== LLM 服务 / Settings ===== */
  const setDefaultBtn = el('[data-set-default]');
  if (setDefaultBtn) {
    const v = document.getElementById('setDefaultSel')?.value || '';
    return act(async () => { await api.post('/api/settings/default', { providerId: v }); }, true);
  }
  const toggleKey = el('[data-toggle-key]');
  if (toggleKey) {
    const id = toggleKey.dataset.toggleKey;
    setDraftField(id, 'showKey', !((SETTINGS_DRAFT[id]) || {}).showKey);
    return render(true);
  }
  const addModelBtn = el('[data-add-model]');
  if (addModelBtn) return;   // 旧 chip 路径已废——保留入口只为了不再误命中
  const delModel = el('[data-del-model]');
  if (delModel) return;      // 同上
  const testBtn = el('[data-test-provider]');
  if (testBtn) {
    const id = testBtn.dataset.testProvider;
    const d = settingsDraft(id);
    d.testing = true; d.testResult = null;
    render(true);
    return act(async () => {
      try {
        const r = await api.post(`/api/settings/providers/${id}/test`, {});
        d.testing = false; d.testResult = { ok: true, ms: r.ms, style: r.style, count: r.count, sample: r.sample, model: r.model };
        // 自动同步：OpenAI 兼容的 provider 在测通后把列表从 /v1/models 拿回来；
        // 不清空——用户已编辑的内容会被覆盖；想保留就在「测试」前手动复制走。
        if (r.style === 'openai' && Array.isArray(r.sample) && r.sample.length) {
          d.models = r.sample.slice();
          if (!r.sample.includes(d.defaultModel || '')) d.defaultModel = r.sample[0];
          // 列表变了 → 重新渲染让用户看到结果；textarea 的失焦不是问题（用户点完 Test 就看结果）
          render(true);
        }
      } catch (e) {
        d.testing = false; d.testResult = { ok: false, err: e.message };
      }
    }, true);
  }
  const saveBtn = el('[data-save-provider]');
  if (saveBtn) {
    const id = saveBtn.dataset.saveProvider;
    const p = SETTINGS_CACHE.providers.find(x => x.id === id);
    if (!p) return;
    const d = settingsDraft(id);
    const body = {};
    if (d.name !== undefined && d.name !== p.name) body.name = d.name;
    if (d.enabled !== undefined && d.enabled !== p.enabled) body.enabled = !!d.enabled;
    if (d.apiStyle !== undefined && d.apiStyle !== p.apiStyle) body.apiStyle = d.apiStyle;
    if (d.baseUrl !== undefined && d.baseUrl !== p.baseUrl) body.baseUrl = d.baseUrl;
    if (d.models !== undefined && (d.models.length !== p.models.length || d.models.some((m, i) => m !== p.models[i]))) {
      body.models = d.models; body.defaultModel = d.defaultModel || p.defaultModel;
    } else if (d.defaultModel !== undefined && d.defaultModel !== p.defaultModel) {
      body.defaultModel = d.defaultModel;
    }
    if (d.apiKey !== undefined && d.apiKey !== '' && d.apiKey !== p.apiKeyMasked && d.apiKey !== p.apiKey) {
      body.apiKey = d.apiKey;
    }
    return act(async () => {
      await api.put(`/api/settings/providers/${id}`, body);
      // 保存成功 → 清掉该 provider 的草稿，避免下次进来看到旧状态
      delete SETTINGS_DRAFT[id];
    }, true);
  }
  const clearBtn = el('[data-clear-provider]');
  if (clearBtn) {
    const id = clearBtn.dataset.clearProvider;
    const p = SETTINGS_CACHE.providers.find(x => x.id === id);
    if (!p) return;
    if (!confirm(t('set.confirmClear', { name: p.name }))) return;
    return act(async () => { await api.post(`/api/settings/providers/${id}/clear`, {}); }, true);
  }

  const nav = el('#nav .navbtn, [data-view]');
  if (nav && nav.dataset.view) return go(nav.dataset.view);
  if (el('[data-goflow]')) return go('flow');

  const ed = el('[data-edit-project]');
  if (ed) {
    const p = DB.projects.find(x => x.id === ed.dataset.editProject);
    if (p) PEDIT = {
      id: p.id, name: p.name, brief: p.brief || '', tech: p.tech || '', mode: p.mode,
      type: p.type || (DB.types || [])[0]?.id || '', workflow: p.workflow || 'full',   // 只用来显示（两个下拉都是 disabled）
    };
    return render(true);
  }
  if (el('[data-cancel-edit]')) { PEDIT = null; return render(true); }

  const rb = el('[data-rebuild-project]');
  if (rb) {
    const id = rb.dataset.rebuildProject;
    const proj = DB.projects.find(x => x.id === id);
    const sk = (proj?.skills || []).length;
    if (!confirm(t('proj.rebuild.confirm', { name: proj ? proj.name : id, id, sk }))) return;
    return act(async () => {
      try { await api.post(`/api/projects/${id}/rebuild`, {}); }
      catch (e) {
        if (!/Project is running/.test(e.message)) throw e;
        if (!confirm(`${e.message}\n\n${t('proj.rebuild.force')}`)) return;
        await api.post(`/api/projects/${id}/rebuild`, { force: true });
      }
      if (S.project === id) { S.stage = null; S.module = null; S.artifact = null; }
    });
  }

  const del = el('[data-del-project]');
  if (del) {
    const id = del.dataset.delProject;
    const proj = DB.projects.find(x => x.id === id);
    if (!confirm(`Delete project "${proj ? proj.name : id}"?\n\nThis deletes all its state and generated files under workspace/${id}/. Irreversible.`)) return;
    return act(async () => {
      try { await api.del(`/api/projects/${id}`); }
      catch (e) {
        if (!/Project is running/.test(e.message)) throw e;
        if (!confirm(`${e.message}\n\nForce-delete now?`)) return;
        await api.del(`/api/projects/${id}?force=1`);
      }
      if (S.project === id) S.project = null;
    });
  }
  const card = el('[data-project]');
  if (card) { S.project = card.dataset.project; S.stage = null; S.module = null; api.post(`/api/projects/${S.project}/activate`, {}).catch(() => {}); return go('overview'); }

  const st = el('[data-stage]');
  if (st) { S.stage = st.dataset.stage; return render(true); }
  const md_ = el('[data-module]');
  if (md_) { S.module = md_.dataset.module; return render(true); }
  const art = el('[data-artifact]');
  if (art) { S.artifact = art.dataset.artifact; if (S.view !== 'artifacts') { S.view = 'artifacts'; } return go('artifacts'); }
  const ep = el('[data-epic]');
  if (ep) { S.epicOpen[ep.dataset.epic] = !S.epicOpen[ep.dataset.epic]; return render(true); }
  const wt = el('[data-wbstab]');
  if (wt) { S.wbsTab = wt.dataset.wbstab; return render(true); }
  const at = el('[data-arttab]');
  if (at) { S.artTab = at.dataset.arttab; if (S.artTab === 'files') return void refreshWorkspace(P()); return render(true); }
  const dir = el('[data-dir]');
  if (dir) { const d = dir.dataset.dir; S.wsOpen[d] = S.wsOpen[d] === false; return render(true); }
  const file = el('[data-file]');
  if (file) { S.editFile = null; DRAFT = { key: null, text: '' }; return void openFile(P(), file.dataset.file); }

  // 编辑产物 / 工作区文件
  const ea = el('[data-edit-art]');
  if (ea) { const a = allArtifacts(P()).find(x => x.id === ea.dataset.editArt); S.editArt = ea.dataset.editArt; DRAFT = { key: 'art:' + S.editArt, text: a ? a.content : '' }; return render(true); }
  const ef = el('[data-edit-file]');
  if (ef) { S.editFile = ef.dataset.editFile; DRAFT = { key: 'file:' + S.editFile, text: WS.content || '' }; return render(true); }
  if (el('[data-clear-picks]')) { PICKS = []; return render(true); }
  if (el('[data-clear-epicks]')) { EPICKS = []; return render(true); }
  if (el('[data-cancel-edit]')) { S.editArt = null; S.editFile = null; DRAFT = { key: null, text: '' }; return render(true); }
  if (el('[data-type-import]')) {                          // 一键导入「本分类自带的技能包」（TYPES[].skills）
    const ty = typeMeta(P().type);
    const ids = ty.skills || [];
    if (!ids.length) return alert(t('sk.cat.none'));
    return act(() => api.post(`/api/projects/${S.project}/skills/import`, { ids }));
  }
  if (el('[data-preset-import]')) {                        // 从预设技能库导入（按当前筛选）
    const v = (document.getElementById('presetSel') || {}).value || 'all';
    const cat = CATALOG || [];
    const ids = cat.filter(c => v === 'all' ? true
      : v === 'stage' ? !!c.stage
      : v.startsWith('stage:') ? c.stage === v.slice(6)
      : c.id === v).map(c => c.id);                       // 下拉里直接选了某一条技能 → 就导它一条
    if (!ids.length) return alert(t('sk.cat.none'));
    return act(async () => {
      const r = await api.post(`/api/projects/${S.project}/skills/import`, { ids });
      alert(t('sk.cat.done', { a: r.added, s: r.skipped, n: r.total }));
    });
  }
  if (el('[data-skill-cancel]')) { S.skillEdit = null; SKDRAFT = { name: '', body: '', stage: '' }; return render(true); }
  const se = el('[data-skill-edit]');
  if (se) {
    const s = (P()?.skills || []).find(x => x.id === se.dataset.skillEdit);
    S.skillEdit = se.dataset.skillEdit;
    SKDRAFT = { name: s?.name || '', body: s?.body || '', stage: s?.stage || '' };   // 表单由草稿驱动，SSE 重渲染不丢字
    return render(true);
  }
  const sp = el('[data-skill-pick]');
  if (sp) {                                   // 勾选/取消勾选（批量删除用）；真实状态在 SKPICK，重渲染不丢
    sp.checked ? SKPICK.add(sp.dataset.skillPick) : SKPICK.delete(sp.dataset.skillPick);
    return render(true);
  }
  if (el('[data-skill-all]')) {                // 再点一次 = 取消全选
    const ids = (P()?.skills || []).map(s => s.id);
    SKPICK = (ids.length && SKPICK.size === ids.length) ? new Set() : new Set(ids);
    return render(true);
  }
  const sb = el('[data-skill-bulk-del]');
  if (sb) {
    const ids = [...SKPICK];
    if (!ids.length) return;
    if (!confirm(t('sk.delSel.confirm', { n: ids.length }))) return;
    return act(async () => {
      const r = await api.post(`/api/projects/${S.project}/skills/delete`, { ids });
      SKPICK = new Set();
      alert(t('sk.delSel.done', { n: r.deleted.length, left: r.count }));
    });
  }
  const sd = el('[data-skill-del]');
  if (sd) {
    const sk = (P()?.skills || []).find(x => x.id === sd.dataset.skillDel);
    if (!confirm(`Delete skill "${sk ? sk.name : sd.dataset.skillDel}"?\n\nIt will no longer be sent to new model calls (existing artifacts unaffected).`)) return;
    return act(() => api.del(`/api/projects/${S.project}/skills/${sd.dataset.skillDel}`));
  }
  const sa = el('[data-save-art]');
  if (sa) {
    const key = 'art:' + sa.dataset.saveArt;
    const p = P(); const a = allArtifacts(p).find(x => x.id === sa.dataset.saveArt);
    const text = DRAFT.key === key ? DRAFT.text : (a ? a.content : '');
    return act(async () => { await api.post(`/api/projects/${S.project}/artifacts/${sa.dataset.saveArt}`, { content: text, editor: 'Manual' }); S.editArt = null; DRAFT = { key: null, text: '' }; });
  }
  const sf = el('[data-save-file]');
  if (sf) {
    const key = 'file:' + sf.dataset.saveFile;
    const text = DRAFT.key === key ? DRAFT.text : (WS.content || '');
    return act(async () => {
      const r = await api.put(`/api/projects/${S.project}/file`, { path: sf.dataset.saveFile, content: text, editor: 'Manual' });
      S.editFile = null; DRAFT = { key: null, text: '' };
      await refreshWorkspace(P());                    // 刷新文件列表与模块状态
      await openFile(P(), sf.dataset.saveFile);       // 重新读回刚保存的内容（否则预览还停在旧文本）
      if (r && r.test) alert(t('msg.savedTests', { p: r.test.passed, f: r.test.failed, e: r.test.exit_code }));
    });
  }

  // 门禁
  const ap = el('[data-approve-stage]');
  if (ap) return act(() => api.post(`/api/projects/${S.project}/stages/${ap.dataset.approveStage}/approve`, { reviewer: 'Manual review' }));
  const rj = el('[data-reject-stage]');
  if (rj) { S.reject = { kind: 'stage', id: rj.dataset.rejectStage, category: REJECT_CATS[0], comment: '' }; return render(true); }
  const rs = el('[data-run-stage]');
  if (rs) return act(() => api.post(`/api/projects/${S.project}/stages/${rs.dataset.runStage}/run`, {}));
  const am = el('[data-approve-module]');
  if (am) return act(() => api.post(`/api/projects/${S.project}/modules/${am.dataset.approveModule}/approve`, { reviewer: 'Manual review' }));
  const rm = el('[data-reject-module]');
  if (rm) { S.reject = { kind: 'module', id: rm.dataset.rejectModule, category: REJECT_CATS[0], comment: '' }; return render(true); }
  const runm = el('[data-run-module]');
  if (runm) return act(() => api.post(`/api/projects/${S.project}/modules/${runm.dataset.runModule}/run`, {}));
  const send = el('[data-reject-send]');
  if (send) {
    const [kind, id] = send.dataset.rejectSend.split(':');
    const path = kind === 'stage' ? `/api/projects/${S.project}/stages/${id}/reject` : `/api/projects/${S.project}/modules/${id}/reject`;
    const body = { category: S.reject.category, comment: S.reject.comment, reviewer: 'Manual review' };
    S.reject = null;
    return act(() => api.post(path, body));
  }
  if (el('[data-reject-cancel]')) { S.reject = null; return render(true); }
});

document.addEventListener('input', (e) => {
  if (e.target.matches('[data-edit-area]')) DRAFT = { key: DRAFT.key, text: e.target.value };
  if (e.target.matches('[data-reject-comment]')) S.reject.comment = e.target.value;
  if (e.target.matches('[data-reject-cat]')) S.reject.category = e.target.value;
  /* LLM 服务表单：草稿同步到 SETTINGS_DRAFT，方便 SSE/重渲染不丢 */
  const f = e.target.closest('[data-provider]');
  if (f && e.target.matches('[data-field]')) {
    const id = f.dataset.provider;
    const field = e.target.dataset.field;
    let v = e.target.value;
    if (field === 'enabled') return;                       // enabled 是 checkbox，走 change
    if (field === 'models') return;                        // models 走加/删，不在这里编辑
    setDraftField(id, field, v);
  }
  /* 模型列表 textarea：手动改 → 同步 d.models + 同步「默认模型」下拉选项 + 改 count 徽标；
     不走 render()——否则会丢光标（在输一半的时候换框很不舒服） */
  const ta = f && f.querySelector('[data-models-textarea]');
  if (f && ta && e.target === ta) {
    const id = ta.dataset.modelsTextarea;
    const lines = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
    setDraftField(id, 'models', lines);
    const cnt = f.querySelector('.models-count');
    if (cnt) cnt.textContent = `(${lines.length})`;
    const sel = f.querySelector('select[data-field="defaultModel"]');
    const cur = sel ? sel.value : '';
    if (sel) sel.innerHTML = lines.map(m => `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`).join('');
    if (sel && lines.length && !lines.includes(cur)) {
      setDraftField(id, 'defaultModel', lines[0]);
      sel.value = lines[0];
    }
    // 「保存」按钮可点性：让 isDirty 重新判断（不重渲染只调一下）
    const saveBtn = f.querySelector('[data-save-provider]');
    if (saveBtn) {
      const d2 = SETTINGS_DRAFT[id] || {};
      const p2 = SETTINGS_CACHE.providers.find(x => x.id === id);
      saveBtn.disabled = !p2 || !isDirty(p2, d2);
    }
  }
});

document.addEventListener('input', (e) => {          // 技能表单：边打字边存草稿（SSE 刷新/重渲染不丢）
  if (!e.target.closest || !e.target.closest('#skillForm')) return;
  const name = e.target.name;
  if (name === 'name' || name === 'body' || name === 'stage') SKDRAFT[name] = e.target.value;
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'tgLang') return applyLang(e.target.value);
  if (e.target.matches('input[name="files"]')) {
    const inEdit = e.target.closest('form')?.id === 'editProject';
    if (inEdit) EPICKS = [...e.target.files]; else PICKS = [...e.target.files];
    return render(true);
  }
  /* LLM 服务表单：enabled 开关、协议下拉、默认模型下拉 */
  const f = e.target.closest('[data-provider]');
  if (f && e.target.matches('[data-field]')) {
    const id = f.dataset.provider;
    const field = e.target.dataset.field;
    let v;
    if (field === 'enabled') v = e.target.checked;
    else v = e.target.value;
    setDraftField(id, field, v);
    return render(true);                                    // 立刻让「保存」按钮可点
  }
  const sm = e.target.closest('[data-stage-model]');
  if (sm && S.project) return act(() => api.post(`/api/projects/${S.project}/models`, { models: { [sm.dataset.stageModel]: sm.value } }));
});

/** 把选中的文件读成文本（≤10 份、每份 ≤256KB、二进制跳过并说明）——新建与编辑共用。 */
async function readPicks(list) {
  const files = [], skipped = [];
  for (const file of (list || []).slice(0, 10)) {
    if (file.size > 262144) { skipped.push(`${file.name}（>256KB）`); continue; }
    const content = await file.text();
    if (content.includes('\u0000')) { skipped.push(t('msg.binaryFile', { name: file.name })); continue; }
    files.push({ name: file.name, content });
  }
  if (skipped.length) alert(t('msg.skipped') + skipped.join(' / '));
  return files;
}

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'skillForm') {                       // 技能库：新增 / 保存
    e.preventDefault();
    const f = new FormData(e.target);
    const id = e.target.dataset.skillId;
    const body = { name: f.get('name'), body: f.get('body'), stage: f.get('stage') || '', editor: 'Manual' };
    S.skillEdit = null;
    SKDRAFT = { name: '', body: '', stage: '' };
    await act(() => id
      ? api.put(`/api/projects/${S.project}/skills/${id}`, body)
      : api.post(`/api/projects/${S.project}/skills`, body));
    return;
  }
  if (e.target.id === 'editProject') {                  // 项目信息：字段与「新建项目」一致（分类/工作流只在没批准过阶段时可改）
    e.preventDefault();
    const f = new FormData(e.target);
    const id = e.target.dataset.id;
    const values = { name: f.get('name'), tech: f.get('tech'), brief: f.get('brief'), mode: f.get('mode') };
    if (f.get('type')) values.type = f.get('type');          // disabled 的字段不会进 FormData → 不发就表示「不改」
    if (f.get('workflow')) values.workflow = f.get('workflow');
    const files = await readPicks(EPICKS);                   // 补输入资料（和新建同一套读取规则）
    return act(async () => {
      await api.put(`/api/projects/${id}`, values);
      if (files.length) await api.post(`/api/projects/${id}/inputs`, { files });
      EPICKS = []; PEDIT = null;                             // 失败就别关掉表单
    });
  }
  if (e.target.id !== 'newProject') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const files = await readPicks(PICKS);                      // 多选上传：逐个读成文本带上
  PICKS = [];
  NPTYPE = null; NPWF = null;                              // 建完回到默认分类/默认流程
  await act(() => api.post('/api/projects', {
    name: f.get('name'), type: f.get('type'), tech: f.get('tech'), brief: f.get('brief'), mode: f.get('mode'), workflow: f.get('workflow'), files,
  }), true);
});

document.addEventListener('change', (e) => {      // 软件分类 → 带出默认流程 + 该分类的技术栈建议（新建与编辑两个表单共用同一套）
  const id = e.target.id;
  if (id !== 'typeSel' && id !== 'editTypeSel') return;
  const form = e.target.closest('form');
  if (!form) return;
  const ty = typeMeta(e.target.value);
  const wfSel = form.querySelector('select[name=workflow]');
  if (wfSel && ty.workflow) wfSel.value = ty.workflow;
  const hint = form.querySelector('#typeHint, #editTypeHint');
  if (hint) hint.textContent = `${ty.hint || ''} · ${t('proj.type.flow')}：${typeFlowText(ty.id)} · ${typePackText(ty.id)}`;
  const tech = form.querySelector('input[name=tech]');
  const techs = typeTechs(ty.id);
  if (tech && techs.length) tech.placeholder = techs[0];
  const dl = form.querySelector('datalist');
  if (dl) dl.innerHTML = techs.map(x => `<option value="${esc(x)}"></option>`).join('');   // 建议换成本分类的
  if (form.id === 'newProject') { NPTYPE = ty.id; NPWF = wfSel ? wfSel.value : ''; }        // 记住选择，SSE 重渲染不退回默认
});
document.addEventListener('change', (e) => {      // 新建表单里手改了工作流也记下来
  if (e.target.matches('#newProject select[name=workflow]')) NPWF = e.target.value;
});
document.addEventListener('change', (e) => {      // 工作流 / 执行模式：把它们的长说明写到下面那行（会换行，不再塞进下拉框里被截断）
  const t2 = e.target;
  if (t2.matches('#newProject select[name=workflow]')) { const h = document.getElementById('wfHint'); if (h) h.textContent = wfFlowText(t2.value); }
  else if (t2.matches('#editProject select[name=workflow]')) { const h = document.getElementById('editWfHint'); if (h) h.textContent = wfFlowText(t2.value); }
  else if (t2.id === 'modeSel') { const h = document.getElementById('modeHint'); if (h) h.textContent = modeDesc(t2.value); }
  else if (t2.id === 'editModeSel') { const h = document.getElementById('editModeHint'); if (h) h.textContent = modeDesc(t2.value); }
});

async function act(fn, keepForm) {
  try { await fn(); }
  catch (err) { alert(t('msg.actionFailed', { e: err.message })); }
  await refreshAll();
  render(!keepForm);
}

/** 拉一次 /api/state + /api/settings + /api/settings/enabled-models；settings 没改时也会重拉——开销可忽略。 */
async function refreshAll() {
  const [r, s, m] = await Promise.all([
    api.get('/api/state'),
    api.get('/api/settings').catch(() => null),
    api.get('/api/settings/enabled-models').catch(() => null),
  ]);
  DB = r; if (DB.active && !P()) S.project = DB.active;
  SETTINGS_CACHE = s || SETTINGS_CACHE;
  ENABLED_MODELS = (m && m.models) || ENABLED_MODELS;
}

const api = {
  async get(url) { const r = await fetch(url); if (!r.ok) throw new Error((await r.json()).error || r.statusText); return r.json(); },
  async post(url, body) { return send('POST', url, body); },
  async put(url, body) { return send('PUT', url, body); },
  async del(url) { return send('DELETE', url); },
};
async function send(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

async function loadCatalog() {
  catalogLoading = true;
  try { CATALOG = (await api.get('/api/skills/catalog')).skills || []; } catch { CATALOG = []; }
  catalogLoading = false;
  if (S.view === 'skills') render(true);
}

async function refreshWorkspace(p) {
  if (!p) return;
  const keep = WS.projectId === p.id;
  WS = { projectId: p.id, files: keep ? WS.files : [], path: keep ? WS.path : null, content: keep ? WS.content : '', loading: true, modCount: modFileCount(p), at: Date.now() };
  render(true);
  try {
    const r = await api.get(`/api/projects/${p.id}/workspace`);
    if (WS.projectId !== p.id) return;                      // 期间切了项目/又刷新过：这次结果作废，别覆盖新的
    WS.files = r.files; WS.loading = false;
    if (WS.path && !r.files.some(f => f.path === WS.path)) {      // 文件没了（重新构建/删除/换盘）：别把上一份内容留在编辑区
      WS.path = null; WS.content = ''; S.editFile = null; DRAFT = { key: null, text: '' };
    }
    if (!WS.path && r.files.length) {                       // 默认打开第一个源码文件，其次任意文件
      const pick = sourceFiles(r.files)[0] || r.files[0];
      await openFile(p, pick.path);
    }
    else render(true);
  } catch (e) { WS.loading = false; WS.modCount = -1; alert(t('msg.wsFailed', { e: e.message })); render(true); }
}

async function openFile(p, rel) {
  if (!p) return;
  try { const r = await api.get(`/api/projects/${p.id}/file?path=${encodeURIComponent(rel)}`); WS.path = r.path; WS.content = r.content; }
  catch (e) {
    if (WS.path === rel) { WS.path = null; WS.content = ''; S.editFile = null; }   // 文件读不到就别留着旧内容
    alert(t('msg.fileFailed', { e: e.message }));
  }
  render(true);
}

/* ---------- 主题 / 密度 / 语言 ---------- */
function syncTweaks() {
  document.getElementById('tgTheme').textContent = t(document.documentElement.dataset.theme === 'dark' ? 'top.theme.dark' : 'top.theme.light');
  document.getElementById('tgDensity').textContent = t(document.documentElement.dataset.density === 'compact' ? 'top.density.compact' : 'top.density.comfortable');
}
function buildLangSelect() {
  const sel = document.getElementById('tgLang');
  sel.innerHTML = LANGS.map(l => `<option value="${l.code}">${l.label}</option>`).join('');
  sel.value = lang();
  sel.title = t('top.lang');
}
function applyLang(code, keepView) {
  setLang(code);
  try { localStorage.setItem(LS + 'lang', lang()); } catch {}
  buildLangSelect(); applyStatic(); syncTweaks(); render(true);
  if (!keepView) { /* 视图不变，只换语言 */ }
}
document.addEventListener('click', (e) => {
  if (e.target.id === 'tgTheme') { const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = n; try { localStorage.setItem(LS + 'theme', n); } catch {} return syncTweaks(); }
  if (e.target.id === 'tgDensity') { const n = document.documentElement.dataset.density === 'compact' ? 'comfortable' : 'compact'; document.documentElement.dataset.density = n; try { localStorage.setItem(LS + 'density', n); } catch {} return syncTweaks(); }
});
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  const keys = [...document.querySelectorAll('#nav .navbtn')].map(b => b.dataset.view);   // 快捷键跟着菜单顺序走，不跟 VIEWS 的书写顺序
  if (/^[1-8]$/.test(e.key)) return go(keys[+e.key - 1]);
  if (e.key === 't') document.getElementById('tgTheme').click();
  if (e.key === 'd') document.getElementById('tgDensity').click();
});

/* ---------- 实时 ---------- */
let reloadT = null;
function scheduleReload() {
  clearTimeout(reloadT);
  reloadT = setTimeout(async () => {
    const focused = document.activeElement && document.activeElement.closest('form');
    const dirty = SKDRAFT.name || SKDRAFT.body || SKDRAFT.stage;      // 技能表单里正打着字
    try { await refreshAll(); if (DB.active && !P()) S.project = DB.active; } catch { return; }
    if (focused || dirty) { renderFooterOnly(); return; }   // 正在填表单：SSE 刷新只更新页脚，别把用户手里的表单换掉
    render(true);
  }, 150);
}
function renderFooterOnly() {
  const p = P(); if (!p) return;
  const s = summary(p);
  document.getElementById('footData').textContent = t('proj.stats', { done: s.done, total: s.total, md: s.modDone, mt: s.modTotal, unit: s.unit, cur: s.cur ? STS[s.cur.status].t : t('st.allDone') });
  renderLiveProgress();
}

(async function boot() {
  try { const t = localStorage.getItem(LS + 'theme'); if (t) document.documentElement.dataset.theme = t; const d = localStorage.getItem(LS + 'density'); if (d) document.documentElement.dataset.density = d; const lg = localStorage.getItem(LS + 'lang'); if (lg) setLang(lg); } catch {}
  try { const ql = new URLSearchParams(location.search).get('lang'); if (ql) setLang(ql); } catch {}   // ?lang=en 便于截图/分享
  buildLangSelect(); applyStatic(); syncTweaks();
  try { await refreshAll(); } catch (e) { alert(t('msg.connectingFailed', { e: e.message })); }
  if (DB.active) S.project = DB.active; else if (DB.projects[0]) S.project = DB.projects[0].id;
  const h = location.hash.replace('#', ''); if (VIEWS[h]) S.view = h;
  try {  // URL 覆盖（截图 / 分享用）：?view=flow&wbstab=dev&project=ID
    const q = new URLSearchParams(location.search);
    if (q.get('view') && VIEWS[q.get('view')]) S.view = q.get('view');
    if (q.get('wbstab')) S.wbsTab = q.get('wbstab');
    if (q.get('arttab')) S.artTab = q.get('arttab');
    if (q.get('artifact')) S.artifact = q.get('artifact');
    if (q.get('stage')) S.stage = q.get('stage');
    if (q.get('module')) S.module = q.get('module');
    if (q.get('project')) S.project = q.get('project');
  } catch {}
  paintNavIcons();
  render();
  try {
    const es = new EventSource('/api/stream');
    es.onopen = () => { const el = document.getElementById('liveText'); el.dataset.i18n = 'top.live'; el.textContent = t('top.live'); };
    es.onmessage = () => scheduleReload();
    es.onerror = () => { const el = document.getElementById('liveText'); el.dataset.i18n = 'top.reconnecting'; el.textContent = t('top.reconnecting'); };
    window.addEventListener('pagehide', () => { try { es.close(); } catch {} });   // 页面走了就主动断开，别占着同源并发槽
  } catch {}
})();
