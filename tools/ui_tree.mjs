/* ============================================================
   ui_tree.mjs — 源码文件浏览器（左树 + 右预览/编辑）的真实浏览器检查
   自包含：自己拉起隔离服务 + 自己的 headless Chrome，跑完清理。
   用法：node tools/ui_tree.mjs
   判据：断言全过 + 无未捕获异常（模块加载失败＝整页白屏，靠这条抓）
   ============================================================ */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isSource } from '../public/tree.mjs';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8802, CDP_PORT = 9225;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DATA = path.join(os.tmpdir(), `aip-tree-${process.pid}.json`);
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-tree-ws-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-tree-chrome-'));
const OUT = path.join(DIR, 'out');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  PASS  ${m}`)) : (fail++, console.log(`  FAIL  ${m}`)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 40000, what = '') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); }
  throw new Error(`等待超时：${what}`);
};
const cleanup = () => {
  try { chrome?.kill('SIGKILL'); } catch {}
  try { server?.kill('SIGKILL'); } catch {}
  // Chrome 收尾时还在往 profile 里写文件，rm 会撞 ENOTEMPTY——重试几次，实在删不掉就留给系统清 tmp
  for (const d of [PROFILE, WORKSPACE]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch { /* 下次开机由 tmp 清理 */ } }
  try { fs.rmSync(DATA, { force: true }); } catch { /* 同上 */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Google Chrome が見つからず、UI 検査をスキップ（http://127.0.0.1:9225 で手動起動も可）');
  process.exit(0);
}

/* ---------- 1. 隔离服务 + 一个跑完的真实工作区（离线通道，秒级） ---------- */
const server = spawn(process.execPath, [path.join(DIR, 'server.mjs')], {
  env: { ...process.env, AI_PLATFORM_PORT: String(PORT), AI_PLATFORM_DATA: DATA, AI_PLATFORM_WORKSPACE: WORKSPACE,
         AI_PLATFORM_PROVIDER: 'sim', AI_PLATFORM_SPEED: '0' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
await waitFor(async () => { try { return (await fetch(BASE + '/api/state')).ok; } catch { return false; } }, 20000, '服务就绪');

// 承認は画面のボタン操作の代役（人のテスター）なので dashboard ヘッダを付ける
const post = async (u, b) => (await fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json', ...(/\/approve$/.test(u) ? { 'x-approval-source': 'dashboard' } : {}) }, body: JSON.stringify(b || {}) })).json();
const jget = async (u) => (await fetch(BASE + u)).json();
const proj = await post('/api/projects', { name: 'UI 源码管理检查', brief: '借阅管理：借书/还书/逾期罚金。', mode: 'human_gate' });
// 人工审批模式：放行到开发阶段，这样模块停在「待批准」→ 源码可编辑（已批准会锁定，另有专门断言）
for (const sid of ['requirements', 'ux', 'architecture', 'wbs']) {
  await waitFor(async () => (await jget(`/api/projects/${proj.id}`)).stages.find(s => s.id === sid).status === 'awaiting_review', 60000, `${sid} 待审核`);
  await post(`/api/projects/${proj.id}/stages/${sid}/approve`, { reviewer: 'UI-检查' });
}
await waitFor(async () => ((await jget(`/api/projects/${proj.id}/workspace`)).files || []).length >= 3, 60000, '工作区有文件');
const wsFiles = (await (await fetch(`${BASE}/api/projects/${proj.id}/workspace`)).json()).files;
console.log(`\n[1] 隔离服务就绪：${proj.id} · 工作区 ${wsFiles.length} 个文件（${wsFiles.slice(0, 3).map(f => f.path).join('、')}…）`);
ok(wsFiles.every(f => f.path.includes('/')), '工作区文件带目录层级（树才有意义）');

/* ---------- 2. headless Chrome ---------- */
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok; } catch { return false; } }, 30000, 'Chrome 就绪');

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
let id = 0; const waits = new Map(); const exceptions = []; const dialogs = [];
const send = (method, params = {}) => new Promise(r => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '未知异常');
  // 页面里的 alert 会卡住 CDP（evaluate 永不返回）——必须自动关掉，顺手把文案记下来当证据
  if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message || ''); ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); }
  if (m.id && waits.has(m.id)) { waits.get(m.id)(m.result); waits.delete(m.id); }
});
await new Promise(r => ws.addEventListener('open', r));
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1150, deviceScaleFactor: 1, mobile: false });

const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
};
const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
// 按 data-file 路径点文件行（路径含 / 与中文，用查找而不是拼选择器）
const clickFile = (p) => ev(`(() => { const e = [...document.querySelectorAll('.trow.file')].find(x => x.dataset.file === ${JSON.stringify(p)});
  const r = [...document.querySelectorAll('.trow.dir')].find(x => ${JSON.stringify(p)}.startsWith(x.dataset.dir + '/'));
  if (r && r.querySelector('.tri').textContent === '▸') r.click();                 // 父目录若收起先展开
  const e2 = [...document.querySelectorAll('.trow.file')].find(x => x.dataset.file === ${JSON.stringify(p)});
  if (!e2) return false; e2.click(); return true; })()`);
const setEdit = (text) => ev(`(() => { const t = document.querySelector('[data-edit-area]'); if (!t) return false;
  t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);   // 真人的输入会触发 input，页面靠它同步草稿
const getText = (text) => ev(`(() => { const t = document.querySelector('[data-edit-area]'); return t ? t.value : null; })()`);
const fileRow = (p) => ev(`[...document.querySelectorAll('.trow.file')].some(e => e.dataset.file === ${JSON.stringify(p)})`);

console.log('\n[2] 打开「产物 → 工作区文件」，检查左树 / 右预览');
await send('Page.navigate', { url: `${BASE}/?view=artifacts&arttab=files&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelectorAll('.trow').length > 0`), 20000, '文件树渲染');
await sleep(400);
const dirs = await ev(`document.querySelectorAll('.trow.dir').length`);
const files = await ev(`document.querySelectorAll('.trow.file').length`);
const maxIndent = await ev(`Math.max(...[...document.querySelectorAll('.trow')].map(e => parseInt(e.style.paddingLeft) || 0))`);
ok(dirs > 0, `左侧渲染出 ${dirs} 个目录节点`);
ok(files >= 3, `左侧渲染出 ${files} 个文件节点`);
ok(maxIndent > 8, `存在嵌套层级（最大缩进 ${maxIndent}px）`);
ok(await ev(`document.querySelectorAll('.trow')[0].classList.contains('dir')`), '第一行是目录（根节点在前）');
ok(await ev(`(() => {
  const f = document.querySelectorAll('.trow.file')[0];
  const d = document.querySelectorAll('.trow.dir')[0].getBoundingClientRect();
  return d.top < f.getBoundingClientRect().top && parseInt(f.style.paddingLeft) > 8;
})()`), '目录行在其文件之前，文件按层缩进（padding-left 控制层级）');
ok(await ev(`document.querySelector('.trow .tri') !== null`), '目录行有展开/收起指示');
const docDirNames = await ev(`[...document.querySelectorAll('.trow.dir .nm')].map(e => e.textContent.trim()).filter(n => /^[0-9]{2}-/.test(n))`);
ok(docDirNames.length > 0, `docs 目录名按「流程序号-流程名」：${docDirNames.join('、') || '（没找到）'}`);
ok(await ev(`[...document.querySelectorAll('.card header .kicker')][1].textContent === 'workspace/${proj.id}'`),
  '中栏标题标出 workspace/<项目ID>');

console.log('\n[3] 点目录收起 / 点文件预览 / 点编辑改源码');
const before = await ev(`document.querySelectorAll('.trow').length`);
const rootDir = await ev(`document.querySelector('.trow.dir').dataset.dir`);
await click('.trow.dir');
await sleep(500);
const after = await ev(`document.querySelectorAll('.trow').length`);
ok(after < before, `点目录收起：行数 ${before} → ${after}`);
ok(await ev(`document.querySelector('.trow.dir').textContent.includes('▸')`), '收起后指示箭头变为 ▸');
await click('.trow.dir');
await sleep(500);
ok(await ev(`document.querySelectorAll('.trow').length`) === before, `再点展开：行数回到 ${before}`);

const firstFile = await ev(`([...document.querySelectorAll('.trow.file')].find(e => /^src\\//.test(e.dataset.file)) || {}).dataset?.file || ''`);
ok(!!firstFile, `树里能找到源码文件：${firstFile}`);
await clickFile(firstFile);
await waitFor(async () => await ev(`document.querySelector('.card pre') !== null`), 10000, '文件内容加载');
const shown = await ev(`document.querySelector('.card pre').textContent.length`);
ok(shown > 0, `右侧预览出真实内容（${shown} 字符）：${firstFile}`);
const real = (await (await fetch(`${BASE}/api/projects/${proj.id}/file?path=${encodeURIComponent(firstFile)}`)).json()).content || '';
ok(await ev(`document.querySelector('.card pre').textContent.trim() === ${JSON.stringify(real.trim())}`), '预览内容与服务端读到的文件逐字一致');
await shot('17-workspace-tree.png');

ok(await click('[data-edit-file]'), '未批准模块的源码可点「✎ 编辑」进入编辑态');
ok(await ev(`document.querySelector('[data-edit-area]') !== null`), '编辑态渲染出文本域');
ok(await getText() === real, '文本域里就是该文件的真实内容');
ok(await setEdit(real + '\n// UI 检查标记 ' + Date.now()), `可在文本域里改源码`);
await shot('18-workspace-edit.png');
ok(await click('[data-cancel-edit]'), '点「取消」退出编辑态（不写盘）');

console.log('\n[4] 「源码」模块：只列产出代码（不含 docs/、不含点文件），右预览/编辑');
await send('Page.navigate', { url: `${BASE}/?view=code&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelectorAll('.trow').length > 0`), 20000, '源码树渲染');
await sleep(400);
const srcPaths = await ev(`[...document.querySelectorAll('.trow.file')].map(e => e.dataset.file)`);
const srcDirs = await ev(`[...document.querySelectorAll('.trow.dir')].map(e => e.dataset.dir)`);
ok(srcPaths.length >= 3, `源码树列出 ${srcPaths.length} 个文件`);
ok(srcPaths.every(p => isSource(p)), `列出的全是产出源码（无文档/点文件）：${srcPaths.slice(0, 3).join('、')}…`);
ok(!srcDirs.includes('docs') && !srcPaths.some(p => p.includes('.DS_Store')), '没有 docs/ 文档与 .DS_Store 垃圾');
ok(srcDirs.includes('src') && srcDirs.includes('test'), `源码按层与测试分树：${srcDirs.filter(d => !d.includes('/')).join(' / ')}`);
ok(await ev(`document.querySelector('.card .kv') && /归属模块|工作区/.test(document.querySelectorAll('.card')[2].textContent)`),
  '元数据栏显示归属模块/模块状态/单测');
ok(await ev(`/最后产出/.test(document.querySelector('.page-head').textContent)`), '页头写明这是「最后产出」的源码');
const codeFile = await ev(`document.querySelector('.trow.file.sel')?.dataset.file || ''`);
ok(!!codeFile && isSource(codeFile), `默认打开一个源码文件：${codeFile}`);
const codeReal = (await (await fetch(`${BASE}/api/projects/${proj.id}/file?path=${encodeURIComponent(codeFile)}`)).json()).content || '';
ok(await ev(`document.querySelector('.card pre').textContent.trim() === ${JSON.stringify(codeReal.trim())}`), '右侧预览与服务端源码逐字一致');
const codeDirInfo = await ev(`document.querySelectorAll('.card')[2].textContent`);
ok(/归属模块/.test(codeDirInfo) && /M\d/.test(codeDirInfo), `元数据栏给出该文件归属的模块：${(codeDirInfo.match(/归属模块[\s\S]{0,24}/) || [''])[0].replace(/\s+/g, ' ').trim()}`);
await shot('20-source-module.png');

console.log('\n[5] 源码可编辑保存（未批准模块）：改 → 保存 → 落盘 + 自动重跑真实单测');
const pj0 = await jget(`/api/projects/${proj.id}`);
const mod0 = pj0.modules.find(m => m.status !== 'approved' && (m.files || []).length);
ok(!!mod0, `找到一个未批准的模块：${mod0 ? `${mod0.id}「${mod0.name}」(${mod0.status})` : '无'}`);
const target = (mod0.files.find(f => !/\.test\.mjs$/.test(f.path)) || mod0.files[0]).path;
ok(await clickFile(target), `在源码树里选中该模块的文件：${target}`);
await waitFor(async () => await ev(`document.querySelector('.card pre') !== null`), 10000, '源码加载');
const oldContent = (await jget(`/api/projects/${proj.id}/file?path=${encodeURIComponent(target)}`)).content;
const beforeTests = mod0.unit_tests ? mod0.unit_tests.at : null;
ok(await click('[data-edit-file]'), '点「✎ 编辑」进入编辑态');
await waitFor(async () => await ev(`document.querySelector('[data-edit-area]') !== null`), 8000, '编辑态文本域出现');   // 点了不一定同步就有（SSE 重渲染在飞时）
const marker = `// UI 保存标记 ${Date.now()}`;
ok(await setEdit(oldContent + '\n' + marker), '在文本域里写入改动');
ok(await click('[data-save-file]'), '点「保存文件」');
await waitFor(async () => !(await ev(`document.querySelector('[data-edit-area]') !== null`)), 20000, '保存后退出编辑态');
const saved = (await jget(`/api/projects/${proj.id}/file?path=${encodeURIComponent(target)}`)).content;
ok(String(saved).includes(marker), '接口读回的文件已含新改动（保存真的生效）');
ok(fs.readFileSync(path.join(WORKSPACE, proj.id, target), 'utf8').includes(marker), '工作区磁盘上的文件也含改动（不是只改内存）');
ok(await ev(`document.querySelector('.card pre').textContent.includes(${JSON.stringify(marker)})`), '右侧预览立刻显示保存后的内容');
const mod1 = (await jget(`/api/projects/${proj.id}`)).modules.find(m => m.id === mod0.id);
ok(!!mod1.unit_tests && String(mod1.unit_tests.cmd).startsWith('node --test'), `改码后自动重跑了真实单测：${mod1.unit_tests?.cmd}`);
ok(mod1.unit_tests.at !== beforeTests, `单测记录已刷新（${beforeTests || '无'} → ${mod1.unit_tests.at}）`);
ok(mod1.status !== 'approved', `模块仍停在「${mod1.status}」——改过的代码不会被当成已批准`);
ok(dialogs.some(d => /已保存并重跑该模块单测/.test(d)), `保存后页面提示：${dialogs.find(d => /已保存/.test(d)) || '（无）'}`);
await shot('23-source-save.png');

console.log('\n[6] 已批准模块锁定：界面不给改，绕过界面直接写也被服务端拒（409）');
const ap = await fetch(`${BASE}/api/projects/${proj.id}/modules/${mod0.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-approval-source': 'dashboard' }, body: JSON.stringify({ reviewer: 'UI-检查' }) });
ok(ap.status === 200, `批准模块 ${mod0.id}（HTTP ${ap.status}）`);
await send('Page.navigate', { url: `${BASE}/?view=code&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelectorAll('.trow').length > 0`), 20000, '重新渲染源码树');
await clickFile(target);
await sleep(700);
ok(!(await ev(`document.querySelector('[data-edit-file]') !== null`)), '已批准模块的文件不再有「编辑」按钮');
ok(await ev(`/已批准 · 已锁定/.test(document.querySelectorAll('.grid.g-tree > .card')[1].textContent)`), '界面显示「模块已批准 · 已锁定」');
const force = await fetch(`${BASE}/api/projects/${proj.id}/file`, { method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: target, content: 'x' }) });
const forceBody = await force.json().catch(() => ({}));
ok(force.status === 409, `绕过界面直接 PUT 也被拒：HTTP ${force.status}「${forceBody.error || ''}」`);

console.log('\n[7] 矮窗口自适应：两栏跟着窗口高度走，内容超出各自出滚动条');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 520, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=code&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelectorAll('.trow').length > 0`), 20000, '矮窗口下源码树渲染');
await sleep(500);
const fit = await ev(`(() => {
  const cards = [...document.querySelectorAll('.grid.g-tree > .card')];
  const tree = cards[0].querySelector('.body'), code = cards[1].querySelector('.body');
  const bottom = Math.max(...cards.map(c => Math.round(c.getBoundingClientRect().bottom)));
  const bar = (el) => el.offsetWidth - el.clientWidth;          // 占位式滚动条会吃掉宽度，覆盖式不会（= 看得见）
  return { innerH: window.innerHeight, pageScroll: document.documentElement.scrollHeight, bottom, innerW: window.innerWidth, docW: document.documentElement.scrollWidth,
    treeScroll: [tree.clientHeight, tree.scrollHeight], codeScroll: [code.clientHeight, code.scrollHeight],
    treeBar: bar(tree), codeBar: bar(code), treeOverflow: getComputedStyle(tree).overflowY, codeOverflow: getComputedStyle(code).overflowY };
})()`);
ok(fit.pageScroll <= fit.innerH + 2, `页面本身不滚（文档高 ${fit.pageScroll} ≤ 窗口 ${fit.innerH}）——高度交给两栏`);
ok(fit.bottom <= fit.innerH + 2, `三栏底部 ${fit.bottom} 不超出窗口 ${fit.innerH}（卡片高度被窗口约束）`);
ok(fit.treeOverflow === 'auto' && fit.codeOverflow === 'auto', `两栏 overflow:auto（${fit.treeOverflow}/${fit.codeOverflow}）`);
ok(fit.treeScroll[1] > fit.treeScroll[0], `目录树内容(高 ${fit.treeScroll[1]})超出可视(高 ${fit.treeScroll[0]})→ 出滚动条`);
ok(fit.codeScroll[1] > fit.codeScroll[0], `源码区内容(高 ${fit.codeScroll[1]})超出可视(高 ${fit.codeScroll[0]})→ 出滚动条`);
ok(fit.treeBar >= 8 && fit.codeBar >= 8, `两栏滚动条真的占位、看得见（目录树 ${fit.treeBar}px / 源码区 ${fit.codeBar}px）`);
ok(fit.docW <= fit.innerW + 2, `加了滚动条也不横向溢出（文档宽 ${fit.docW} ≤ 窗口 ${fit.innerW}）`);
ok(await ev(`document.querySelector('.grid.g-tree > .card > header').getBoundingClientRect().height > 0
  && document.querySelector('.grid.g-tree > .card:nth-child(2) .body').getBoundingClientRect().height > 200`),
  '卡片头与内容区都还在（没被压成 0）');
await shot('21-code-fit-short.png');

console.log('\n[7.5] 高窗口：左树跟着窗口长高（不被 460px 封顶，卡片内不留大片空白）');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=code&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelectorAll('.trow').length > 0`), 20000, '高窗口下源码树渲染');
await sleep(500);
const tall = await ev(`(() => {
  const card = document.querySelector('.grid.g-tree > .card');
  const head = card.querySelector('header'), body = card.querySelector('.body');
  return { innerH: window.innerHeight, cardH: Math.round(card.getBoundingClientRect().height),
    headH: Math.round(head.getBoundingClientRect().height), bodyH: Math.round(body.getBoundingClientRect().height),
    bodyMaxH: getComputedStyle(body).maxHeight, slack: Math.round(card.getBoundingClientRect().height - head.getBoundingClientRect().height - body.getBoundingClientRect().height) };
})()`);
ok(tall.bodyH > 460, `高窗口(${tall.innerH})下目录树高度 ${tall.bodyH}px 突破 tablewrap 的 460px 上限（max-height=${tall.bodyMaxH}）`);
ok(tall.slack <= 2, `目录树填满卡片剩余高度（卡片 ${tall.cardH} - 卡头 ${tall.headH} - 树 ${tall.bodyH} = 留白 ${tall.slack}px）`);
ok(tall.cardH >= tall.innerH - 200, `卡片高度跟着窗口走（卡片 ${tall.cardH} vs 窗口 ${tall.innerH}）`);
await shot('24-code-fit-tall.png');

console.log('\n[8] 窄窗口（单栏折叠）：整页自己滚，不横向溢出，卡片不被压扁');
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=code&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelectorAll('.trow').length > 0`), 20000, '窄窗口下源码树渲染');
await sleep(500);
const narrow = await ev(`(() => {
  const page = document.querySelector('.page');
  const cards = [...document.querySelectorAll('.grid.g-tree > .card')];
  return { pageScroll: [page.clientHeight, page.scrollHeight], docScroll: document.documentElement.scrollHeight,
    innerH: window.innerHeight, docW: document.documentElement.scrollWidth, innerW: window.innerWidth,
    cols: getComputedStyle(document.querySelector('.grid.g-tree')).gridTemplateColumns.split(' ').length,
    minCardH: Math.min(...cards.map(c => Math.round(c.getBoundingClientRect().height))) };
})()`);
ok(narrow.docScroll <= narrow.innerH + 2, '窄屏文档不滚动（滚动交给页面区）');
ok(narrow.pageScroll[1] > narrow.pageScroll[0], `窄屏页面区自己滚（${narrow.pageScroll[1]} > ${narrow.pageScroll[0]}）`);
ok(narrow.cols === 1, `窄屏折成单栏（grid 列数 ${narrow.cols}）`);
ok(narrow.docW <= narrow.innerW + 2, `窄屏无横向溢出（${narrow.docW} ≤ ${narrow.innerW}）`);
ok(narrow.minCardH >= 100, `窄屏每张卡片仍有高度（最小 ${narrow.minCardH}px）`);
await shot('22-code-fit-narrow.png');

console.log('\n[8.5] 各阶段调用模型：阶段详情里定义，未定义显示「缺省 deepseek」');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=flow&stage=wbs&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelector('[data-stage-model]') !== null`), 20000, '阶段模型选择器渲染');
const sel0 = await ev(`(() => { const s = document.querySelector('[data-stage-model="wbs"]');
  return { id: s.dataset.stageModel, value: s.value, text: s.options[s.selectedIndex].textContent, opts: s.options.length,
    all: [...document.querySelectorAll('[data-stage-model]')].map(x => x.dataset.stageModel) }; })()`);
ok(sel0.id === 'wbs' && sel0.all.length === 1, `只有当前阶段的模型选择器（${sel0.all.join('、')}）`);
const defModel = (await jget('/api/state')).default_model;
ok(sel0.value === '' && /缺省/.test(sel0.text) && sel0.text.includes(defModel), `WBS 未定义时落在「${sel0.text}」（${sel0.opts} 个选项，缺省模型 = ${defModel}）`);
ok(await ev(`[...document.querySelector('[data-stage-model="wbs"]').options].some(o => o.value === '${defModel}')`), `下拉里有缺省模型 ${defModel} 可选`);
ok(await ev(`(() => { const s = document.querySelector('[data-stage-model="wbs"]');
  s.value = 'deepseek-reasoner'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), '在界面里把 WBS 阶段切成 deepseek-reasoner');
await waitFor(async () => ((await jget(`/api/projects/${proj.id}`)).models || {}).wbs === 'deepseek-reasoner', 20000, '模型定义落库');
ok(true, '改动通过 POST /api/projects/:id/models 真实落库');
await sleep(600);
ok(await ev(`document.querySelector('[data-stage-model="wbs"]').value === 'deepseek-reasoner'`), '重渲染后选中项跟着变（不再是缺省）');
const evs = ((await jget(`/api/projects/${proj.id}`)).events || []).filter(e => /阶段调用模型/.test(e.text));
ok(evs.some(e => /阶段调用模型：WBS 分解/.test(e.text)), `事件流记录这次变更：${evs.at(-1)?.text || '（无）'}`);
await shot('25-stage-models.png');

console.log('\n[8.7] 侧栏顺序 = 数字快捷键顺序（04 产物 / 05 源码）');
await send('Page.navigate', { url: `${BASE}/?view=projects&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelector('#nav .navbtn') !== null`), 20000, '侧栏渲染');
const rail = await ev(`[...document.querySelectorAll('#nav .navbtn')].map(b => ({ v: b.dataset.view, ic: b.querySelector('.ic').textContent, lb: b.querySelector('.lb').textContent }))`);
ok(rail[4].v === 'artifacts' && rail[4].ic === '04' && rail[5].v === 'code' && rail[5].ic === '05',
  `侧栏 04/05 = 产物/源码（实际 ${rail[4].ic} ${rail[4].lb} → ${rail[5].ic} ${rail[5].lb}）`);
await waitFor(async () => await ev(`document.querySelectorAll('#nav .navbtn .nico svg').length === 8`), 8000, '侧栏图标注入（app.js 是 module，晚于静态 HTML 落地）');
const railIco = await ev(`(() => [...document.querySelectorAll('#nav .navbtn')].map(b => { const s = b.querySelector('.nico svg'); const r = s && s.getBoundingClientRect(); const ic = b.querySelector('.ic'); return { v: b.dataset.view, has: !!s, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0, num: ic.textContent, before: !!(s && (s.compareDocumentPosition(ic) & Node.DOCUMENT_POSITION_FOLLOWING)), lb: b.querySelector('.lb').textContent.trim() }; }))()`);
ok(railIco.length === 8 && railIco.every(x => x.has && x.w === 15 && x.h === 15),
  `侧栏 8 项每项都有 15px 图标（缺的：${railIco.filter(x => !x.has).map(x => x.v).join('、') || '无'}）`);
ok(railIco.every(x => x.before && /^0\d$/.test(x.num)),
  `图标在序号前面：${railIco.slice(0, 5).map(x => `[${x.v}] 图标→${x.num}`).join(' · ')}`);
ok(railIco.every(x => x.lb.length > 0), `序号后面是菜单名，没被挤掉：${railIco.slice(0, 4).map(x => `${x.num} ${x.lb}`).join(' · ')}`);
for (const [n, expect] of [['5', 'artifacts'], ['6', 'code']]) {          // 数字键 1–7 按菜单位置（菜单角标从 00 起，差 1）
  // 按一次可能被 SSE 重渲染吃掉（本轮实测偶发一次），所以等条件 + 最多重按 4 次：判据仍是真行为，不是假绿
  let hit = false;
  for (let i = 0; i < 4 && !hit; i++) {
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${n}', bubbles: true }))`);
    hit = await waitFor(async () => await ev(`document.querySelector('#nav .navbtn[aria-current="page"]').dataset.view === '${expect}'`), 1500, `按键 ${n} → ${expect}`)
      .then(() => true).catch(() => false);
    if (!hit) await sleep(300);
  }
  ok(hit, `按 ${n} 键进菜单第 ${n} 项「${expect}」（跟菜单顺序一致）`);
}
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))`);
await sleep(300);

console.log('\n[8.8] 总览：阶段流水线 + 活动流吃满窗口高度');
const ovAt = async (h, w = 1680) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/?view=overview&project=${proj.id}` });
  await waitFor(async () => await ev(`document.querySelector('.grid.g-fill') !== null`), 20000, `总览渲染 @${w}x${h}`);
  await sleep(500);
  return await ev(`(() => {
    const g = document.querySelector('.grid.g-fill');
    const bodies = [...g.querySelectorAll(':scope > .card > .body')].map(b => ({ h: Math.round(b.getBoundingClientRect().height), ov: getComputedStyle(b).overflowY }));
    const p = document.querySelector('.page');
    return { cards: g.querySelectorAll(':scope > .card').length, cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,
      gridBottom: Math.round(g.getBoundingClientRect().bottom), gridH: Math.round(g.getBoundingClientRect().height),
      innerH: window.innerHeight, docH: document.documentElement.scrollHeight, pageCan: p.scrollHeight > p.clientHeight + 1, bodies };
  })()`);
};
const ovShort = await ovAt(1000), ovTall = await ovAt(1400), ovNarrow = await ovAt(800, 1000);
ok(ovShort.docH <= ovShort.innerH + 2, `总览页自己不滚（文档高 ${ovShort.docH} ≤ 窗口 ${ovShort.innerH}）——高度交给卡片`);
ok(ovShort.cols === 2 && ovShort.cards === 2, `两栏两卡（列数 ${ovShort.cols} / 卡 ${ovShort.cards}）`);
ok(ovShort.gridBottom <= ovShort.innerH + 2 && ovShort.innerH - ovShort.gridBottom <= 46,
  `网格吃到窗口底部（底 ${ovShort.gridBottom} vs 窗口 ${ovShort.innerH}，只留 ${ovShort.innerH - ovShort.gridBottom}px 页面内边距）`);
ok(ovShort.bodies.length === 2 && ovShort.bodies.every(b => b.ov === 'auto' && b.h > 300),
  `两张卡各自占满并 self-scroll（高 ${ovShort.bodies.map(b => b.h).join('/')}，overflow ${ovShort.bodies.map(b => b.ov).join('/')}）`);
ok(ovTall.gridH > ovShort.gridH + 300,
  `窗口长高卡片跟着长（网格高 ${ovShort.gridH} @1000 → ${ovTall.gridH} @1400）`);
ok(ovNarrow.cols === 1 && ovNarrow.bodies.length === 2 && ovNarrow.bodies.every(b => b.h <= 800 * 0.58 + 2 && b.ov === 'auto') && ovNarrow.pageCan,
  `窄屏折叠成单栏：每栏限高 58vh 自滚、整页再滚（栏高 ${ovNarrow.bodies.map(b => b.h).join('/')}，页面能滚 ${ovNarrow.pageCan}）`);

console.log('\n[8.9] 流程与门禁：「阶段详情 + 阶段交付物」也吃满窗口（开发阶段除外）');
const flowAt = async (stage, h, w = 1680) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/?view=flow&project=${proj.id}&stage=${stage}` });
  await waitFor(async () => await ev(`document.querySelector('.grid.g-1-2') !== null`), 20000, `流程页渲染 ${stage} @${w}x${h}`);
  await sleep(500);
  return await ev(`(() => {
    const g = document.querySelector('.grid.g-1-2');
    const cards = [...g.querySelectorAll(':scope > .card')];
    const body = (c) => { const b = c.querySelector('.body'); return { h: Math.round(b.getBoundingClientRect().height), ov: getComputedStyle(b).overflowY }; };
    const p = document.querySelector('.page');
    return { fill: g.classList.contains('g-fill'), heads: cards.map(c => c.querySelector('h2').textContent),
      cols: getComputedStyle(g).gridTemplateColumns.split(' ').length, devFill: !!document.querySelector('.grid.g-side.g-fill'),
      gridBottom: Math.round(g.getBoundingClientRect().bottom), win: window.innerHeight,
      pageCan: p.scrollHeight > p.clientHeight + 1, bodies: cards.map(body) };
  })()`);
};
const flShort = await flowAt('requirements', 1000), flTall = await flowAt('requirements', 1400);
const flDev = await flowAt('development', 1000), flNarrow = await flowAt('requirements', 800, 1000);
ok(flShort.fill && flShort.heads.length === 2, `两卡一网格（${flShort.heads.join(' + ')}）带 g-fill`);
ok(!flShort.pageCan && flShort.gridBottom <= flShort.win + 2 && flShort.win - flShort.gridBottom <= 46,
  `页面自己不滚、网格吃到窗口底部（底 ${flShort.gridBottom} vs 窗口 ${flShort.win}，只留 ${flShort.win - flShort.gridBottom}px）`);
ok(flShort.bodies.every(b => b.ov === 'auto' && b.h > 300), `两卡各自占满并 self-scroll（高 ${flShort.bodies.map(b => b.h).join('/')}）`);
ok(flTall.bodies[0].h > flShort.bodies[0].h + 300, `窗口长高卡片跟着长（${flShort.bodies[0].h} @1000 → ${flTall.bodies[0].h} @1400）`);
ok(!flDev.fill && flDev.pageCan && flDev.devFill,
  `开发阶段：上层两卡不套 g-fill（模块开发区块跟在网格下面），模块开发区块自己 g-fill、整页滚（页面能滚 ${flDev.pageCan}）`);
ok(flNarrow.cols === 1 && flNarrow.pageCan && flNarrow.bodies.every(b => b.h <= 800 * 0.58 + 2),
  `窄屏单栏：每栏限高 58vh 自滚、整页再滚（栏高 ${flNarrow.bodies.map(b => b.h).join('/')}）`);

console.log('\n[8.10] 开发页签：模块开发 + 模块详情也吃满窗口');
const devAt = async (h, w = 1680) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/?view=wbs&wbstab=dev&project=${proj.id}` });
  await waitFor(async () => await ev(`document.querySelector('.grid.g-side.g-fill') !== null`), 20000, `开发页渲染 @${w}x${h}`);
  await sleep(500);
  return await ev(`(() => {
    const g = document.querySelector('.grid.g-side.g-fill');
    const cards = [...g.querySelectorAll(':scope > .card')];
    const body = (c) => { const b = c.querySelector('.body'); return { h: Math.round(b.getBoundingClientRect().height), ov: getComputedStyle(b).overflowY }; };
    const p = document.querySelector('.page');
    return { heads: cards.map(c => c.querySelector('h2').textContent), cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,
      widths: cards.map(c => Math.round(c.getBoundingClientRect().width)),
      gridBottom: Math.round(g.getBoundingClientRect().bottom), win: window.innerHeight,
      pageCan: p.scrollHeight > p.clientHeight + 1, bodies: cards.map(body) };
  })()`);
};
const dvShort = await devAt(1000), dvTall = await devAt(1400), dvNarrow = await devAt(800, 1000);
ok(dvShort.heads.length === 2, `两卡（${dvShort.heads.join(' + ')}）`);
ok(!dvShort.pageCan && dvShort.gridBottom <= dvShort.win + 2 && dvShort.win - dvShort.gridBottom <= 46,
  `开发页自己不滚、网格吃到窗口底部（底 ${dvShort.gridBottom} vs 窗口 ${dvShort.win}，只留 ${dvShort.win - dvShort.gridBottom}px）`);
ok(dvShort.bodies.every(b => b.ov === 'auto' && b.h > 300), `两卡各自占满并 self-scroll（高 ${dvShort.bodies.map(b => b.h).join('/')}）`);
ok(Math.abs(dvShort.widths[0] / (dvShort.widths[0] + dvShort.widths[1]) - 0.4) <= 0.01,
  `模块开发 : 模块详情 = 4:6（${dvShort.widths.join(' / ')}）`);
const wbsTabs = await ev(`[...document.querySelectorAll('.tabs [data-wbstab]')].map(b => {
  const s = b.querySelector('.tico svg'), br = b.getBoundingClientRect(), sr = s && s.getBoundingClientRect();
  return { tab: b.dataset.wbstab, text: b.textContent.trim(), dir: getComputedStyle(b).flexDirection,
    w: Math.round(br.width), nowrap: getComputedStyle(b).whiteSpace, over: b.scrollWidth - b.clientWidth,
    icon: sr ? Math.round(sr.width) : 0, iconAbove: !!sr && (sr.top + sr.height / 2) < (br.top + br.height / 2) - 1 }; })`);
ok(wbsTabs.length === 2 && wbsTabs.every(x => x.icon >= 14 && x.text.length >= 3 && x.dir === 'column' && x.iconAbove),
  `WBS 顶部页签 = 图标在上、文字在下（${wbsTabs.map(x => `${x.tab}: ${x.icon}px ${x.dir} 图标在上=${x.iconAbove}「${x.text}」`).join('、')}）`);
ok(Math.abs(wbsTabs[0].w - wbsTabs[1].w) <= 1 && wbsTabs.every(x => x.nowrap === 'nowrap' && x.over <= 1),
  `两个页签等宽且文字一行（${wbsTabs.map(x => `${x.tab} ${x.w}px`).join(' = ')}，white-space ${wbsTabs[0].nowrap}，溢出 ${wbsTabs.map(x => x.over).join('/')}）`);
ok(dvTall.bodies[0].h > dvShort.bodies[0].h + 300, `窗口长高卡片跟着长（${dvShort.bodies[0].h} @1000 → ${dvTall.bodies[0].h} @1400）`);
const profRow = await ev(`(() => {
  const g = document.querySelector('.grid.g-side.g-fill');
  const t = [...g.querySelectorAll('.kv')].map(k => k.textContent).join(' | ');
  return { has: /语言档案/.test(t), label: ((t.match(/语言档案\\s*([^|]{0,32})/) || [])[1] || '').trim(),
    head: (g.querySelector('.card header .kicker')?.textContent || '').trim() };
})()`);
ok(profRow.has, `模块详情里显示语言档案：${profRow.label}`);
ok(/Node\.js|Java|Python|CAP/.test(profRow.head), `模块开发卡片头显示当前语言档案：${profRow.head}`);
ok(dvNarrow.cols === 1 && dvNarrow.pageCan && dvNarrow.bodies.every(b => b.h <= 800 * 0.58 + 2),
  `窄屏单栏：每栏限高 58vh 自滚、整页再滚（栏高 ${dvNarrow.bodies.map(b => b.h).join('/')}）`);

const treeAt = async (h, w = 1680) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/?view=wbs&wbstab=tree&project=${proj.id}` });
  await waitFor(async () => await ev(`document.querySelector('.grid.g-fill > .card > .body') !== null`), 20000, `任务树渲染 @${w}x${h}`);
  await sleep(500);
  return await ev(`(() => {
    const g = document.querySelector('.grid.g-fill'), b = g.querySelector('.card > .body'), p = document.querySelector('.page');
    return { cards: g.querySelectorAll(':scope > .card').length, gridBottom: Math.round(g.getBoundingClientRect().bottom),
      gridH: Math.round(g.getBoundingClientRect().height), win: window.innerHeight, ov: getComputedStyle(b).overflowY,
      bodyH: Math.round(b.getBoundingClientRect().height), pageCan: p.scrollHeight > p.clientHeight + 1 };
  })()`);
};
const trShort = await treeAt(1000), trTall = await treeAt(1400), trNarrow = await treeAt(800, 1000);
ok(trShort.cards === 1 && trShort.ov === 'auto', '任务树页签：单卡 fill 网格、卡片体自滚');
ok(!trShort.pageCan && trShort.gridBottom <= trShort.win + 2 && trShort.win - trShort.gridBottom <= 46,
  `任务树吃满窗口（底 ${trShort.gridBottom} vs 窗口 ${trShort.win}，只留 ${trShort.win - trShort.gridBottom}px）`);
ok(trTall.gridH > trShort.gridH + 300, `窗口长高任务树跟着长（${trShort.gridH} @1000 → ${trTall.gridH} @1400）`);
ok(!trNarrow.pageCan && trNarrow.win - trNarrow.gridBottom <= 34,
  `窄屏单卡也吃满（底 ${trNarrow.gridBottom} vs 窗口 ${trNarrow.win}，只留 ${trNarrow.win - trNarrow.gridBottom}px 内边距）`);

// 任务树状态着色 + 执行中的自动展开与动态指示灯（真跑一个模块去看）
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1200, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=wbs&wbstab=tree&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelector('.tnode.epic') !== null`), 20000, '任务树渲染');
const treeStat = await ev(`(() => {
  const epics = [...document.querySelectorAll('.tnode.epic')];
  const stOf = (el) => ({ st: el.dataset.status, pill: el.querySelector('.pill') ? getComputedStyle(el.querySelector('.pill')).color : '', edge: getComputedStyle(el).boxShadow });
  return { rows: epics.map(el => el.dataset.epic + ':' + el.dataset.status), legend: document.querySelectorAll('.legend .lg').length, first: epics.length ? stOf(epics[0]) : null };
})()`);
ok(treeStat.rows.length > 0 && treeStat.rows.every(r => /:/.test(r)), `每条 Epic 带状态标记：${treeStat.rows.join('、')}`);
ok(treeStat.legend >= 5, `树脚有状态色图例（${treeStat.legend} 项）`);

// 挑一个已批准模块：驳回 → 执行 → 期间任务树应自动展开并显示动态指示灯
const pjTree = await jget(`/api/projects/${proj.id}`);
// 取第一个「还没批准」的模块（按序：它前面的模块都已批准，所以能起跑；已批准的模块按设计不可驳回）
const tmod = pjTree.modules.find(m => m.status !== 'approved') || pjTree.modules[0];
if (tmod.status === 'awaiting_review') await post(`/api/projects/${proj.id}/modules/${tmod.id}/reject`, { category: '技术问题', comment: 'UI 检查：重跑看任务树指示灯' });
await send('Page.navigate', { url: `${BASE}/?view=wbs&wbstab=tree&project=${proj.id}` });
await post(`/api/projects/${proj.id}/modules/${tmod.id}/run`, {});
const stAfter = (await jget(`/api/projects/${proj.id}`)).modules.find(m => m.id === tmod.id);
ok(['running', 'awaiting_review', 'failed'].includes(stAfter.status), `驳回后重跑 ${tmod.id}：接口侧状态 ${stAfter.status}（第 ${stAfter.attempts} 轮）`);
await waitFor(async () => await ev(`document.querySelector('.tnode.epic.s-running .pulse') !== null`), 40000, '任务树出现执行中指示灯');
const liveRow = await ev(`(() => {
  const ep = document.querySelector('.tnode.epic.s-running');
  const dot = ep.querySelector('.pulse');
  const kids = [...ep.parentElement.querySelectorAll('.tnode.child.s-running')];
  const childDot = kids[0] ? kids[0].querySelector('.dot') : null;
  return { epic: ep.dataset.epic, expanded: ep.textContent.includes('▾'), kids: kids.length, kidsDots: kids.filter(k => k.querySelector('.dot')).length,
    anim: getComputedStyle(dot).animationName, dotBg: getComputedStyle(dot).backgroundColor,
    childAnim: childDot ? getComputedStyle(childDot).animationName : '', edge: getComputedStyle(ep).boxShadow };
})()`);
ok(liveRow.expanded && liveRow.kids > 0, `正在执行的 Epic 自动展开（${liveRow.epic}，子任务行 ${liveRow.kids}）`);
ok(liveRow.anim === 'pulse' && liveRow.dotBg === 'rgb(79, 157, 255)', `执行中带动态指示灯（动画 ${liveRow.anim}，蓝点 ${liveRow.dotBg}）`);
ok(liveRow.kidsDots === liveRow.kids && liveRow.childAnim === 'pulse', `子任务行同样有色点与呼吸动画（${liveRow.childAnim}）`);
await shot('55-tree-running.png');
await waitFor(async () => await ev(`document.querySelector('.tnode.epic.s-running .pulse') === null`), 40000, '模块跑完，指示灯消失');
const doneRow = await ev(`(() => { const row = [...document.querySelectorAll('.tnode.epic')].find(e => e.dataset.epic === '${tmod.epic}'); return row ? { st: row.dataset.status, text: row.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) } : null; })()`);
ok(doneRow && doneRow.st !== 'running', `跑完后状态换成待批准（${doneRow ? doneRow.st : '—'}／${doneRow ? doneRow.text : ''}）`);

console.log('\n[8.11] 项目界面：项目列表 + 新建表单也吃满窗口');
const pjAt = async (h, w = 1680) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/?view=projects` });
  await waitFor(async () => await ev(`document.querySelector('.grid.g-side.g-fill') !== null`), 20000, `项目页渲染 @${w}x${h}`);
  await sleep(500);
  return await ev(`(() => {
    const g = document.querySelector('.grid.g-side.g-fill');
    const cards = [...g.querySelectorAll(':scope > .card')];
    const body = (c) => { const b = c.querySelector('.body'); return { h: Math.round(b.getBoundingClientRect().height), ov: getComputedStyle(b).overflowY }; };
    const p = document.querySelector('.page');
    return { heads: cards.map(c => c.querySelector('h2').textContent), cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,
      gridBottom: Math.round(g.getBoundingClientRect().bottom), gridH: Math.round(g.getBoundingClientRect().height), win: window.innerHeight,
      pageCan: p.scrollHeight > p.clientHeight + 1, bodies: cards.map(body) };
  })()`);
};
const pjShort = await pjAt(1000), pjTall = await pjAt(1400), pjNarrow = await pjAt(800, 1000);
ok(pjShort.heads.length === 2, `两卡（${pjShort.heads.join(' + ')}）`);
ok(!pjShort.pageCan && pjShort.gridBottom <= pjShort.win + 2 && pjShort.win - pjShort.gridBottom <= 46,
  `项目页自己不滚、网格吃到窗口底部（底 ${pjShort.gridBottom} vs 窗口 ${pjShort.win}，只留 ${pjShort.win - pjShort.gridBottom}px）`);
ok(pjShort.bodies.every(b => b.ov === 'auto' && b.h > 300), `两卡各自占满并 self-scroll（高 ${pjShort.bodies.map(b => b.h).join('/')}）`);
ok(pjTall.bodies[0].h > pjShort.bodies[0].h + 300, `窗口长高卡片跟着长（${pjShort.bodies[0].h} @1000 → ${pjTall.bodies[0].h} @1400）`);
ok(pjNarrow.cols === 1 && pjNarrow.pageCan && pjNarrow.bodies.every(b => b.h <= 800 * 0.58 + 2),
  `窄屏单栏：每栏限高 58vh 自滚、整页再滚（栏高 ${pjNarrow.bodies.map(b => b.h).join('/')}）`);

// 项目卡排版：不显示概要，项目名占概要那一行、字号更大（概要不丢，收进悬停 title）
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1200, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=projects` });
await waitFor(async () => await ev(`document.querySelector('.proj-card .pname') !== null`), 20000, '项目卡渲染');
const cardUi = await ev(`(() => {
  const c = document.querySelector('.proj-card');
  const nm = c.querySelector('.pname'), st = c.querySelector('.mono.tiny.muted'), pill = c.querySelector('.pill');
  const f = (el) => parseFloat(getComputedStyle(el).fontSize);
  const r = (el) => el.getBoundingClientRect();
  return { hasBrief: !!c.querySelector('.brief'), name: nm.textContent.trim(), title: nm.getAttribute('title') || '',
    nmSize: f(nm), stSize: f(st), nameTop: Math.round(r(nm).top), pillBottom: Math.round(r(pill).bottom),
    nmW: Math.round(r(nm).width), cardW: Math.round(r(c).width) };
})()`);
ok(!cardUi.hasBrief, '项目卡不再显示概要');
ok(cardUi.title.length > 0, `概要收进悬停 title 不丢（${cardUi.title.slice(0, 16)}…）`);
ok(cardUi.nameTop >= cardUi.pillBottom, `项目名移到概要那一行（名字 top ${cardUi.nameTop} ≥ 模式标签底 ${cardUi.pillBottom}）`);
ok(cardUi.nmSize > cardUi.stSize && cardUi.nmSize >= 15, `项目名字号比统计行大：${cardUi.nmSize}px > ${cardUi.stSize}px`);
ok(cardUi.nmW > cardUi.cardW * 0.5, `项目名占整行宽度（${cardUi.nmW} / 卡片 ${cardUi.cardW}）`);
ok(await ev(`(() => { const c = document.querySelector('.proj-card'); const h = c.querySelector('.head'); return !h.querySelector('.mono') && /^P-/.test(c.querySelector('.pid').textContent.trim()); })()`),
  '模式标签与按钮独占一行、项目 ID 挪到统计行开头（不再把卡片标题行挤成两行）');

// 重新构建按钮：每个项目卡一个；点了先弹确认（讲清清什么 / 留什么），执行后阶段回未开始、技能保留
const rbProj = await post('/api/projects', { name: 'UI 重建检查', brief: '验证重新构建按钮', mode: 'human_gate' });
await post(`/api/projects/${rbProj.id}/skills`, { name: '重建要保留的技能', body: '重建后这条必须在' });
await send('Page.navigate', { url: `${BASE}/?view=projects` });
await waitFor(async () => await ev(`document.querySelector('[data-rebuild-project="${rbProj.id}"]') !== null`), 20000, '重建按钮出现');
const rbBtn = await ev(`(() => {
  const b = document.querySelector('[data-rebuild-project="${rbProj.id}"]');
  const cs = getComputedStyle(b);
  const r = b.getBoundingClientRect();
  b.click();
  return { text: b.textContent.trim(), title: b.getAttribute('title') || '', bg: cs.backgroundColor, fg: cs.color, w: Math.round(r.width) };
})()`);
await sleep(1500);
const rbDialog = dialogs[dialogs.length - 1] || '';
ok(rbBtn.bg !== 'rgba(0, 0, 0, 0)' && rbBtn.bg !== 'rgb(195, 60, 51)',
  `重新构建按钮有底色且与删除（红）区分开：${rbBtn.bg}`);
ok(/重新构建/.test(rbDialog) && /技能库 1 条/.test(rbDialog) && /不可恢复/.test(rbDialog),
  `点击前弹确认，写明清什么/留什么（首行：${rbDialog.split('\n')[0]}）`);
const rbAfter = await jget(`/api/projects/${rbProj.id}`);
ok(rbAfter.events.length === 1 && rbAfter.events[0].kind === 'rebuild', '重建真的执行了（历史痕迹只剩重建这一条）');
ok(rbAfter.stages.every(s => s.status === 'pending'), '重建后阶段回到未开始');
ok(rbAfter.skills.length === 1 && rbAfter.skills[0].name === '重建要保留的技能', '重建后技能保留');
await shot('52-rebuild-button.png');

console.log('\n[8.12] 技能库界面：新增 / 编辑 / 删除都真的落库');
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=skills&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelector('#skillForm') !== null`), 20000, '技能页渲染');
const skNav = await ev(`[...document.querySelectorAll('#nav .navbtn')].map(b => b.dataset.view)`);
ok(skNav.includes('skills') && (await ev(`document.querySelector('#nav .navbtn[data-view="skills"] .ic').textContent`)) === '07',
  `侧栏有 07 技能（顺序：${skNav.join(' → ')}）`);
ok(await ev(`/未|这个项目还没有技能|No skills/.test(document.querySelector('.grid.g-fill .body').textContent)`), '空库给出明确空态');

// 新增：填表 → 提交
// 填表（像真人一样：先聚焦再打字，触发 input 事件走草稿）
const setField = async (sel, val) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
  el.focus(); el.value = ${JSON.stringify(val)}; el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`);
await setField('#skillForm [name=name]', '禁止第三方依赖');
await setField('#skillForm [name=body]', '只允许 Node 内置模块；需要存储用内存对象。');
await setField('#skillForm [name=stage]', 'requirements');        // 只作用于「需求分析」阶段
ok(await ev(`document.querySelector('#skillForm [name=body]').tagName === 'TEXTAREA'`), '正文是多行输入框');
// 草稿抗重渲染：趁打字时触发一次真实 SSE 推送（改阶段模型），输入内容不能丢
await post(`/api/projects/${proj.id}/models`, { models: { wbs: 'deepseek-reasoner' } });
await sleep(1200);
ok(await ev(`document.querySelector('#skillForm [name=name]').value === '禁止第三方依赖'
  && /只允许 Node 内置模块/.test(document.querySelector('#skillForm [name=body]').value)
  && document.querySelector('#skillForm [name=stage]').value === 'requirements'`), 'SSE 重渲染后表单草稿还在（不丢用户输入）');
await ev(`document.querySelector('#skillForm button[type=submit]').click()`);   // 点真按钮（跟人一样）
await waitFor(async () => ((await jget(`/api/projects/${proj.id}`)).skills || []).length === 1, 20000, '技能落库');
const sk1Row = waitFor(async () => await ev(`(document.querySelector('[data-skill="SK-1"] .nm') || {}).textContent === '禁止第三方依赖'`), 5000, '技能行出现')
  .then(() => true).catch(() => false);
ok(await sk1Row, `列表里出现新技能 SK-1（实际「${await ev(`(document.querySelector('[data-skill="SK-1"] .nm') || {}).textContent ?? '(没这行)'`)}」）`);
ok(await ev(`document.querySelector('[data-skill-stage="requirements"]') !== null`), '列表里标出适用阶段');
const skStack = await ev(`(() => {
  const r = document.querySelector('[data-skill="SK-1"]');
  const n = r.querySelector('.nm'), s = r.querySelector('[data-skill-stage]');
  const a = n.getBoundingClientRect(), b = s.getBoundingClientRect();
  return { sameCol: Math.abs(a.left - b.left) < 4, below: b.top >= a.bottom - 2, stageText: s.textContent.trim(), h: Math.round(r.getBoundingClientRect().height) };
})()`);
ok(skStack.sameCol && skStack.below,
  `技能名与流程节点同列上下排（左缘差 <4px、节点在名字下方；行高 ${skStack.h}px）`);
ok(/^01 /.test(skStack.stageText), `流程节点带序号：${skStack.stageText}`);
const skColors = await ev(`(() => {
  const r = document.querySelector('[data-skill="SK-1"]');
  const g = (el) => el ? getComputedStyle(el).color : null;
  return { name: g(r.querySelector('.nm')), no: g(r.querySelector('.no')), sn: g(r.querySelector('.sn')), mode: document.documentElement.dataset.theme || 'dark' };
})()`);
ok(skColors.no && skColors.sn && skColors.name !== skColors.no && skColors.name !== skColors.sn && skColors.no !== skColors.sn,
  `技能名 / 流程序号 / 流程名三种颜色（${skColors.mode} 主题）：${skColors.name} / ${skColors.no} / ${skColors.sn}`);
const skSaved0 = ((await jget(`/api/projects/${proj.id}`)).skills || [])[0];
ok(skSaved0.stage === 'requirements', `阶段作用域真落库：stage=${skSaved0.stage}`);
ok(await ev(`document.querySelector('#nav .navbtn[data-view="skills"] .badge').textContent === '1'`), '侧栏徽标 = 1');
const pens = await ev(`(() => {
  const two = [...document.querySelectorAll('button')].map(b => [b.textContent.trim(), (b.textContent.match(/✎/g) || []).length]).filter(([, n]) => n > 1);
  const edit = document.querySelector('[data-skill-edit]');
  return { two: two.map(([t]) => t), edit: edit ? edit.textContent.trim() : '' };
})()`);
ok(pens.two.length === 0 && (pens.edit.match(/✎/g) || []).length === 1,
  `编辑按钮只有一支笔（页面里没有双笔按钮）：${pens.edit}`);
const btnColors = await ev(`(() => {
  const g = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return { bg: cs.backgroundColor, fg: cs.color, text: el.textContent.trim() }; };
  return { edit: g('[data-skill-edit]'), del: g('[data-skill-del]'), primary: g('.btn.primary') };
})()`);
const btLum = (css) => {
  const [r, g, b] = (css.match(/[0-9]+(\.[0-9]+)?/g) || [0, 0, 0]).slice(0, 3).map(Number)
    .map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const btContrast = (c) => { const [hi, lo] = [btLum(c.bg), btLum(c.fg)].sort((a, b) => b - a); return (hi + 0.05) / (lo + 0.05); };
const cEdit = btContrast(btnColors.edit), cDel = btContrast(btnColors.del), cPri = btnColors.primary ? btContrast(btnColors.primary) : null;
ok(/^rgb/.test(btnColors.edit.bg) && /^rgb/.test(btnColors.del.bg),
  `按钮底色是可解析的 rgb（不是 oklab 之类，对比度检查才不失真）：${btnColors.edit.bg} / ${btnColors.del.bg}`);
ok(btnColors.edit.bg !== btnColors.del.bg && btnColors.edit.fg !== btnColors.del.fg,
  `编辑/删除底色与字色都不同（编辑 ${btnColors.edit.bg}/${btnColors.edit.fg} · 删除 ${btnColors.del.bg}/${btnColors.del.fg}）`);
ok(cEdit >= 4.5 && cDel >= 4.5 && (cPri === null || cPri >= 4.5),
  `按钮文字对比度达 WCAG AA：编辑 ${cEdit.toFixed(2)}:1 · 删除 ${cDel.toFixed(2)}:1${cPri ? ` · 主按钮 ${cPri.toFixed(2)}:1` : ''}`);
const skSaved = ((await jget(`/api/projects/${proj.id}`)).skills || [])[0];
ok(skSaved.id === 'SK-1' && /只允许 Node 内置模块/.test(skSaved.body), `服务端真存了正文：${skSaved.body.slice(0, 30)}…`);
ok(await ev(`!/只允许 Node 内置模块/.test(document.querySelector('.grid.g-fill .body').textContent)`), '列表里不再铺正文（正文收进表单与悬停）');
ok(await ev(`/只允许 Node 内置模块/.test(document.querySelector('[data-skill="SK-1"]').getAttribute('title') || '')`), '悬停 title 里保留正文全文');

// 编辑：点✎ → 表单回填 → 改正文 → 保存
await ev(`document.querySelector('[data-skill-edit="SK-1"]').click()`);
await waitFor(async () => await ev(`document.querySelector('#skillForm').dataset.skillId === 'SK-1'`), 10000, '编辑态回填');
ok(await ev(`/只允许 Node 内置模块/.test(document.querySelector('#skillForm [name=body]').value)`), '编辑表单回填了原正文');
ok(await ev(`document.querySelector('#skillForm [name=stage]').value === 'requirements'`), '编辑表单回填了适用阶段');
const btns = await ev(`(() => { const f = document.querySelector('#skillForm');
  const save = f.querySelector('button[type=submit]'), cancel = f.querySelector('[data-skill-cancel]');
  return { n: f.querySelectorAll('button').length, sameRow: save.offsetTop === cancel.offsetTop,
    saveW: Math.round(save.getBoundingClientRect().width), cancelW: Math.round(cancel.getBoundingClientRect().width),
    formW: Math.round(f.getBoundingClientRect().width) }; })()`);
ok(btns.sameRow && btns.saveW < 160 && btns.cancelW < 160 && btns.saveW + btns.cancelW < btns.formW / 2,
  `保存/取消并排且按文字宽度（保存 ${btns.saveW}px + 取消 ${btns.cancelW}px，表单宽 ${btns.formW}px）`);
await setField('#skillForm [name=body]', '只允许 Node 内置模块；测试必须覆盖空输入与极值。');
await setField('#skillForm [name=stage]', '');                    // 改成「所有阶段」
await ev(`document.querySelector('#skillForm button[type=submit]').click()`);
await waitFor(async () => /空输入与极值/.test(((await jget(`/api/projects/${proj.id}`)).skills || [])[0]?.body || ''), 20000, '编辑落库');
ok(((await jget(`/api/projects/${proj.id}`)).skills || [])[0].stage === '', '阶段改成「所有阶段」也落库');
await waitFor(async () => await ev(`document.querySelector('#skillForm').dataset.skillId === ''`), 8000, '保存后回到「新增」态（等 SSE 重渲染）');
ok(await ev(`document.querySelector('#skillForm').dataset.skillId === ''`), '保存后回到「新增」态');
ok(((await jget(`/api/projects/${proj.id}`)).events || []).some(e => /技能 SK-1/.test(e.text)), '改技能写进事件流');

// 删除：确认框（ui_tree 自动接受）→ 列表清空
await ev(`document.querySelector('[data-skill-del="SK-1"]').click()`);
await waitFor(async () => ((await jget(`/api/projects/${proj.id}`)).skills || []).length === 0, 20000, '删除落库');
await waitFor(async () => await ev(`document.querySelector('[data-skill="SK-1"]') === null`), 8000, '列表里技能消失');
ok(true, '列表里技能已消失');
ok(await ev(`document.querySelector('#nav .navbtn[data-view="skills"] .badge').textContent === '0'`), '侧栏徽标回 0');
await shot('26-skills.png');

console.log('\n[8.13] 预设技能库界面：按范围 / 按技能选 → 导入 → 真落库 → 幂等');
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=skills&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelector('#presetSel') !== null`), 20000, '预设筛选渲染');
await waitFor(async () => await ev(`document.querySelector('#presetSel').options.length > 2`), 20000, '预设技能库已加载');
const presetOpts = await ev(`[...document.querySelectorAll('#presetSel option')].map(o => o.value)`);
const skillLabels = await ev(`(() => { const g = [...document.querySelectorAll('#presetSel optgroup')].at(-1);
  return g ? [...g.querySelectorAll('option')].map(o => o.textContent.trim()) : []; })()`);
ok(presetOpts.includes('all') && presetOpts.some(v => v.startsWith('stage:')),
  `筛选下拉带「全部 / 各阶段」（${presetOpts.filter(v => v.startsWith('stage:')).length} 个阶段项）`);
ok(skillLabels.length >= 30 && skillLabels.every(l => /^(\d{2}_)?[^_]+_.+/.test(l))
  && skillLabels.some(l => /^01_需求分析_/.test(l)) && skillLabels.some(l => /^所有阶段_/.test(l)),
  `按技能分组每条显示「流程序号_流程名称_技能名」（${skillLabels.slice(0, 3).join(' ｜ ')} … 共 ${skillLabels.length} 条）`);

const importWith = async (value) => {                   // 选范围 → 点导入：必须在同一次求值里做完，中间被 SSE 重渲染插一脚就退回「全部」了
  await ev(`(() => { const s = document.querySelector('#presetSel'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-preset-import]').click(); return s.value; })()`);
  await sleep(900);
};
const skBefore = ((await jget(`/api/projects/${proj.id}`)).skills || []).length;
await importWith('dev-java-springboot');                    // 直接选了某一条技能 → 只导它一条
const afterOne = ((await jget(`/api/projects/${proj.id}`)).skills || []);
ok(afterOne.length === skBefore + 1 && afterOne.at(-1).stage === 'development' && /Spring Boot/.test(afterOne.at(-1).name),
  `按技能选一条只导这一条：${afterOne.at(-1).name}`);
ok(dialogs.some(d => /导入 1 条/.test(d)), `页面提示导入结果：${dialogs.at(-1)}`);
await importWith('dev-java-springboot');
ok(((await jget(`/api/projects/${proj.id}`)).skills || []).length === afterOne.length, '重复导入不新增（幂等）');
await importWith('all');
const afterAll = ((await jget(`/api/projects/${proj.id}`)).skills || []);
ok(afterAll.length >= 13, `「全部」导入后共 ${afterAll.length} 条`);
ok(await ev(`document.querySelector('#nav .navbtn[data-view="skills"] .badge').textContent === String(document.querySelectorAll('[data-skill]').length)`),
  '侧栏徽标 = 列表条数');
ok(await ev(`/Java Struts2|SAP CAP/.test(document.querySelector('.grid.g-fill .body').textContent)`), '各栈技能能在列表里看到');
const skStages = await ev(`[...document.querySelectorAll('[data-skill-stage]')].map(e => e.dataset.skillStage)`);
const stOrder = (await jget(`/api/projects/${proj.id}`)).stages.map(s => s.id);
const stKey = (id) => (!id ? 0 : (stOrder.indexOf(id) + 1 || 99));       // 空阶段（所有阶段）排最前
const skBad = skStages.filter((id, i) => i && stKey(id) < stKey(skStages[i - 1]));
ok(skStages.length > 5 && skBad.length === 0,
  `技能列表按流程序号排：${skStages.slice(0, 8).map(id => id || '所有阶段').join(' → ')}${skBad.length ? `（乱序：${skBad.join('、')}）` : ''}`);
await shot('27-skills-catalog.png');

console.log('\n[8.13b] 一键导入「本分类自带的技能包」（技能 + 规则 + 目录规约同一套配置）');
const packProj = await post('/api/projects', { name: 'UI 分类技能包', brief: '配置包检查', mode: 'human_gate' });   // 干净项目：一条技能都没有
await send('Page.navigate', { url: `${BASE}/?view=skills&project=${packProj.id}` });
await waitFor(async () => await ev(`document.querySelector('[data-type-import]') !== null`), 20000, '技能页渲染');
const packState = await jget('/api/state');
const packCfg = packState.types.find(y => y.id === packProj.type);
const packBtn = await ev(`(() => { const b = document.querySelector('[data-type-import]'); return { text: b.textContent.trim(), title: b.getAttribute('title') || '' }; })()`);
ok(packBtn.text.includes(`（${packCfg.skills.length}）`) && packBtn.title.includes(packCfg.layers[0]),
  `技能页有「${packBtn.text}」按钮，title 写明分类与目录规约：${packBtn.title.slice(0, 56)}…`);
ok(((await jget(`/api/projects/${packProj.id}`)).skills || []).length === 0, '前置：这个项目技能库是空的');
await ev(`document.querySelector('[data-type-import]').click()`);
await waitFor(async () => ((await jget(`/api/projects/${packProj.id}`)).skills || []).length === packCfg.skills.length, 20000, '分类技能包导入落库');
const afterPack = (await jget(`/api/projects/${packProj.id}`)).skills;
const cat = (await jget('/api/skills/catalog')).skills;
const wantNames = cat.filter(c => packCfg.skills.includes(c.id)).map(c => c.name);
const have = new Set(afterPack.map(s => s.name));
ok(wantNames.length === packCfg.skills.length && wantNames.every(n => have.has(n)),
  `分类技能包 ${wantNames.length} 条全部进项目（0 → ${afterPack.length} 条）：${wantNames.slice(0, 3).join(' / ')} …`);
ok((await jget(`/api/projects/${packProj.id}`)).events.some(e => /从预设技能库导入/.test(e.text)), '导入记账进事件流');
await ev(`document.querySelector('[data-type-import]').click()`);        // 再点一次：幂等，不重复堆
await sleep(1200);
ok(((await jget(`/api/projects/${packProj.id}`)).skills || []).length === packCfg.skills.length, '再点一次不重复导入（幂等）');
await fetch(`${BASE}/api/projects/${packProj.id}`, { method: 'DELETE' });   // 收掉这个临时项目

console.log('\n[8.14] 技能页：列表窄栏（无简介）、右栏加宽');
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=skills&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelector('[data-skill]') !== null`), 20000, '技能列表渲染');
const skCut = await ev(`(() => {
  const rows = [...document.querySelectorAll('[data-skill]')];
  const g = document.querySelector('.grid.g-skills');
  const cards = [...g.querySelectorAll(':scope > .card')];
  const cols = getComputedStyle(g).gridTemplateColumns.split(' ').map(x => Math.round(parseFloat(x)));
  return { rows: rows.length, withTitle: rows.filter(r => (r.getAttribute('title') || '').length > 20).length,
    extraBlocks: document.querySelectorAll('.grid.g-skills > .card:first-child > .body > div:not(.row):not(.empty)').length,
    bodyTextLen: document.querySelector('.grid.g-skills > .card:first-child > .body').textContent.length,
    cols, listW: Math.round(cards[0].getBoundingClientRect().width), rightW: Math.round(cards[1].getBoundingClientRect().width) };
})()`);
ok(skCut.rows > 0 && skCut.extraBlocks === 0, `列表只剩条目行，没有简介块（${skCut.rows} 行，块外元素 ${skCut.extraBlocks} 个）`);
ok(skCut.listW >= 380 && skCut.listW <= 470 && skCut.rightW > skCut.listW * 1.5,
  `左栏宽度适当加宽、右栏仍占大头（列表 ${skCut.listW}px / 右栏 ${skCut.rightW}px）`);
ok(skCut.withTitle === skCut.rows, '每行 title 仍挂着正文（悬停可看全文）');
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=skills&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelector('.grid.g-skills') !== null`), 20000, '窄屏技能页渲染');
ok(await ev(`getComputedStyle(document.querySelector('.grid.g-skills')).gridTemplateColumns.split(' ').length === 1`), '窄屏仍折成单栏');

console.log('\n[8.15] 源码页：工作区后来才有文件时，界面自己刷（不手动刷新页面）');
const fp2 = await post('/api/projects', { name: 'UI 源码刷新检查', brief: '借书/还书/逾期罚金', mode: 'human_gate' });
const fid2 = fp2.id;
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=code&project=${fid2}` });
await waitFor(async () => await ev(`document.querySelector('.grid.g-tree') !== null`), 20000, '源码页渲染');
ok(await ev(`document.querySelectorAll('.trow.file').length`) === 0, '工作区还空着时源码页就是空的（不编数据）');
for (const sid of ['requirements', 'ux', 'architecture', 'wbs']) {
  await waitFor(async () => (await jget(`/api/projects/${fid2}`)).stages.find(s => s.id === sid).status === 'awaiting_review', 40000, `${sid} 待审核`);
  await post(`/api/projects/${fid2}/stages/${sid}/approve`, { reviewer: 'UI 检查' });
}
await post(`/api/projects/${fid2}/stages/development/run`, {});
await waitFor(async () => { const q = await jget(`/api/projects/${fid2}`); return q.modules[0] && q.modules[0].status === 'awaiting_review'; }, 60000, '首个模块完成');
try { await waitFor(async () => (await ev(`document.querySelectorAll('.trow.file').length`)) > 0, 25000, '源码页自动补文件'); ok(true, '模块落盘后，停在同一页的源码列表自己补上了文件（没有手动刷新）'); }
catch { ok(false, '源码列表没有自动刷新：源码页仍为空'); }
const refreshRows = await ev(`document.querySelectorAll('.trow.file').length`);
const refreshApi = (await jget(`/api/projects/${fid2}/workspace`)).files.filter(f => /\.(mjs|java|py|cds)$/.test(f.path)).length;
ok(refreshRows >= 2 && refreshRows <= refreshApi, `界面行数落在工作区实际文件数内（界面 ${refreshRows} ≤ 接口 ${refreshApi}，且至少含 M1 的源码+测试）`);

console.log('\n[8.16] 产物列表按「阶段顺序 → 编号」显示');
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=artifacts&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelector('[data-artifact]') !== null`), 20000, '产物列表渲染');
const artRows = await ev(`[...document.querySelectorAll('[data-artifact]')].map(r => [r.dataset.artifact, ((r.querySelector('.path') || {}).textContent || '').trim().replace(/^\\d{2} /, '')])`);
const pjArt = await jget(`/api/projects/${proj.id}`);
const artStageIdx = new Map(pjArt.stages.map((s, i) => [s.name, i]));
const artNo = (id) => { const m = String(id).match(/\d+/); return m ? Number(m[0]) : -1; };
const artKeys = artRows.map(([id, stage]) => [artStageIdx.get(stage) ?? 99, artNo(id), id]);
const outOfOrder = artKeys.filter((k, i) => i && (k[0] < artKeys[i - 1][0] || (k[0] === artKeys[i - 1][0] && k[1] < artKeys[i - 1][1])));
ok(artRows.length >= 6 && outOfOrder.length === 0,
  `产物按阶段与编号递增：${artRows.slice(0, 8).map(r => r[0]).join(' → ')}${outOfOrder.length ? `（乱序：${outOfOrder.map(k => k[2]).join('、')}）` : ''}`);
ok(artRows[0] && artRows[0][0] === 'REQ-01', `列表第一项是需求文档 ${artRows[0] ? artRows[0][0] : '—'}`);
const m1At = artRows.findIndex(([id]) => /^M1/.test(id)), arcAt = artRows.findIndex(([id]) => /^ARC/.test(id));
ok(m1At > arcAt && arcAt >= 0, `模块产物排在架构文档之后（ARC@${arcAt} → M1@${m1At}）`);
const artCols = await ev(`(() => {
  const g = document.querySelector('.grid.g-tree');
  const cards = [...g.querySelectorAll(':scope > .card')];
  const w = (i) => Math.round(cards[i].getBoundingClientRect().width);
  return { cls: g.className, list: w(0), mid: w(1), meta: w(2) };
})()`);
ok(artCols.cls.includes('g-wideleft') && artCols.list >= 370 && artCols.list > artCols.meta,
  `产物页清单列加宽（清单 ${artCols.list}px / 正文 ${artCols.mid}px / Meta ${artCols.meta}px，限定在产物页：g-wideleft）`);

console.log('\n[8.17] 流程名带序号 + 跟着语言切换（中 → 英 → 日 → 中）');
await send('Page.navigate', { url: `${BASE}/?view=flow&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelectorAll('.pipe-node .t').length === 8`), 20000, '流程页渲染');
const pipeNames = () => ev(`[...document.querySelectorAll('.pipe-node .t')].map(e => e.textContent.trim())`);
const zhPipe = await pipeNames();
ok(zhPipe[0] === '需求分析' && zhPipe[4] === '模块开发', `中文：${zhPipe.join(' / ')}`);
const flowHead = await ev(`document.querySelector('.grid.g-1-2 .card h2')?.textContent?.trim() || ''`);
ok(/^\d{2} \S/.test(flowHead), `阶段详情标题前面有序号：${flowHead}`);
const switchLang = async (code, cond, what) => {          // cond = 页面上的判定表达式（不同页面的锚点不一样）
  await ev(`(() => { const s = document.getElementById('tgLang'); s.value = ${JSON.stringify(code)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor(async () => await ev(cond), 8000, what || `切到 ${code}`);
  return await pipeNames();
};
const pipeIs = (name) => `document.querySelector('.pipe-node .t')?.textContent.trim() === ${JSON.stringify(name)}`;
const enPipe = await switchLang('en', pipeIs('Requirements'), '切到 en');
ok(enPipe[0] === 'Requirements' && enPipe[4] === 'Module development', `英文：${enPipe.join(' / ')}`);
const enHead = await ev(`document.querySelector('.grid.g-1-2 .card h2')?.textContent?.trim() || ''`);
ok(/^\d{2} /.test(enHead), `英文下序号还在：${enHead}`);
const jaPipe = await switchLang('ja', pipeIs('要件定義'), '切到 ja');
ok(jaPipe[0] === '要件定義' && jaPipe[7] === '運用', `日文：${jaPipe.join(' / ')}`);
const bnPipe = await switchLang('zh', pipeIs('需求分析'), '切回 zh');
ok(bnPipe[0] === '需求分析' && bnPipe.length === 8, '切回中文，8 个阶段名都在');
await send('Page.navigate', { url: `${BASE}/?view=artifacts&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelector('[data-artifact]') !== null`), 20000, '产物页渲染');
const ownerCell = await ev(`(() => { const r = document.querySelector('[data-artifact="REQ-01"] .path'); return r ? r.textContent.trim() : ''; })()`);
ok(/^01 \S/.test(ownerCell), `产物归属列也带阶段序号：${ownerCell}`);
const artNameCell = await ev(`(() => { const r = document.querySelector('[data-artifact="REQ-01"] .nm'); return r ? r.textContent.trim() : ''; })()`);
ok(artNameCell === '01-需求分析-需求规格说明书', `产物名 = 序号-流程点名-生成的名字：${artNameCell}`);
await switchLang('en', `document.querySelector('[data-artifact="REQ-01"] .nm')?.textContent.trim() === '01-Requirements-需求规格说明书'`, '产物页切到 en');
const enArtName = await ev(`(() => { const r = document.querySelector('[data-artifact="REQ-01"] .nm'); return r ? r.textContent.trim() : ''; })()`);
ok(enArtName === '01-Requirements-需求规格说明书', `产物名前缀跟着语言走（生成的名字本身不翻译）：${enArtName}`);
await switchLang('zh', `document.querySelector('[data-artifact="REQ-01"] .nm')?.textContent.trim().startsWith('01-需求分析-')`, '产物页切回 zh');

console.log('\n[8.18] 工作区被清空后，源码面不留旧内容（同项目内文件消失）');
await send('Page.navigate', { url: `${BASE}/?view=code&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelector('.card pre') !== null`), 20000, '源码面先有内容');
const oldHead = await ev(`document.querySelector('.card pre').textContent.trim().slice(0, 40)`);
const oldLen = await ev(`document.querySelector('.card pre').textContent.trim().length`);
ok(oldLen > 20, `清空前源码面有内容（${oldLen} 字符）`);
await post(`/api/projects/${proj.id}/rebuild`, {});                       // 清空工作区（等于文件全没了）
await sleep(1200);
const afterCut = await ev(`(() => {
  const cards = [...document.querySelectorAll('.grid.g-tree > .card')];
  return { pre: !!document.querySelector('.grid.g-tree > .card pre'), mid: cards[1].textContent.trim(), cur: (cards[2].querySelector('.kv + .v') || {}).textContent || '' };
})()`);
ok(!afterCut.pre && !afterCut.mid.includes(oldHead.slice(0, 20)),
  `清空后编辑区不再显示旧内容（中间区：${afterCut.mid.slice(0, 40) || '空'}）`);
await shot('54-source-empty.png');

// 规则：内容区没内容就留空（勾选空态只在左列表），新建项目也一样
await send('Page.navigate', { url: `${BASE}/?view=code&project=${rbProj.id}` });
await waitFor(async () => await ev(`document.querySelector('.grid.g-tree > .card .body') !== null`), 15000, '新建项目源码面渲染');
const freshPane = await ev(`(() => {
  const cards = [...document.querySelectorAll('.grid.g-tree > .card')];
  const mid = cards[1].querySelector('.body');
  return { html: mid.innerHTML.trim(), midText: mid.textContent.trim(), left: cards[0].textContent.replace(/\s+/g, ' ').trim().slice(0, 40), pre: !!cards[1].querySelector('pre') };
})()`);
ok(freshPane.html === '' && freshPane.midText === '' && !freshPane.pre,
  `新建项目内容区留空（innerHTML ${freshPane.html.length} 字、无 pre）`);
ok(/まだソースが出力されていません/.test(freshPane.left), `空状態の説明は左リストにのみ表示：${freshPane.left}`);
await shot('56-source-fresh-blank.png');

console.log('\n[8.19] 流程点：等分撑满界面宽度 + 每个流程点中间一个图标');
const railAt = async (w, h = 1000) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/?view=flow&project=${proj.id}` });
  await waitFor(async () => await ev(`document.querySelectorAll('.pipe-node').length === 8`), 20000, `流程页渲染 @${w}`);
  await sleep(400);
  return await ev(`(() => {
    const pipe = document.querySelector('.pipe');
    const nodes = [...pipe.querySelectorAll('.pipe-node')];
    const pr = pipe.getBoundingClientRect();
    const mid = (r) => r.left + r.width / 2;
    return { n: nodes.length, rowW: Math.round(pr.width),
      widths: nodes.map(n => Math.round(n.getBoundingClientRect().width)),
      rightGap: Math.round(pr.right - nodes[nodes.length - 1].getBoundingClientRect().right),
      scrollW: pipe.scrollWidth, clientW: pipe.clientWidth,
      icons: nodes.map(n => { const s = n.querySelector('.ico svg');
        return s ? { w: Math.round(s.getBoundingClientRect().width), off: Math.round(mid(s.getBoundingClientRect()) - mid(n.getBoundingClientRect())) } : null; }),
      bots: nodes.map(n => { const b = n.querySelector(".bot"), s = b && b.querySelector("svg");
        if (!s) return null;
        const nr = n.getBoundingClientRect(), br = b.getBoundingClientRect();
        return { v: n.dataset.stage, w: Math.round(s.getBoundingClientRect().width), top: Math.round(br.top - nr.top), right: Math.round(nr.right - br.right),
          color: (b.style.getPropertyValue('--c') || getComputedStyle(b).getPropertyValue('--c') || '').trim(), shape: s.innerHTML.length, title: b.getAttribute('title') || '' }; }) };
  })()`);
};
const railWide = await railAt(1680), railMid = await railAt(1000);
ok(railWide.n === 8 && railWide.widths.every(w => w > 120) && new Set(railWide.widths).size <= 2,
  `流程点等分撑满界面宽度（行宽 ${railWide.rowW}，节点宽 ${railWide.widths.join('/')}）`);
ok(railWide.rightGap <= 1 && railWide.scrollW <= railWide.clientW + 1,
  `整条流水线既不溢出也不留空（右端余量 ${railWide.rightGap}px，scroll ${railWide.scrollW} ≤ client ${railWide.clientW}）`);
ok(railWide.icons.every(x => x && x.w >= 26) && railWide.icons.every(x => Math.abs(x.off) <= 1),
  `每个流程点中间一个图标（${railWide.icons.length} 个 / 宽 ${railWide.icons.map(x => x && x.w).join('/')} / 居中偏移 ${railWide.icons.map(x => x && x.off).join('/')}）`);
ok(railWide.bots.length === 8 && railWide.bots.every(x => x && x.w === 20),
  `每个流程点右上角都有 20px 机器人（缺的：${railWide.bots.map((x, i) => (x ? '' : i + 1)).filter(Boolean).join('、') || '无'}）`);
ok(new Set(railWide.bots.map(x => x.shape)).size === 8,
  `每个流程点一只**不同的**机器人（8 种图形，内联长度 ${railWide.bots.map(x => x.shape).join('/')}）`);
ok(new Set(railWide.bots.map(x => x.color)).size === 8 && railWide.bots.every(x => /^rgb|^#/.test(x.color)),
  `每阶段机器人颜色不同（真彩色）：${railWide.bots.map(x => `${x.v}=${x.color}`).join(' ')}`);
ok(railWide.bots.every(x => x.top <= 10 && x.right <= 12) && railWide.bots.every(x => /执行$/.test(x.title)),
  `机器人贴在右上角（顶距 ${railWide.bots[0].top}px / 右距 ${railWide.bots[0].right}px）且 title 写明谁执行：${railWide.bots[0].title}`);
ok(railMid.widths.every(w => w >= 84) && new Set(railMid.widths).size <= 2,
  `窄屏也不压扁（@1000 节点宽 ${railMid.widths.join('/')}，下限 84）`);
await shot('57-flow-rail.png');

console.log('\n[8.20] 流程与门禁的备注一行显示（不被 max-width 折成两行）');
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=flow&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelector('.page-head p') !== null`), 20000, '流程页页头渲染');
const note = await ev(`(() => {
  const p = document.querySelector('.page-head p'), cs = getComputedStyle(p), r = p.getBoundingClientRect();
  const lh = parseFloat(cs.lineHeight) || 18;
  return { text: p.textContent.trim(), lines: Math.round(r.height / lh), h: Math.round(r.height), lh,
    over: p.scrollWidth - p.clientWidth, docOver: document.documentElement.scrollWidth - window.innerWidth,
    headLines: Math.round(document.querySelector('.page-head').getBoundingClientRect().height) };
})()`);
ok(note.lines === 1, `备注一行显示（${note.text.length} 字 / 高 ${note.h}px ÷ 行高 ${note.lh} = ${note.lines} 行）`);
ok(note.over <= 1 && note.docOver <= 1, `一行也不横向溢出（备注溢出 ${note.over}px / 页面溢出 ${note.docOver}px）`);

console.log('\n[8.21] 每个界面的标题前都有图标（h1 首位是 .tico svg）');
const VIEW_IDS = ['projects', 'overview', 'flow', 'wbs', 'artifacts', 'code', 'runs', 'skills'];
const titles = [];
for (const v of VIEW_IDS) {
  await send('Page.navigate', { url: `${BASE}/?view=${v}&project=${proj.id}` });
  await waitFor(async () => await ev(`document.querySelector('.page-head h1') !== null`), 20000, `${v} 页头渲染`);
  titles.push(await ev(`(() => { const h = document.querySelector('.page-head h1'), s = h.querySelector('.tico svg');
    return { view: ${JSON.stringify(v)}, text: h.textContent.trim(), icon: s ? Math.round(s.getBoundingClientRect().width) : 0,
      first: h.firstElementChild?.classList.contains('tico') === true }; })()`));
}
ok(titles.every(t => t.icon >= 17 && t.first && t.text.length >= 2),
  `8 个界面标题都以图标开头（${titles.map(t => `${t.view}: ${t.icon}px「${t.text}」`).join('、')}）`);

console.log('\n[8.22] 工作流：按客户的项目需求选，流水线阶段跟着变');
const wfProj = await post('/api/projects', { name: 'UI 工作流检查', brief: '工作流', mode: 'human_gate', workflow: 'lean' });
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=flow&project=${wfProj.id}` });
await waitFor(async () => await ev(`document.querySelectorAll('.pipe-node').length > 0`), 20000, '精简工作流项目渲染');
const wfFlow = await ev(`(() => ({
  ids: [...document.querySelectorAll('.pipe-node')].map(n => n.dataset.stage),
  names: [...document.querySelectorAll('.pipe-node .t')].map(n => n.textContent.trim()),
  badge: (document.getElementById('navStages') || {}).textContent || ''
}))()`);
ok(wfFlow.ids.join(',') === 'requirements,architecture,wbs,development,testing',
  `精简交付只走 5 个阶段（${wfFlow.names.join(' → ')}）`);
ok(wfFlow.badge === '5', `侧栏阶段数跟着工作流走（${wfFlow.badge}）`);

await send('Page.navigate', { url: `${BASE}/?view=projects` });
await waitFor(async () => await ev(`document.querySelector('#newProject select[name="workflow"]') !== null`), 20000, '新建表单渲染');
const wfOpts = await ev(`[...document.querySelectorAll('#newProject select[name="workflow"] option')].map(o => o.value)`);
ok(wfOpts.length >= 5 && wfOpts.includes('full') && wfOpts.includes('design'), `新建表单能选工作流（${wfOpts.join(' / ')}）`);
await ev(`(() => { const f = document.getElementById('newProject');
  f.querySelector('input[name="name"]').value = 'UI 方案设计检查';
  f.querySelector('select[name="workflow"]').value = 'design';
  f.requestSubmit(); return true; })()`);
await waitFor(async () => await ev(`[...document.querySelectorAll('.proj-card .pname')].some(e => e.textContent.includes('UI 方案设计检查'))`), 20000, '新项目出现在列表');
const made = (await jget('/api/state')).projects.find(x => x.name === 'UI 方案设计检查');
ok(made && made.workflow === 'design' && made.stages.map(s => s.id).join(',') === 'requirements,ux,architecture,wbs',
  `表单选的工作流真落库（${made ? `${made.workflow} · ${made.stages.length} 阶段：${made.stages.map(s => s.id).join(' → ')}` : '—'}）`);
const chip = await ev(`(() => { const c = [...document.querySelectorAll('.proj-card')].find(x => x.querySelector('.pname').textContent.includes('UI 方案设计检查'));
  return c ? c.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : ''; })()`);
ok(/方案设计/.test(chip), `项目卡标出工作流：${chip}`);

console.log('\n[8.23] 技能批量删除：导入后勾选 → 删除选中（全选 / 取消全选也真跑）');
const skCount = async () => ((await jget(`/api/projects/${proj.id}`)).skills || []).length;
const skBeforeBulk = await skCount();
ok(skBeforeBulk >= 3, `前置：列表里有 ${skBeforeBulk} 条技能可批量删`);
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=skills&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelectorAll('[data-skill-pick]').length === ${skBeforeBulk}`), 20000, '技能列表渲染');
ok(await ev(`document.querySelector('[data-skill-bulk-del]').disabled === true`), '没勾选时「删除选中」禁用');

await ev(`document.querySelector('[data-skill-all]').click()`);
await sleep(350);
const allOn = await ev(`(() => ({ checked: [...document.querySelectorAll('[data-skill-pick]')].filter(c => c.checked).length,
  label: document.querySelector('[data-skill-all]').textContent.trim(), del: document.querySelector('[data-skill-bulk-del]').textContent.trim() }))()`);
ok(allOn.checked === skBeforeBulk && /取消全选/.test(allOn.label) && allOn.del.includes(`（${skBeforeBulk}）`),
  `全选真勾上 ${allOn.checked} 条（按钮 → 「${allOn.label}」，删除按钮 → 「${allOn.del}」）`);
await ev(`document.querySelector('[data-skill-all]').click()`);
await sleep(350);
ok(await ev(`[...document.querySelectorAll('[data-skill-pick]')].filter(c => c.checked).length === 0`), '再点一次取消全选');

const pick1 = await ev(`(() => { const b = document.querySelectorAll('[data-skill-pick]')[0]; b.click(); return b.dataset.skillPick; })()`);
await sleep(350);
const pick2 = await ev(`(() => { const b = [...document.querySelectorAll('[data-skill-pick]')].find(x => !x.checked && x.dataset.skillPick !== ${JSON.stringify(pick1)}); b.click(); return b.dataset.skillPick; })()`);
await sleep(350);
ok(await ev(`[...document.querySelectorAll('[data-skill-pick]')].filter(c => c.checked).length === 2`), `勾了两条（${pick1}、${pick2}）`);
await ev(`document.querySelector('[data-skill-bulk-del]').click()`);
await waitFor(async () => (await skCount()) === skBeforeBulk - 2, 20000, '批量删除落库');
ok(await skCount() === skBeforeBulk - 2, `服务端真少两条（${skBeforeBulk} → ${await skCount()}）`);
await waitFor(async () => await ev(`document.querySelector('[data-skill="${pick1}"]') === null && document.querySelector('[data-skill="${pick2}"]') === null`), 8000, '两条从列表消失');
ok(await ev(`[...document.querySelectorAll('[data-skill-pick]')].filter(c => c.checked).length === 0`), '删完勾选自动清空');
ok(dialogs.some(d => /已删除 2 条/.test(d)), `页面提示删除结果：${dialogs.at(-1)}`);
ok((await jget(`/api/projects/${proj.id}`)).events.some(e => /批量删除技能 2 条/.test(e.text)), '事件流留一条批量删除记账');
await shot('58-skills-bulk-delete.png');

console.log('\n[8.24] 项目信息可编辑保存：卡片就地变表单 → 真落库 → 取消不落库');
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=projects` });
await waitFor(async () => await ev(`document.querySelector('[data-edit-project]') !== null`), 20000, '项目卡渲染');
const beforeName = (await jget(`/api/projects/${proj.id}`)).name;
const editLabel = await ev(`document.querySelector('[data-edit-project]').textContent.trim()`);
const nCards = (await jget('/api/state')).projects.length;
ok(await ev(`document.querySelectorAll('[data-edit-project]').length === ${nCards}`),
  `${nCards} 张项目卡都有「${editLabel}」按钮`);
const cardActs = await ev(`(() => { const c = [...document.querySelectorAll('.proj-card')].find(x => x.dataset.project === ${JSON.stringify(proj.id)});
  const btns = [...c.querySelectorAll('button')], last = c.lastElementChild;
  const tops = new Set(btns.map(b => Math.round(b.getBoundingClientRect().top)));
  const nearBottom = [...document.querySelectorAll('.proj-card')].map(x => {
    const bs = [...x.querySelectorAll('button')];
    return bs.length ? Math.round(x.getBoundingClientRect().bottom - bs[0].getBoundingClientRect().bottom) : 999; });
  return { headBtns: c.querySelector('.head').querySelectorAll('button').length, inLast: btns.length === 3 && btns.every(b => last.contains(b)),
    sameRow: tops.size === 1, belowProgress: btns[0].getBoundingClientRect().top > c.querySelector('.progress').getBoundingClientRect().bottom,
    gaps: nearBottom, labels: btns.map(b => b.textContent.trim()) }; })()`);
ok(cardActs.headBtns === 0 && cardActs.inLast && cardActs.sameRow && cardActs.belowProgress && cardActs.gaps.every(g => g >= 0 && g < 40),
  `卡片按钮统一在最下面一行（顶部无按钮 / 三者同一行 / 每张卡都贴着底边 ≤${Math.max(...cardActs.gaps)}px）：${cardActs.labels.join(' / ')}`);
const modeIco = await ev(`(() => { const c = [...document.querySelectorAll('.proj-card')].find(x => x.dataset.project === ${JSON.stringify(proj.id)});
  const m = c.querySelector('.mode-ico'), ico = m && m.querySelector('.tico svg'), txt = m && m.querySelector('.mt');
  if (!m) return { has: false };
  const ir = ico.getBoundingClientRect(), tr = txt.getBoundingClientRect();
  const chip = c.querySelector('.head .pill');
  return { has: true, tag: ico.tagName, iconW: Math.round(ir.width), stacked: Math.round(tr.top) >= Math.round(ir.bottom) - 1,
    centered: Math.abs((ir.left + ir.right) / 2 - (tr.left + tr.right) / 2) < 3, font: getComputedStyle(m).fontSize, text: txt.textContent.trim(),
    chip: chip ? chip.textContent.trim().slice(0, 18) : '', title: m.getAttribute('title') || '' }; })()`);
ok(modeIco.has && modeIco.tag === 'svg' && modeIco.iconW >= 16 && modeIco.stacked && modeIco.centered && modeIco.chip,
  `执行模式 = 图标＋文字上下排（${modeIco.iconW}px 图标在上、「${modeIco.text}」在下居中 · 与工作流徽标并排：${modeIco.chip}…）`);
const openEdit = () => ev(`(() => { const c = [...document.querySelectorAll('.proj-card')].find(x => x.dataset.project === ${JSON.stringify(proj.id)});
  c.querySelector('[data-edit-project]').click(); return true; })()`);
await openEdit();
await waitFor(async () => await ev(`document.querySelector('#editProject') !== null`), 8000, '编辑表单就地出现');
const prefilled = await ev(`(() => { const f = document.getElementById('editProject');
  return { id: f.dataset.id, name: f.querySelector('[name=name]').value, brief: f.querySelector('[name=brief]').value, mode: f.querySelector('[name=mode]').value }; })()`);
ok(prefilled.id === proj.id && prefilled.name === beforeName && prefilled.brief.length > 0,
  `表单就地打开并带出当前值：${prefilled.name} / 需求 ${prefilled.brief.length} 字 / 入口 ${prefilled.mode}`);
ok(await ev(`(() => { const c = [...document.querySelectorAll('.proj-card')].find(x => x.dataset.project === ${JSON.stringify(proj.id)});
  return c.querySelector('.pname') !== null && c.querySelector('#editProject') === null; })()`), '编辑时项目卡保持原样（表单不嵌在卡里）');
const inRight = await ev(`(() => { const f = document.getElementById('editProject'); const card = f.closest('.card'); const col = card.closest('.g-side');
  return { header: card.querySelector('h2').textContent.trim(), kicker: card.querySelector('.kicker').textContent.trim(),
    right: card === col.lastElementChild, cols: col.children.length, newGone: document.getElementById('newProject') === null }; })()`);
ok(/编辑项目/.test(inRight.header) && inRight.kicker === proj.id && inRight.right && inRight.cols === 2 && inRight.newGone,
  `编辑表单占右侧那一栏（标题「${inRight.header}」· ${inRight.kicker} · 右栏第 ${inRight.cols} 列 · 新建表单让位）`);
const editFields = await ev(`[...document.querySelectorAll('#editProject [name]')].map(x => x.name)`);
ok(editFields.join(',') === 'name,brief,type,tech,workflow,mode,files', `编辑表单的条目和「新建项目」一样：${editFields.join(' → ')}`);
const editLabels = await ev(`[...document.querySelectorAll('#editProject .lb')].map(x => x.textContent.trim())`);
ok(editLabels.length === 7 && editLabels[0] === '项目名称' && editLabels[1] === '项目概要' && editLabels[2] === '软件分类' && editLabels[3] === '技术栈' && editLabels[4].includes('工作流') && editLabels[5] === '执行模式' && editLabels[6].includes('输入资料'),
  `标签与顺序也一致（含输入资料）：${editLabels.join(' / ')}`);
ok(await ev(`document.querySelector('#editProject input[name=files]').multiple === true`), '输入资料是可多选的文件框');
ok(await ev(`document.querySelector('#editProject [name=type]').disabled === false && document.querySelector('#editProject [name=workflow]').disabled === false`),
  '编辑里软件分类与工作流都可以选（不是锁死的）');
ok(/流程/.test(await ev(`document.getElementById('editTypeHint').textContent`)), '分类下面写着它的默认流程');
const editHints = await ev(`[...document.querySelector('#editProject select[name=workflow]').closest('div').querySelectorAll('.hint')].map(x => x.textContent.trim())`);
ok(/需求/.test(editHints[0]) && /重排/.test(editHints[1]),
  `工作流那行换行显示当前流程、下面再一行说明改它会重排：${editHints[0].slice(0, 26)}… / ${editHints[1].slice(0, 18)}…`);
await shot('60-proj-edit.png');      // 开着编辑表单拍（保存后就换回「新建项目」了）

const newName = 'UI 源码管理检查（改名后）';
await setField('#editProject [name=name]', newName);
await setField('#editProject [name=brief]', '借阅管理：借书/还书/逾期罚金。补充：罚金上限 100 元，超限冻结。');
await setField('#editProject [name=tech]', 'Node.js 20 + 内存存储');
await setField('#editProject [name=mode]', 'auto');
await ev(`document.getElementById('editProject').requestSubmit()`);
await waitFor(async () => (await jget(`/api/projects/${proj.id}`)).name === newName, 20000, '改名落库');
const savedProj = await jget(`/api/projects/${proj.id}`);
ok(savedProj.name === newName && /罚金上限 100 元/.test(savedProj.brief) && savedProj.tech === 'Node.js 20 + 内存存储' && savedProj.mode === 'auto',
  `名称 / 需求 / 技术栈 / 入口模式都真落库：${savedProj.name} · ${savedProj.tech} · ${savedProj.mode}`);
ok(savedProj.events.some(e => /项目信息已编辑/.test(e.text) && e.text.includes(newName)), '事件流留一条「项目信息已编辑」记账');
await waitFor(async () => await ev(`document.querySelector('#editProject') === null`), 8000, '保存后表单收起');
ok(await ev(`[...document.querySelectorAll('.proj-card .pname')].some(e => e.textContent.includes('改名后'))`), '卡片名字跟着更新（不用手动刷新）');
ok(await ev(`document.querySelector('.proj-card [data-edit-project]') !== null`), '保存后回到普通卡片，编辑按钮还在（能再改）');

await openEdit();
await waitFor(async () => await ev(`document.querySelector('#editProject') !== null`), 8000, '再次打开编辑表单');
ok(await ev(`document.getElementById('editProject').querySelector('[name=name]').value === ${JSON.stringify(newName)}`), '再打开时带的是改后的名字');
await setField('#editProject [name=name]', '不该被保存的名字');
await ev(`document.querySelector('#editProject [data-cancel-edit]').click()`);
await waitFor(async () => await ev(`document.querySelector('#editProject') === null`), 8000, '取消后表单收起');
ok((await jget(`/api/projects/${proj.id}`)).name === newName, `取消不落库（还是「${newName}」）`);
ok(await ev(`document.getElementById('newProject') !== null && document.querySelector('#newProject [name=type]') !== null`),
  '取消后右侧换回「新建项目」表单（分类/技术栈建议都还在）');

console.log('\n[8.25] 新建项目的「类型」选项：选完带出默认流程 → 建出来的阶段与类型一致');
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?view=projects` });
await waitFor(async () => await ev(`document.querySelector('#newProject select[name=type]') !== null`), 20000, '类型下拉渲染');
const typeOpts = await ev(`[...document.querySelectorAll('#newProject select[name=type] option')].map(o => o.value)`);
ok(typeOpts.length >= 5 && typeOpts.includes('website') && typeOpts.includes('cli'), `类型下拉有 ${typeOpts.length} 项：${typeOpts.join(' / ')}`);
const formOrder = await ev(`[...document.querySelectorAll('#newProject [name]')].map(x => x.name)`);
const iType = formOrder.indexOf('type'), iTech = formOrder.indexOf('tech');
ok(iType >= 0 && iTech === iType + 1, `技术栈就排在分类下面（表单顺序：${formOrder.join(' → ')}）`);
const typeLabel = await ev(`document.querySelector('#newProject select[name=type]').closest('div').querySelector('.lb').textContent.trim()`);
ok(typeLabel === '软件分类', `这一项的标签是「${typeLabel}」`);
const wfOptLabels = await ev(`[...document.querySelectorAll('#newProject select[name=workflow] option')].map(o => o.textContent.trim())`);
ok(wfOptLabels.length >= 5 && wfOptLabels.every(x => !x.includes('→')), `工作流下拉里只留流程名（阶段序列挪到下面那行）：${wfOptLabels.slice(0, 3).join(' / ')} …`);
const wfHintInfo = await ev(`(() => { const h = document.getElementById('wfHint'); const cs = getComputedStyle(h);
  return { font: cs.fontSize, wrap: cs.whiteSpace, lines: Math.round(h.getBoundingClientRect().height / parseFloat(cs.lineHeight)), text: h.textContent }; })()`);
ok(wfHintInfo.font === '12.5px' && wfHintInfo.wrap === 'normal' && wfHintInfo.lines >= 2 && /需求分析/.test(wfHintInfo.text),
  `工作流说明换行显示（${wfHintInfo.lines} 行 · 字号 ${wfHintInfo.font}）：${wfHintInfo.text.slice(0, 44)}…`);
const modeHintBefore = await ev(`document.getElementById('modeHint').textContent`);
const modeAfter = await ev(`(() => { const s = document.getElementById('modeSel'); s.focus(); s.value = 'auto'; s.dispatchEvent(new Event('change', { bubbles: true }));
  const h = document.getElementById('modeHint'); return { font: getComputedStyle(h).fontSize, text: h.textContent }; })()`);   // 设值+读回同一次求值：中间被 SSE 重渲染插一脚就会退回旧模式
ok(/每个门禁/.test(modeHintBefore) && /自动放行|门禁自动/.test(modeAfter.text) && modeAfter.font === '12.5px',
  `执行模式说明跟着选择换、字号 ${modeAfter.font}：${modeAfter.text.slice(0, 34)}…`);
await ev(`(() => { const s = document.getElementById('modeSel'); s.value = 'human_gate'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
const sug0 = await ev(`[...document.querySelectorAll('#techSug option')].map(o => o.value)`);
ok(sug0.length >= 2 && sug0.some(x => /Next\.js/.test(x)), `默认分类（Web 应用）的建议 ${sug0.length} 条：${sug0.join(' ｜ ')}`);
ok(await ev(`document.querySelector('#newProject input[name=tech]').getAttribute('list') === 'techSug'`), '技术栈输入框挂上了建议下拉（datalist）');
await ev(`(() => { const s = document.querySelector('#newProject select[name=type]'); s.focus(); s.value = 'website'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
await sleep(300);   // focus 在里面：SSE 刷新只刷页脚，不会把刚选的值换掉（真人用鼠标选也是这个路径）
const picked = await ev(`(() => ({ wf: document.querySelector('#newProject select[name=workflow]').value,
  hint: document.getElementById('typeHint').textContent, ph: document.querySelector('#newProject input[name=tech]').placeholder }))()`);
ok(picked.wf === 'website', `选「网站 / 静态站」→ 工作流下拉自动切到 ${picked.wf}`);
const flowTxt = (picked.hint.split('流程：')[1] || '').split(' · ')[0].trim();
ok(flowTxt.split(' → ').length === 7 && /部署$/.test(flowTxt) && !/运维/.test(flowTxt),
  `提示行写出该类型的流程（7 步、到部署为止、不做运维）：${flowTxt}`);
ok(/分类技能包 \d+ 条/.test(picked.hint) && /目录规约/.test(picked.hint), `提示行还写出分类技能包与目录规约：${picked.hint.split(' · ').slice(-2).join(' · ')}`);
ok(/HTML5|静态站点/.test(picked.ph), `技术栈占位换成该分类的头号建议：${picked.ph}`);
const sug1 = await ev(`[...document.querySelectorAll('#techSug option')].map(o => o.value)`);
ok(sug1.length >= 2 && sug1.some(x => /Vite/.test(x)) && !sug1.some(x => /Next\.js/.test(x)),
  `建议跟着分类换（网站分类 ${sug1.length} 条）：${sug1.join(' ｜ ')}`);
await setField('#newProject input[name=tech]', sug1[0]);
ok(await ev(`document.querySelector('#newProject input[name=tech]').value`) === sug1[0], `从建议里选一条能填进技术栈：${sug1[0]}`);

const madeName = 'UI 类型检查';
await ev(`(() => { const f = document.getElementById('newProject');
  f.querySelector('input[name="name"]').value = ${JSON.stringify(madeName)};
  f.querySelector('select[name="type"]').value = 'website';
  f.querySelector('select[name="workflow"]').value = 'website';
  f.requestSubmit(); return true; })()`);
await waitFor(async () => (await jget('/api/state')).projects.some(x => x.name === madeName), 20000, '类型项目落库');
const made2 = (await jget('/api/state')).projects.find(x => x.name === madeName);
ok(made2.type === 'website' && made2.workflow === 'website'
  && made2.stages.map(s => s.id).join(',') === 'requirements,ux,architecture,wbs,development,testing,deployment',
  `按类型建出的项目只走该流程（${made2.stages.length} 阶段：${made2.stages.map(s => s.name).join(' → ')}）`);
const cardTxt = await ev(`(() => { const c = [...document.querySelectorAll('.proj-card')].find(x => x.textContent.includes(${JSON.stringify(madeName)}));
  return c ? c.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
ok(/网站/.test(cardTxt), `项目卡上标注了类型：${cardTxt.slice(0, 90)}`);
await shot('61-proj-type.png');

console.log('\n[8.26] 编辑里改软件分类 → 真按新流程重排阶段');
const fresh2 = (await jget('/api/state')).projects.find(x => x.name === madeName);
await waitFor(async () => (await jget(`/api/projects/${fresh2.id}`)).stages[0].status === 'awaiting_review', 30000, '首阶段跑完再改流程');
await ev(`(() => { const c = [...document.querySelectorAll('.proj-card')].find(x => x.dataset.project === ${JSON.stringify(fresh2.id)});
  c.querySelector('[data-edit-project]').click(); return true; })()`);
await waitFor(async () => await ev(`document.getElementById('editProject') !== null`), 8000, '编辑表单打开');
ok(await ev(`document.querySelector('#editProject [name=type]').disabled === false`), '这个项目的分类是可选的');
await ev(`(() => { const s = document.querySelector('#editProject [name=type]'); s.focus(); s.value = 'cli'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
await sleep(300);
const ef2 = await ev(`(() => ({ wf: document.querySelector('#editProject [name=workflow]').value,
  sug: [...document.querySelectorAll('#editTechSug option')].map(o => o.value) }))()`);
ok(ef2.wf === 'lean', `编辑里换分类 → 工作流下拉跟着换成 ${ef2.wf}`);
ok(ef2.sug.some(x => /零依赖 CLI/.test(x)), `技术栈建议也跟着换：${ef2.sug.join(' ｜ ')}`);
await ev(`document.getElementById('editProject').requestSubmit()`);
await waitFor(async () => ((await jget(`/api/projects/${fresh2.id}`)).stages || []).length === 5, 20000, '阶段重排落库');
const afterFlow = await jget(`/api/projects/${fresh2.id}`);
ok(afterFlow.type === 'cli' && afterFlow.workflow === 'lean' && afterFlow.stages.map(s => s.id).join(',') === 'requirements,architecture,wbs,development,testing',
  `真落库并重排阶段：${afterFlow.type} / ${afterFlow.workflow} → ${afterFlow.stages.map(s => s.name).join(' → ')}`);
ok(afterFlow.events.some(e => /重排为「精简交付」/.test(e.text) && /保留 5 个已有阶段/.test(e.text) && /去掉 UI\/UX 设计、部署/.test(e.text)),
  `事件流写明重排明细：${afterFlow.events.filter(e => /重排为/.test(e.text)).at(-1).text.slice(0, 90)}…`);

console.log('\n[8.27] 执行记录：事件流的时间戳列够宽（整行显示不折行）');
await send('Page.navigate', { url: `${BASE}/?view=runs&project=${proj.id}` });
await waitFor(async () => await ev(`document.querySelector('.steps-time .s') !== null`), 20000, '执行记录渲染');
const evRows = await ev(`(() => [...document.querySelectorAll('.steps-time .s')].slice(0, 5).map(r => { const ts = r.children[0], cs = getComputedStyle(ts); return { txt: ts.textContent.trim(), colW: Math.round(r.children[0].getBoundingClientRect().width), lines: Math.round(ts.getBoundingClientRect().height / parseFloat(cs.lineHeight || '16')), nowrap: cs.whiteSpace }; }))()`);
ok(evRows.length >= 3, `执行记录有 ${evRows.length} 条事件（前 5 条取样）`);
ok(evRows.every(r => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(r.txt) && r.lines <= 1 && r.nowrap === 'nowrap'),
  `时间戳一整行显示（不折行）：${evRows[0].txt}（列宽 ${evRows[0].colW}px、行数 ${evRows[0].lines}）`);
ok(evRows.every(r => r.colW >= 120), `时间戳列宽 ≥120px：${evRows.map(r => r.colW).join(' / ')}`);

console.log('\n[9] 页面无未捕获异常（模块加载 / 渲染没炸）');
ok(exceptions.length === 0, exceptions.length ? `发现未捕获异常：${exceptions[0].slice(0, 200)}` : '无未捕获异常');

console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  (PASS=${pass} FAIL=${fail})`);
process.exit(fail === 0 ? 0 : 1);
