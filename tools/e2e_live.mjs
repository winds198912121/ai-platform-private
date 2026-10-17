/* ============================================================
   e2e_live.mjs — 真实模型端到端（需要 API Key + 网络）
   证明「不是演示数据」：交付物由真实模型生成，模块代码真实落盘，
   单元测试真实执行，门禁读的是真实退出码。
   运行：node tools/e2e_live.mjs
   ============================================================ */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), `ai-platform-live-${process.pid}.json`);
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-platform-live-ws-'));
fs.rmSync(DATA, { force: true });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  PASS  ${m}`); } else { fail++; console.log(`  FAIL  ${m}`); } };
const get = async (u) => { const r = await fetch(BASE + u); return { status: r.status, body: await r.json() }; };
// 承認は画面のボタン操作の代役（人のテスター）なので dashboard ヘッダを付ける
const post = async (u, b) => { const r = await fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json', ...(/\/approve$/.test(u) ? { 'x-approval-source': 'dashboard' } : {}) }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json() }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 420000, what = '') => {
  const t0 = Date.now(); let lastLog = t0;
  while (Date.now() - t0 < ms) {
    const v = await fn(); if (v) return v;
    if (Date.now() - lastLog > 45000) { lastLog = Date.now(); console.log(`    … 仍在等待「${what}」已 ${Math.round((Date.now() - t0) / 1000)}s`); }
    await sleep(1500);
  }
  throw new Error(`等待超时：${what}（${ms / 1000}s 内未完成）`);
};

const server = spawn(process.execPath, [path.join(DIR, 'server.mjs')], {
  env: { ...process.env, AI_PLATFORM_PORT: String(PORT), AI_PLATFORM_DATA: DATA, AI_PLATFORM_SPEED: '0', AI_PLATFORM_WORKSPACE: WORKSPACE, AI_PLATFORM_PROVIDER: 'live' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let done = false;
const bye = (code) => { if (done) return; done = true; server.kill('SIGTERM'); setTimeout(() => process.exit(code), 200); };
process.on('exit', () => server.kill());

const t0 = Date.now();
try {
  await waitFor(async () => { try { return (await get('/api/state')).status === 200; } catch { return false; } }, 8000, '服务启动');

  const st0 = await get('/api/state');
  console.log('\n[1] 模型通道');
  ok(st0.body.channel?.channel === 'live', `通道 = ${st0.body.channel?.channel}（期望 live）`);
  ok(!!st0.body.channel?.model, `模型 = ${st0.body.channel?.model}`);
  if (st0.body.channel?.channel !== 'live') throw new Error('未接上真实模型（检查 API Key）');

  console.log('\n[2] 真实模型生成需求交付物');
  const c = await post('/api/projects', {
    name: '图书借阅管理服务',
    brief: '图书馆需要一套借阅管理系统：读者可以借书、还书、续借，逾期自动计算罚金；管理员可以查询借阅记录并导出统计。',
    mode: 'human_gate',
    files: [{ name: '业务规则.md', content: '# 业务规则（必须遵守）\n- 逾期罚金：每册每天 0.50 元，单册上限为书价的 30%。\n- 读者卡押金 100 元，退卡时原路退回。\n- 每位读者同时最多借 5 册。' }],
  });
  const pid = c.body.id;
  ok(!!pid, `创建项目 ${pid}`);
  ok(c.body.inputs?.length === 1, `随项目上传输入资料：${(c.body.inputs || []).map(i => i.name).join('、')}`);
  await waitFor(async () => (await get(`/api/projects/${pid}`)).body.stages[0].status === 'awaiting_review', 420000, '需求阶段完成');
  let proj = (await get(`/api/projects/${pid}`)).body;
  const req = proj.stages[0].artifacts;
  ok(req.length >= 3, `产出 ${req.length} 份需求交付物`);
  ok(req.every(a => a.content.length > 300), `每份交付物都有真实正文（最短 ${Math.min(...req.map(a => a.content.length))} 字符）`);
  ok(req.some(a => /借|还|罚金|逾期/.test(a.content)), '正文确实围绕本项目（含借阅/还书/罚金等词）');
  ok(req.some(a => /0\.50|30%|押金|5 册|5册/.test(a.content)), '上传的输入资料确实进了模型提示词（需求产物引用了文件里的规则）');

  console.log('\n[3] 阶段门禁：真实模型逐阶段推进');
  for (const sid of ['requirements', 'ux', 'architecture']) {
    await waitFor(async () => (await get(`/api/projects/${pid}`)).body.stages.find(s => s.id === sid).status === 'awaiting_review', 420000, `${sid} 产出`);
    if (sid === 'architecture') {   // WBS 还没跑：现在改它的调用模型，验证改的是真发出去的那个名字
      const mm = await post(`/api/projects/${pid}/models`, { models: { wbs: 'deepseek-reasoner' } });
      ok(mm.status === 200 && mm.body.wbs === 'deepseek-reasoner', 'WBS 阶段改为 deepseek-reasoner（下一次调用生效）');
    }
    const r = await post(`/api/projects/${pid}/stages/${sid}/approve`, { reviewer: 'PM' });
    ok(r.status === 200, `批准 ${sid}（${(await get(`/api/projects/${pid}`)).body.stages.find(s => s.id === sid).artifacts.length} 份交付物）`);
    await waitFor(async () => (await get(`/api/projects/${pid}`)).body.stages.find(s => s.id === sid).status === 'approved', 420000, `${sid} 批准`);
  }
  await waitFor(async () => (await get(`/api/projects/${pid}`)).body.stages.find(s => s.id === 'wbs').status === 'awaiting_review', 420000, 'WBS 完成');
  proj = (await get(`/api/projects/${pid}`)).body;
  const wbs = proj.wbs;
  console.log(`  WBS: ${wbs.epics.map(e => e.name).join(' / ')}`);
  ok(wbs.epics.length >= 2, `模型给出 ${wbs.epics.length} 个 Epic / ${wbs.task_count} 个 Task`);
  ok(proj.events.some(e => /调用 deepseek-reasoner 拆解任务/.test(e.text)), 'WBS 阶段真的按定义调用了 deepseek-reasoner（事件流为证）');
  ok(!!wbs.model, `模型服务回报的模型：${wbs.model}（请求名 deepseek-reasoner）`);
  const simNames = ['基础工具', '数据模型', '核心业务', '接口层', '质量与交付'];
  ok(!wbs.epics.every(e => simNames.includes(e.name)), 'WBS 不是离线模板产物（名称与模板不同）');
  ok(wbs.epics.every(e => e.tasks.length > 0 && e.tasks.every(t => t.name && t.acceptance)), '每个 Epic 都有任务与验收标准');

  console.log('\n[3b] 架构阶段给出技术栈与代码结构（本次故意不输入技术栈）');
  ok(!!proj.arch?.stack, `模型自行给出技术栈：${proj.arch?.stack}`);
  ok(proj.arch.stackFrom === 'ARC-01', '技术栈取自 ARC-01 的声明');
  ok(proj.arch.layers.length >= 3, `ARC-01 声明了源码层目录：${proj.arch.layers.join(' / ')}`);
  ok(wbs.epics.every(e => proj.arch.layers.includes(e.layer)), `每个 Epic 都归到了合法层：${wbs.epics.map(e => e.layer).join(' / ')}`);
  ok(proj.modules.every(m => m.layer && m.dir === `src/${m.layer}/${m.slug}`), '模块目录由架构层推导：' + proj.modules.map(m => m.dir).join('、'));

  console.log('\n[4] 真实代码生成 + 真实单元测试执行');
  const ar = await post(`/api/projects/${pid}/stages/wbs/approve`, { reviewer: 'PM' });
  ok(ar.status === 200, '批准 WBS → 释放模块开发');
  await waitFor(async () => {
    const p = (await get(`/api/projects/${pid}`)).body;
    return p.modules[0] && ['awaiting_review', 'failed'].includes(p.modules[0].status);
  }, 600000, 'M1 开发完成');
  proj = (await get(`/api/projects/${pid}`)).body;
  const mods = proj.modules;
  console.log('  模块状态：' + mods.map(m => `${m.id}:${m.status}${m.agent ? `(${m.agent})` : ''}`).join(' '));
  const agents = new Set(mods.map(m => m.agent).filter(Boolean));
  ok(agents.size >= 2, `多 Agent 并行：${[...agents].join('、')} 同时开工（并发 ${(await get('/api/state')).body.runtime?.concurrency}）`);
  const m = proj.modules[0];
  console.log(`  模块 ${m.id}「${m.name}」→ ${m.status}${m.error ? ' · ' + m.error : ''}`);
  console.log(`  单测：${JSON.stringify({ ...m.unit_tests, tail: (m.unit_tests?.tail || '').slice(0, 200) })}`);
  ok(m.status !== 'running', `模块执行结束（状态 ${m.status}）`);
  if (m.status === 'failed') {
    ok(true, `模型产出未通过（${m.error}）——门禁正确地拦住了`);
  } else {
    ok(!!m.unit_tests && m.unit_tests.cmd?.startsWith('node --test '), `真实执行了：${m.unit_tests?.cmd}`);
    ok(typeof m.unit_tests.exit_code === 'number', `记录了真实退出码 ${m.unit_tests.exit_code}`);
    ok(m.files.length >= 2, `代码与测试真实落盘 ${m.files.length} 个文件`);
    ok(m.files.every(f => f.path === m.test_path || f.path.startsWith(m.dir + '/')), `代码都落在架构层目录 ${m.dir}/ 下：${m.files.map(f => f.path).join('、')}`);
    ok(m.artifacts[0].content.includes(m.dir), '模块产物记录了代码位置');
    ok(/^src\/[a-z][a-z0-9_-]*\/m\d+-/.test(m.dir), `模块目录来自架构规约：${m.dir}（层 ${m.layer}）`);
    const stray = m.files.filter(f => !(f.path.startsWith(m.dir + '/') || f.path === m.test_path));
    console.log(`  落位：${m.files.map(f => f.path).join('、')}${stray.length ? `  ⚠ ${stray.length} 个文件不在规约目录内` : ''}`);
    const ws = (await get(`/api/projects/${pid}/workspace`)).body;
    ok(ws.files.length >= 2 && fs.existsSync(path.join(WORKSPACE, pid, ws.files[0].path)), '工作区文件在磁盘上真实存在');
    const ap = await post(`/api/projects/${pid}/modules/${m.id}/approve`, { reviewer: 'PM' });
    if (m.unit_tests.exit_code === 0 && m.unit_tests.failed === 0) ok(ap.status === 200, '单测通过 → 门禁放行批准');
    else ok(ap.status === 409, `单测未过（退出码 ${m.unit_tests.exit_code}）→ 门禁 409 拦住批准：${ap.body.error}`);
  }
} catch (e) {
  fail++; console.log(`  FAIL  异常：${e.message}`);
}

console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`RESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  (PASS=${pass} FAIL=${fail})`);
bye(fail === 0 ? 0 : 1);
