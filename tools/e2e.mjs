/* ============================================================
   e2e.mjs — 端到端验收：真起一个服务，用 HTTP 走完整流程
   （创建 → 阶段执行 → 门禁强制 → 批准/驳回 → 模块单测 → 全流程完成）
   运行：node tools/e2e.mjs
   ============================================================ */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), `ai-platform-e2e-${process.pid}.json`);
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-platform-e2e-ws-'));
fs.rmSync(DATA, { force: true });

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  PASS  ${msg}`); } else { fail++; console.log(`  FAIL  ${msg}`); } };

const get = async (u) => { const r = await fetch(BASE + u); return { status: r.status, body: await r.json() }; };
// 承認は画面のボタン操作の代役（人のテスター）なので dashboard ヘッダを付ける
const post = async (u, b) => { const r = await fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json', ...(/\/approve$/.test(u) ? { 'x-approval-source': 'dashboard' } : {}) }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json() }; };
const put = async (u, b) => { const r = await fetch(BASE + u, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json() }; };
const del = async (u) => { const r = await fetch(BASE + u, { method: 'DELETE' }); return { status: r.status, body: await r.json() }; };
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 60)); } throw new Error('等待超时'); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(DIR, 'server.mjs')], {
  env: { ...process.env, AI_PLATFORM_PORT: String(PORT), AI_PLATFORM_DATA: DATA, AI_PLATFORM_SPEED: '0', AI_PLATFORM_PROVIDER: 'sim', AI_PLATFORM_WORKSPACE: WORKSPACE },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let done = false;
const bye = (code) => { if (done) return; done = true; server.kill('SIGTERM'); setTimeout(() => process.exit(code), 200); };
process.on('exit', () => server.kill());

try {
  // 等待服务就绪
  await waitFor(async () => { try { return (await get('/api/state')).status === 200; } catch { return false; } }, 8000);
  console.log('\n[1] 服务与静态资源');
  ok(true, `GET /api/state 返回 200`);
  const page = await fetch(BASE + '/');
  ok(page.status === 200 && /AI Dev Platform/.test(await page.text()), 'GET / 返回平台首页 index.html');
  const js = await fetch(BASE + '/app.js');
  ok(js.status === 200 && (await js.text()).length > 5000, '静态资源 /app.js 正常');
  const tm = await fetch(BASE + '/tree.mjs');
  ok(tm.status === 200 && (tm.headers.get('content-type') || '').includes('javascript'),
    `/tree.mjs 以 JS 模块 MIME 提供（${tm.headers.get('content-type')}）——否则整页白屏`);

  // SSE
  const ac = new AbortController();
  const sse = await fetch(BASE + '/api/stream', { signal: ac.signal });
  const reader = sse.body.getReader();
  const first = await reader.read();
  ac.abort();
  ok(sse.headers.get('content-type').includes('text/event-stream') && /^data:/.test(new TextDecoder().decode(first.value)), 'GET /api/stream 返回 SSE 事件流');

  console.log('\n[2] 项目入口：创建（人工审批模式）');
  const c1 = await post('/api/projects', {
    name: '订单管理系统', brief: '支持订单创建、查询、审批与统计', tech: 'Next.js + NestJS + PostgreSQL', mode: 'human_gate',
    files: [
      { name: '需求背景.md', content: '# 背景\n订单需要三级审批，经理可批量处理。' },
      { name: 'legacy/api-spec.yaml', content: 'openapi: 3.0.0\npaths: {}' },
    ],
  });
  ok(c1.status === 200 && c1.body.id, `POST /api/projects 创建成功 (${c1.body.id})`);
  ok(c1.body.inputs?.length === 2, `随项目上传 ${c1.body.inputs?.length} 份输入资料：${(c1.body.inputs || []).map(i => i.name).join('、')}`);
  const pid = c1.body.id;
  const inFile = await get(`/api/projects/${pid}/file?path=${encodeURIComponent('inputs/需求背景.md')}`);
  ok(/订单需要三级审批/.test(inFile.body.content), '输入资料真实落盘且可读回');

  await waitFor(async () => (await get(`/api/projects/${pid}`)).body.stages[0].status === 'awaiting_review');
  let proj = (await get(`/api/projects/${pid}`)).body;
  ok(proj.stages[0].status === 'awaiting_review', '第一个阶段执行完停在「等待审核」');
  ok(proj.stages[0].artifacts.length >= 3, `阶段产出交付物 ${proj.stages[0].artifacts.length} 份`);
  ok(proj.stages[1].status === 'pending', '后续阶段不被自动执行');

  console.log('\n[2b] 产物可编辑并保存（未批准时）');
  const ed = await post(`/api/projects/${pid}/artifacts/REQ-01`, { content: '# 人工改过的需求规格\n\n补充：逾期罚金上限 100 元，超限冻结借阅。' });
  ok(ed.status === 200 && ed.body.version >= 2, `编辑产物成功（v${ed.body.version}，edited=${ed.body.edited?.count}）`);
  const disk = await get(`/api/projects/${pid}/file?path=${encodeURIComponent('docs/01-需求分析/REQ-01.md')}`);
  ok(/逾期罚金上限/.test(disk.body.content), '编辑内容真实写入工作区文件');
  const wf = await put(`/api/projects/${pid}/file`, { path: 'docs/01-需求分析/REQ-01.md', content: '# 工作区直改\n\n由人工直接编辑文件。' });
  ok(wf.status === 200, '工作区文件可编辑保存（PUT /file）');
  const disk2 = await get(`/api/projects/${pid}/file?path=${encodeURIComponent('docs/01-需求分析/REQ-01.md')}`);
  ok(/工作区直改/.test(disk2.body.content), '工作区文件保存后读回一致');

  console.log('\n[2c] 各阶段调用模型：可定义，不定义走缺省 deepseek');
  const st0 = await get('/api/state');
  ok(st0.body.default_model === 'deepseek-v4-flash', `/api/state 报出缺省模型 ${st0.body.default_model}`);
  ok(Array.isArray(st0.body.stages) && st0.body.stages.length === 8, `/api/state 暴露 ${st0.body.stages?.length} 个阶段（供界面逐阶段定义）`);
  ok(!proj.models || Object.keys(proj.models).length === 0, '新建项目默认没有任何阶段模型定义');
  const mm = await post(`/api/projects/${pid}/models`, { models: { wbs: 'deepseek-reasoner', development: 'deepseek-chat', 'not-a-stage': 'x', deployment: '   ' } });
  ok(mm.status === 200 && mm.body.wbs === 'deepseek-reasoner' && mm.body.development === 'deepseek-chat', `按阶段定义模型生效：${JSON.stringify(mm.body)}`);
  ok(!('not-a-stage' in mm.body), '未知阶段 id 被忽略（只认流水线阶段）');
  ok(!('deployment' in mm.body), '空白值 = 不定义 → 回到缺省 deepseek');
  proj = (await get(`/api/projects/${pid}`)).body;
  ok(proj.models?.wbs === 'deepseek-reasoner' && !proj.models.requirements, `定义随项目持久化，未定义的阶段（requirements）仍走缺省：${JSON.stringify(proj.models)}`);
  const off = await post(`/api/projects/${pid}/models`, { models: { wbs: '' } });
  ok(!('wbs' in off.body), '传空串即删除该阶段定义（回到缺省）');
  ok((await get(`/api/projects/${pid}`)).body.events.some(e => /阶段调用模型/.test(e.text)), '模型变更写进事件流（可追溯）');

  console.log('\n[2d] 技能库：增删改 + 校验 + 事件留痕（HTTP 往返）');
  const sk0 = await get(`/api/projects/${pid}`);
  ok(Array.isArray(sk0.body.skills) && sk0.body.skills.length === 0, '新建项目技能库为空');
  const skAdd = await post(`/api/projects/${pid}/skills`, { name: '禁止第三方依赖', body: '只允许 Node 内置模块；存储用内存对象。' });
  ok(skAdd.status === 200 && skAdd.body.id === 'SK-1' && skAdd.body.name === '禁止第三方依赖', `新增技能落库：${JSON.stringify(skAdd.body)}`);
  ok(skAdd.body.stage === '', '不指定阶段 = 所有阶段');
  const skStage = await post(`/api/projects/${pid}/skills`, { name: '需求阶段专属', body: '需求要编号。', stage: 'requirements' });
  ok(skStage.body.stage === 'requirements', `阶段专属技能落库：${skStage.body.id} → ${skStage.body.stage}`);
  const skBadStage = await post(`/api/projects/${pid}/skills`, { name: '乱写阶段', body: 'x', stage: 'not-a-stage' });
  ok(skBadStage.body.stage === '', '未知阶段 id 归到「所有阶段」（不报错卡住）');
  await fetch(`${BASE}/api/projects/${pid}/skills/${skStage.body.id}`, { method: 'DELETE' });
  await fetch(`${BASE}/api/projects/${pid}/skills/${skBadStage.body.id}`, { method: 'DELETE' });   // 清掉，后面按 SK-1/SK-2 走
  const sk2 = await post(`/api/projects/${pid}/skills`, { name: '测试覆盖边界', body: '空输入与极值各一条断言。' });
  ok(sk2.body.id === 'SK-2', `增删后 id 续号不撞车：${sk2.body.id}`);
  const skUp = await fetch(`${BASE}/api/projects/${pid}/skills/SK-2`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '空输入、极值、错误分支各一条断言。' }) });
  ok(skUp.status === 200 && /错误分支/.test((await skUp.json()).body), 'PUT 改正文生效');
  const skBad = await post(`/api/projects/${pid}/skills`, { name: '', body: 'x' });
  ok(skBad.status === 400, '空名字 → 400 被拒');
  const skDel = await fetch(`${BASE}/api/projects/${pid}/skills/SK-1`, { method: 'DELETE' });
  const skDelBody = await skDel.json();
  ok(skDel.status === 200 && skDelBody.ok === true && skDelBody.count === 1, `DELETE 真删掉（剩 ${skDelBody.count} 条）`);
  const skMissing = await fetch(`${BASE}/api/projects/${pid}/skills/SK-1`, { method: 'DELETE' });
  ok(skMissing.status === 404, '重复删除 → 404');
  proj = (await get(`/api/projects/${pid}`)).body;
  ok(proj.skills.length === 1 && proj.skills[0].id === 'SK-2', `技能随项目持久化：${JSON.stringify(proj.skills.map(s => s.id))}`);
  ok(proj.events.some(e => /新增技能 SK-1/.test(e.text)) && proj.events.some(e => /删除技能 SK-1/.test(e.text)), '增/删都写进事件流');

  console.log('\n[2e] 预设技能库：目录 + 导入（HTTP 往返）');
  const catRes = await get('/api/skills/catalog');
  ok(catRes.status === 200 && catRes.body.skills.length >= 13, `GET /api/skills/catalog 返回 ${catRes.body.skills?.length} 条预设技能`);
  const catList = catRes.body.skills;
  ok(catList.every(c => c.id && c.name && c.body), '每条预设都有 id/name/正文');
  const devTechs = catList.filter(c => c.stage === 'development' && c.tech).map(c => c.tech);
  ok(['java-springboot', 'java-struts', 'nodejs', 'sap-cap-rap', 'python'].every(t => devTechs.includes(t)),
    `开发阶段有各栈专属技能：${devTechs.join('、')}`);
  const imp = await post(`/api/projects/${pid}/skills/import`, { ids: catList.filter(c => c.stage === 'development').map(c => c.id) });
  ok(imp.status === 200 && imp.body.added === catList.filter(c => c.stage === 'development').length,
    `导入开发阶段预设：${JSON.stringify(imp.body)}`);
  const imp2 = await post(`/api/projects/${pid}/skills/import`, { ids: ['dev-nodejs'] });
  ok(imp2.body.added === 0 && imp2.body.skipped === 1, '重复导入自动跳过（幂等）');
  const impAll = await post(`/api/projects/${pid}/skills/import`, {});
  ok(impAll.body.total === catList.length + 1,                      // 13 条预设 + 前面手写的那 1 条
    `不带 ids = 全部导入，共 ${impAll.body.total} 条（预设 ${catList.length} + 手写 1）`);
  const impBad = await post(`/api/projects/${pid}/skills/import`, { ids: ['没有这东西'] });
  ok(impBad.status === 404, '不存在的预设 id → 404');
  const projWithSkills = (await get(`/api/projects/${pid}`)).body;
  ok((projWithSkills.skills || []).some(s => /Spring Boot/.test(s.name) && s.stage === 'development'),
    '各栈技能按阶段落库（Spring Boot 那条挂在 development）');

  console.log('\n[3] 门禁强制');
  let r = await post(`/api/projects/${pid}/stages/ux/run`);
  ok(r.status === 409, '前序未批准时执行下一阶段 → 409（被服务端拒绝）');
  r = await post(`/api/projects/${pid}/stages/testing/approve`);
  ok(r.status === 409, '批准一个未在审核中的阶段 → 409');

  console.log('\n[4] 批准 / 驳回');
  r = await post(`/api/projects/${pid}/stages/requirements/approve`, { reviewer: 'PM' });
  ok(r.status === 200 && r.body.status === 'approved', '批准需求阶段成功');
  const locked = await post(`/api/projects/${pid}/artifacts/REQ-01`, { content: '批准后偷改' });
  ok(locked.status === 409, '已批准阶段的产物被锁定 → 409');
  await waitFor(async () => (await get(`/api/projects/${pid}`)).body.stages[1].status === 'awaiting_review');
  ok(true, '批准后自动释放下一阶段（UI/UX 已执行）');
  r = await post(`/api/projects/${pid}/stages/ux/reject`, { category: 'UX 问题', comment: '导航层级过深' });
  ok(r.status === 200, '驳回 UI/UX 阶段成功');
  await waitFor(async () => { const s = (await get(`/api/projects/${pid}`)).body.stages[1]; return s.status === 'awaiting_review' && s.attempts >= 2; });
  proj = (await get(`/api/projects/${pid}`)).body;
  ok(proj.stages[1].attempts === 2 && proj.stages[1].review.decision === 'rejected', '驳回后 Agent 重做（第 2 轮）并再次送审');

  console.log('\n[2f] 项目信息可编辑（改完持久化 + 事件留痕 + 幂等 + 校验）');
  const ep = await put(`/api/projects/${pid}`, { name: '订单管理系统 v2', tech: 'Node.js 22 + SQLite', brief: '支持订单创建、查询、两级审批与统计看板。', mode: 'auto' });
  ok(ep.status === 200 && ep.body.name === '订单管理系统 v2' && ep.body.mode === 'auto', `PUT /api/projects/:id 改完即生效：${ep.body.name} / 入口 ${ep.body.mode}`);
  proj = (await get(`/api/projects/${pid}`)).body;
  ok(proj.name === '订单管理系统 v2' && /统计看板/.test(proj.brief) && proj.tech === 'Node.js 22 + SQLite', '名称/需求/技术栈真的持久化（GET 读回一致）');
  ok(proj.events.some(e => /项目信息已编辑/.test(e.text) && /订单管理系统 → 订单管理系统 v2/.test(e.text)), '编辑写进事件流，含改名前后的名字');
  const evCount = proj.events.filter(e => /项目信息已编辑/.test(e.text)).length;
  await put(`/api/projects/${pid}`, { name: '订单管理系统 v2' });
  ok((await get(`/api/projects/${pid}`)).body.events.filter(e => /项目信息已编辑/.test(e.text)).length === evCount, '什么都没改 = 不写事件（幂等）');
  const epBad = await put(`/api/projects/${pid}`, { name: '  ' });
  ok(epBad.status === 400 && /不能为空/.test(epBad.body.error || ''), `空项目名被拒：${epBad.status} ${epBad.body.error}`);
  const keep = await put(`/api/projects/${pid}`, { brief: '只改需求，别的别动。' });
  ok(keep.body.name === '订单管理系统 v2' && keep.body.tech === 'Node.js 22 + SQLite', '只传一个字段时其余字段不动');
  const inp = await post(`/api/projects/${pid}/inputs`, { files: [{ name: '补充规则.md', content: '# 补充\n罚金上限 100 元，超限冻结借阅。' }] });
  ok(inp.status === 200 && inp.body.added === 1 && inp.body.inputs.length >= 1, `编辑里能补输入资料：补了 ${inp.body.added} 份，共 ${inp.body.inputs.length} 份`);
  const inRead = await get(`/api/projects/${pid}/file?path=${encodeURIComponent('inputs/补充规则.md')}`);
  ok(/罚金上限 100 元/.test(inRead.body.content), '补的资料真落盘到 workspace 且可读回');
  ok((await get(`/api/projects/${pid}`)).body.events.some(e => /补充输入资料 1 份/.test(e.text)), '补资料写进事件流');
  const inpBad = await post(`/api/projects/${pid}/inputs`, { files: [] });
  ok(inpBad.status === 400, `一个文件都没给 → ${inpBad.status}`);

  console.log('\n[2g] 项目类型 → 默认流程（HTTP 往返）');
  const stT = await get('/api/state');
  ok(Array.isArray(stT.body.types) && stT.body.types.length >= 5, `/api/state 报出 ${stT.body.types?.length} 个项目类型：${(stT.body.types || []).map(y => y.id).join('、')}`);
  ok(stT.body.types.every(y => Array.isArray(y.techs) && y.techs.length >= 2), `每个分类都带 ≥2 条技术栈建议：${stT.body.types.map(y => `${y.id}:${y.techs.length}`).join('、')}`);
  ok(stT.body.types.every(y => Array.isArray(y.skills) && y.skills.length >= 5 && Array.isArray(y.layers) && y.layers.length >= 3),
    `每个分类都配了技能包与目录规约：${stT.body.types.map(y => `${y.id}:${y.skills.length}技能/${y.layers.join('+')}`).join(' · ')}`);
  ok(stT.body.types.find(y => y.id === 'website').techs.some(x => /Vite/.test(x)), `网站分类的建议里有 React + Vite：${stT.body.types.find(y => y.id === 'website').techs.join(' ｜ ')}`);
  const tWeb = await post('/api/projects', { name: 'e2e-网站类型', brief: '内容站', type: 'website', mode: 'human_gate' });
  ok(tWeb.status === 200 && tWeb.body.type === 'website', `类型落库：${tWeb.body.type}`);
  ok(tWeb.body.arch?.from === 'type-default' && tWeb.body.arch.layers.join(',') === 'core,content,ui,app',
    `网站分类自带目录规约：${(tWeb.body.arch?.layers || []).join(' / ')}（${tWeb.body.arch?.from}）`);
  ok(tWeb.body.workflow === 'website' && tWeb.body.stages.map(s => s.id).join(',') === 'requirements,ux,architecture,wbs,development,testing,deployment',
    `网站类型带出 7 个阶段（不做运维）：${tWeb.body.stages.map(s => s.name).join(' → ')}`);
  const tCli = await post('/api/projects', { name: 'e2e-工具类型', brief: '命令行工具', type: 'cli', mode: 'human_gate' });
  ok(tCli.body.stages.length === 5 && !tCli.body.stages.some(s => s.id === 'ux'),
    `工具类型只有 5 个阶段、没有 UX：${tCli.body.stages.map(s => s.id).join(' → ')}`);
  ok(tCli.body.stages.length !== tWeb.body.stages.length, '不同类型 → 不同流程（阶段数就不一样）');
  const tOw = await post('/api/projects', { name: 'e2e-显式工作流', brief: 'b', type: 'website', workflow: 'design', mode: 'human_gate' });
  ok(tOw.body.type === 'website' && tOw.body.workflow === 'design' && tOw.body.stages.length === 4, '类型 + 显式工作流：显式的那条说了算');
  ok((await get(`/api/projects/${tWeb.body.id}`)).body.events.some(e => /类型：网站/.test(e.text)), '创建事件里写明类型');
  await waitFor(async () => (await get(`/api/projects/${tCli.body.id}`)).body.stages[0].status !== 'running', 30000, '改分类前等首阶段跑完');   // 运行中改分类按设计是 409，先等它落定
  const tKeep = await put(`/api/projects/${tCli.body.id}`, { name: 'e2e-改分类', type: 'website' });
  const tKeepStages = tKeep.body.stages || [];
  ok(tKeep.status === 200 && tKeep.body.name === 'e2e-改分类' && tKeep.body.type === 'website' && tKeep.body.workflow === 'website' && tKeepStages.length === 7,
    `编辑里改分类 → 按新流程重排阶段：${tKeep.body.type}/${tKeep.body.workflow} → ${tKeepStages.map(s => s.id).join(' → ')}${tKeepStages.length ? '' : `（响应 ${tKeep.status}：${JSON.stringify(tKeep.body).slice(0, 120)}）`}`);
  ok(tKeep.body.stages.filter(s => ['requirements', 'architecture', 'wbs', 'development', 'testing'].includes(s.id)).length === 5,
    '旧流程里对得上的 5 个阶段留在原位（状态与产物不丢）');
  ok((await get(`/api/projects/${tCli.body.id}`)).body.events.some(e => /重排为「网站 \/ 静态站」/.test(e.text)), '重排写进事件流（保留/新增/去掉都记下来）');
  for (const id of [tWeb.body.id, tCli.body.id, tOw.body.id]) {                 // 收掉这三个，别干扰后面的计数
    await waitFor(async () => (await get(`/api/projects/${id}`)).body.stages[0].status === 'awaiting_review', 30000, '首个阶段跑完');
    await del(`/api/projects/${id}`);
  }

  console.log('\n[5] WBS 分解与逐模块开发门禁');
  const c2 = await post('/api/projects', { name: '自动全流程项目', brief: '演示完整流水线（故意不给技术栈，看架构阶段会不会自己定）', mode: 'auto' });
  const pid2 = c2.body.id;
  await waitFor(async () => { const p = (await get(`/api/projects/${pid2}`)).body; return p.wbs.epics.length > 0; });
  proj = (await get(`/api/projects/${pid2}`)).body;
  ok(proj.wbs.epics.length >= 4 && proj.wbs.task_count >= 8, `WBS 分解：${proj.wbs.epics.length} Epic / ${proj.wbs.task_count} Task`);
  ok(proj.modules.length === proj.wbs.epics.length, `生成等量开发模块 ${proj.modules.length} 个`);

  await waitFor(async () => { const p = (await get(`/api/projects/${pid2}`)).body; return p.stages.every(s => s.status === 'approved'); }, 60000);
  proj = (await get(`/api/projects/${pid2}`)).body;
  ok(proj.stages.filter(s => s.status === 'approved').length === 8, '全流程 8 个阶段全部批准');
  ok(proj.modules.every(m => m.status === 'approved'), '全部模块通过门禁批准');
  ok(proj.modules.every(m => m.unit_tests && m.unit_tests.failed === 0 && m.unit_tests.exit_code === 0 && m.unit_tests.total > 0), '每个模块的真实 node --test 均为 FAIL=0 且退出码 0');
  const unitTotal = proj.modules.reduce((a, m) => a + m.unit_tests.total, 0);
  ok(unitTotal > 0, `累计真实执行的单元测试 ${unitTotal} 条`);
  ok(proj.events.length > 10, `执行事件流 ${proj.events.length} 条（过程可视）`);
  const agents = new Set(proj.modules.map(m => m.agent).filter(Boolean));
  ok(agents.size >= 2, `多 Agent 并行开发：${[...agents].join('、')}`);
  ok(/Dev-Agent-2 领取模块/.test(proj.events.map(e => e.text).join('\n')), '事件流里有第二个 Agent 领取模块的记录');
  ok(!!proj.modules.every(m => m.unit_tests), '每个模块都有单元测试记录');

  console.log('\n[6] 真实执行证据：文件落盘 + 真跑测试');
  const ws = (await get(`/api/projects/${pid2}/workspace`)).body;
  ok(ws.files.length >= proj.modules.length * 2, `工作区真实落盘 ${ws.files.length} 个文件`);
  const testFile = ws.files.find(f => /\.test\.mjs$/.test(f.path));
  ok(!!testFile, `工作区存在测试文件：${testFile ? testFile.path : '无'}`);
  const testSrc = (await get(`/api/projects/${pid2}/file?path=${encodeURIComponent(testFile.path)}`)).body;
  ok(/node:test/.test(testSrc.content) && /assert/.test(testSrc.content), '测试文件内容真实可用（import node:test + assert）');
  ok(fs.existsSync(path.join(WORKSPACE, pid2, testFile.path)), '该文件在磁盘上真实存在（服务端目录）');
  fs.writeFileSync(path.join(WORKSPACE, pid2, '.DS_Store'), 'finder junk');      // Finder 垃圾不该出现在文件浏览器里
  const ws2 = (await get(`/api/projects/${pid2}/workspace`)).body;
  ok(!ws2.files.some(f => /(^|\/)\./.test(f.path)), `工作区列表不列点文件（.DS_Store 等，共 ${ws2.files.length} 个）`);
  const srcFiles = ws2.files.filter(f => /\.(mjs|js|ts)$/.test(f.path));
  ok(srcFiles.length >= 2, `工作区里有 ${srcFiles.length} 个可浏览的源码文件（供「源码」模块用）`);
  const srcFile = ws.files.find(f => /^src\/.*\.mjs$/.test(f.path));
  const srcSrc = (await get(`/api/projects/${pid2}/file?path=${encodeURIComponent(srcFile.path)}`)).body;
  ok(/export (function|const)/.test(srcSrc.content), `源码文件含真实导出：${srcFile.path}`);
  // 架构规约：模块源码直接落进 ARC-01 声明的层目录 src/<层>/（不再建模块子目录），文件名带模块号，测试镜像到同层
  const layer = srcFile.path.split('/')[1];
  ok(/^src\/[a-z][a-z0-9_-]*\/[^/]+\.mjs$/.test(srcFile.path), `源码直接落在层目录里（没有模块子目录）：${srcFile.path}`);
  ok(!/\/m\d+-/.test(srcFile.path), '路径里不再出现「一个模块一个目录」的 m<NN>- 段');
  ok(!/^m?\d/i.test(srcFile.path.split('/').pop()), `文件名不带 WBS 序号：${srcFile.path.split('/').pop()}`);
  ok((await get(`/api/projects/${pid2}`)).body.arch?.layers?.includes(layer), `层「${layer}」来自架构阶段声明的规约`);
  ok(testFile.path.startsWith(`test/${layer}/`), `单元测试镜像到同层目录：${testFile.path}`);
  const rep = proj.stages.find(s => s.id === 'testing').artifacts.find(a => a.id === 'TST-02');
  ok(!!rep && /PASS=\d+/.test(rep.content) && /node --test/.test(rep.content), '集成测试报告记录的是真实命令与结果');
  ok(!!proj.stages.find(s => s.id === 'deployment').artifacts.find(a => a.id === 'DPL-02'), '部署阶段产出真实构建校验报告（语法检查）');
  ok(proj.provider === 'sim' || proj.provider === 'live', `项目记录了执行通道：${proj.provider}`);
  const m0 = proj.modules[0];
  ok(m0.unit_tests.cmd.startsWith('node --test '), `模块单测命令为真实命令：${m0.unit_tests.cmd}`);
  ok(!!proj.arch?.stack && proj.arch.stackFrom === 'ARC-01', `未给技术栈时由架构阶段给出：${proj.arch?.stack}`);
  ok(/^\*\*代码位置\*\*/m.test(m0.artifacts[0].content) || m0.artifacts[0].content.includes('**代码位置**'), '模块产物里记录了代码位置');
  ok(m0.artifacts[0].content.includes(m0.dir), `产物里的代码位置与实际落盘一致：${m0.dir}`);
  ok(m0.layer && m0.dir === `src/${m0.layer}`, `模块目录 = 架构层目录（不再有模块子目录）：${m0.dir}`);
  const sameLayer = proj.modules.filter(m => m.dir === m0.dir);
  const names = sameLayer.flatMap(m => m.files.map(f => f.path.split('/').pop()));
  ok(new Set(names).size === names.length, `同层多模块文件名不重名：${sameLayer.map(m => m.id).join('、')} → ${names.join('、')}`);
  ok(sameLayer.every(m => m.files.every(f => !/^m?\d/i.test(f.path.split('/').pop()))),
    '同层每个文件名都是业务语义命名（不带 WBS 序号）');
  ok(!proj.events.some(e => /不符合层目录规则/.test(e.text)), `没有规约偏差告警（模型都按层目录直落）：${(proj.events.find(e => /不符合层目录规则/.test(e.text)) || {}).text || '—'}`);
  const lockedFile = await put(`/api/projects/${pid2}/file`, { path: srcFile.path, content: '// 批准后偷改\n' });
  ok(lockedFile.status === 409, '已批准模块的代码被锁定 → 409');

  console.log('\n[7] 重新构建项目：清空产物与执行记录 / 工作区生成物，技能与输入资料保留');
  await post(`/api/projects/${pid2}/skills`, { name: '重建保留检查', body: '这条技能必须活过重新构建' });
  const rbBefore = (await get(`/api/projects/${pid2}`)).body;
  const artsBefore = rbBefore.stages.reduce((a, s) => a + s.artifacts.length, 0) + rbBefore.modules.reduce((a, m) => a + m.artifacts.length, 0);
  const evBefore = rbBefore.events.length;
  const rb = await post(`/api/projects/${pid2}/rebuild`, {});
  ok(rb.status === 200 && rb.body.cleared.artifacts === artsBefore && rb.body.cleared.events === evBefore,
    `POST /rebuild 记账并清空：${artsBefore} 份产物 / ${evBefore} 条执行记录（残留 ${rb.body.cleared.artifacts} / ${rb.body.cleared.events}）`);
  ok(rb.body.kept.skills === rbBefore.skills.length, `技能全部保留（${rb.body.kept.skills} 条）`);
  const rbAfter = (await get(`/api/projects/${pid2}`)).body;
  ok(rbAfter.stages.every(s => s.status === 'pending' && !s.artifacts.length), '阶段回到未开始、产物清空');
  ok(rbAfter.modules.length === 0 && rbAfter.wbs.epics.length === 0 && rbAfter.arch?.from === 'type-default',
    `模块 / WBS 清空，目录规约回到分类自带的那套：${(rbAfter.arch?.layers || []).join(' / ')}`);
  ok(rbAfter.events.length === 1 && rbAfter.events[0].kind === 'rebuild', `历史痕迹只剩重建这一条：${rbAfter.events[0].text.slice(0, 40)}…`);
  ok(rbAfter.skills.some(s => s.name === '重建保留检查'), '技能保留（新加的那条也在）');
  ok(!fs.existsSync(path.join(WORKSPACE, pid2, 'docs')) && !fs.existsSync(path.join(WORKSPACE, pid2, 'src')), 'workspace 里的 docs/ 与 src/ 真被删掉');
  ok((await get(`/api/projects/${pid2}/workspace`)).body.files.length === 0, '工作区文件列表清空');

  console.log('\n[7b] 删除项目');
  const delRes = await del(`/api/projects/${pid2}`);
  ok(delRes.status === 200 && delRes.body.deleted === pid2, `DELETE 项目成功（剩余 ${delRes.body.remaining} 个）`);
  const after = await get('/api/state');
  ok(!after.body.projects.some(x => x.id === pid2), '项目已从列表移除');
  ok(fs.existsSync(path.join(WORKSPACE, pid2)) === false, 'workspace 目录已一并删除');
  ok((await del(`/api/projects/${pid2}`)).status === 200, '重复删除同一项目幂等（仍 200）');

  console.log('\n[8] 技术栈 → 语言档案：Java 项目真的产出并跑 .java，CAP 项目额外产出 CDS');
  const driveToFirstModule = async (tech, label) => {
    const c = await post('/api/projects', { name: label, brief: '订单管理模块', tech, mode: 'human_gate' });
    const id = c.body.id;
    for (const sid of ['requirements', 'ux', 'architecture']) {
      await waitFor(async () => (await get(`/api/projects/${id}`)).body.stages.find(s => s.id === sid).status === 'awaiting_review', 30000);
      await post(`/api/projects/${id}/stages/${sid}/approve`, { reviewer: 'PM' });
    }
    await waitFor(async () => (await get(`/api/projects/${id}`)).body.stages.find(s => s.id === 'wbs').status === 'awaiting_review', 30000);
    await post(`/api/projects/${id}/stages/wbs/approve`, { reviewer: 'PM' });
    await post(`/api/projects/${id}/stages/development/run`);
    return await waitFor(async () => {
      const q = (await get(`/api/projects/${id}`)).body;
      return q.modules[0] && ['awaiting_review', 'failed'].includes(q.modules[0].status) ? q : null;
    }, 90000);
  };

  const jproj = await driveToFirstModule('Java 21 + Spring Boot 3.3 + PostgreSQL 16', 'e2e-java');
  const jm = jproj.modules[0];
  ok(jproj.arch.profile === 'java' && /Java 21/.test(jproj.arch.stack), `Java 技术栈判成语言档案 java：${jproj.arch.stack}`);
  ok(jm.dir.startsWith('src/main/java/'), `源码按 Maven 目录规约：${jm.dir}`);
  ok(new RegExp(`^src/test/java/${jm.layer}/\\S+Test\\.java$`).test(jm.test_path_planned) && !/^m?\\d/i.test(jm.test_path_planned.split('/').pop()),
    `测试按 Maven 目录规约、文件名 = 测试类名且不带 WBS 序号：${jm.test_path_planned}`);
  ok(jm.files.length && jm.files.every(f => f.path.endsWith('.java')), `产出的是 .java（${jm.files.map(f => f.path).join('、')}）`);
  const jmSrc = jm.files.filter(f => f.path !== jm.test_path_planned && f.path !== jm.test_path);
  ok(jmSrc.length && jmSrc.every(f => f.path.startsWith(`${jm.dir}/`) && !f.path.slice(jm.dir.length + 1).includes('/') && !/^m?\d/i.test(f.path.split('/').pop())),
    `Java 源码直落层目录、文件名 = 业务类名、不带 WBS 序号（${jmSrc.map(f => f.path).join('、')}）`);
  ok(!jm.files.some(f => f.path.endsWith('.mjs')), 'Java 项目不再产出 .mjs');
  ok(/^javac /.test(jm.unit_tests.cmd) && /java -cp/.test(jm.unit_tests.cmd), `单测真的走 javac + java：${jm.unit_tests.cmd}`);
  ok(jm.unit_tests.exit_code === 0 && jm.unit_tests.passed > 0 && jm.unit_tests.failed === 0,
    `javac/java 真跑通过：PASS=${jm.unit_tests.passed} FAIL=${jm.unit_tests.failed} 退出码=${jm.unit_tests.exit_code}`);
  ok(fs.existsSync(path.join(WORKSPACE, jproj.id, jm.test_path)), '测试类真落盘到 src/test/java/');
  ok(/语言档案/.test(jm.artifacts[0].content), '模块产物里记录了语言档案');

  const cproj = await driveToFirstModule('SAP CAP Java', 'e2e-cap');
  const cm = cproj.modules[0];
  ok(cproj.arch.profile === 'cap-java', 'SAP CAP + Java → 语言档案 cap-java');
  const cdsFiles = ['db/schema.cds', 'srv/order-service.cds'];
  ok(cdsFiles.every(f => fs.existsSync(path.join(WORKSPACE, cproj.id, f))), `CAP 项目产出真实 CDS 文件：${cdsFiles.join('、')}`);
  ok(/CDS/.test(cm.artifacts[0].content), '模块产物里带 CDS 结构性校验小节');

  const sproj = await driveToFirstModule('HTML5 + CSS3 + 原生 JavaScript（ES Modules）静态站点', 'e2e-js-static');
  const sm = sproj.modules[0];
  ok(sproj.arch.profile === 'node', `JS 静态站判成语言档案 node（不是 java）：${sproj.arch.stack}`);
  ok(sm.files.length && sm.files.every(f => /\.(mjs|js)$/.test(f.path)), `产出的是 .mjs/.js：${sm.files.map(f => f.path).join('、')}`);
  ok(!sm.files.some(f => f.path.endsWith('.java')), 'JS 项目一个 .java 都不产');
  ok(!sm.files.some(f => f.path.includes('src/main/java/')), `源码落在 src/<层>/（${sm.dir}）`);
  ok(/node --test/.test(sm.unit_tests.cmd || ''), `单测走 node --test：${sm.unit_tests.cmd}`);
  ok(sm.unit_tests.exit_code === 0 && sm.unit_tests.failed === 0 && sm.unit_tests.passed > 0,
    `node --test 真跑通过：PASS=${sm.unit_tests.passed} FAIL=${sm.unit_tests.failed} 退出码=${sm.unit_tests.exit_code}`);
} catch (e) {
  fail++; console.log(`  FAIL  異常：${e.message}`);
}

console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  (PASS=${pass} FAIL=${fail})`);
bye(fail === 0 ? 0 : 1);
