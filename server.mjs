/* ============================================================
   server.mjs — 零依赖 HTTP 服务：静态资源 + REST API + SSE 实时推送
   运行：node server.mjs   （默认 http://127.0.0.1:8788）
   ============================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as H from './harness.mjs';
import * as exec from './exec.mjs';
import * as settings from './settings.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 单实例锁 ----------
   同一份数据文件只允许一个 server 在跑（各持一份内存副本、各自 flush 会静默覆盖对方的进度 —— 实测踩过：
   两个实例同时在线，A 里已批准的模块被 B 的旧快照写回「失败」）。 */
const LOCK = `${H.DATA_FILE}.lock`;
fs.mkdirSync(path.dirname(LOCK), { recursive: true });      // AI_PLATFORM_DATA 指到还没建的目录时也别在锁文件上崩掉
try {
  const prev = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  if (prev.pid && prev.pid !== process.pid) {
    let alive = true;
    try { process.kill(prev.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
    if (alive) { console.error(`[server] Another instance is running (pid ${prev.pid}, data ${H.DATA_FILE}); exiting to prevent conflicting writes`); process.exit(1); }
  }
} catch {}
fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), data: H.DATA_FILE }));
const releaseLock = () => { try { if (JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid === process.pid) fs.unlinkSync(LOCK); } catch {} };
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLock(); process.exit(0); });
const PUB = path.join(DIR, 'public');
const PORT = Number(process.env.AI_PLATFORM_PORT || 8788);
const HOST = process.env.AI_PLATFORM_HOST || '127.0.0.1';

H.load();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const clients = new Set();
H.subscribe(ev => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const res of clients) { try { res.write(line); } catch { clients.delete(res); } } });

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', c => { b += c; if (b.length > 4e6) req.destroy(); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });

/** 承認の出どころ：画面のボタンは x-approval-source: dashboard を付ける。無ければ API 直叩き（自動化）扱い。 */
const approvalSource = (req) => (String(req.headers['x-approval-source'] || '').toLowerCase() === 'dashboard' ? 'dashboard' : 'api');

/* ---------- 路由 ---------- */

const routes = [
  ['GET', /^\/api\/state$/, () => ({ ...H.state(), projects: H.state().projects.map(H.withGovernance), channel: H.channelInfo(), runtime: H.runtimeInfo(), stages: H.stagesMeta(), workflows: H.WORKFLOWS, types: H.TYPES, default_model: H.DEFAULT_MODEL })],
  ['GET', /^\/api\/settings$/, () => settings.getAllPublic()],
  ['GET', /^\/api\/settings\/enabled-models$/, () => ({ models: settings.listEnabledModels(), defaultProvider: (settings.getDefaultProvider() || {}).id || '' })],
  ['PUT', /^\/api\/settings\/providers\/([^/]+)$/, async (m, body) => settings.setProvider(m[1], body || {})],
  ['POST', /^\/api\/settings\/providers\/([^/]+)\/test$/, async (m) => settings.testProvider(m[1])],
  ['POST', /^\/api\/settings\/providers\/([^/]+)\/clear$/, async (m) => settings.clearProvider(m[1])],
  ['POST', /^\/api\/settings\/default$/, async (m, body) => settings.setDefaultProvider((body || {}).providerId || '')],
  ['GET', /^\/api\/projects\/([^/]+)$/, (m) => H.must(m[1])],
  ['GET', /^\/api\/projects\/([^/]+)\/workspace$/, (m) => { const p = H.must(m[1]); return { files: exec.listFiles(exec.wsDir(p.id)).map(f => ({ path: f, bytes: fs.statSync(path.join(exec.wsDir(p.id), f)).size })) }; }],
  ['GET', /^\/api\/projects\/([^/]+)\/file$/, (m, body, url) => {
    const p = H.must(m[1]);
    const rel = exec.safeRel(url.searchParams.get('path'));
    if (!rel) throw new H.HttpError(400, 'Invalid path');
    const abs = path.join(exec.wsDir(p.id), rel);
    if (!fs.existsSync(abs)) throw new H.HttpError(404, 'File not found');
    return { path: rel, content: fs.readFileSync(abs, 'utf8') };
  }],
  ['PUT', /^\/api\/projects\/([^/]+)\/file$/, async (m, body) => { const p = H.must(m[1]); return H.editWorkspaceFile(p, body.path, body.content, { editor: body.editor || 'Human' }); }],
  ['POST', /^\/api\/projects\/([^/]+)\/artifacts\/([^/]+)$/, async (m, body) => { const p = H.must(m[1]); return H.editArtifact(p, m[2], { content: body.content, editor: body.editor || 'Human' }); }],
  ['POST', /^\/api\/projects$/, async (m, body) => H.createProject(body)],
  ['PUT', /^\/api\/projects\/([^/]+)$/, (m, body) => H.updateProject(H.must(m[1]), body)],
  ['POST', /^\/api\/projects\/([^/]+)\/inputs$/, (m, body) => H.addInputs(H.must(m[1]), body && body.files)],
  ['POST', /^\/api\/projects\/([^/]+)\/models$/, (m, body) => H.setStageModels(H.must(m[1]), body.models || {})],
  ['POST', /^\/api\/projects\/([^/]+)\/skills$/, (m, body) => H.addSkill(H.must(m[1]), body)],
  ['GET', /^\/api\/skills\/catalog$/, () => ({ skills: H.skillCatalog() })],
  ['POST', /^\/api\/projects\/([^/]+)\/skills\/import$/, (m, body) => H.importSkills(H.must(m[1]), body.ids)],
  ['POST', /^\/api\/projects\/([^/]+)\/skills\/delete$/, (m, body) => H.removeSkills(H.must(m[1]), body && body.ids)],
  ['PUT', /^\/api\/projects\/([^/]+)\/skills\/([^/]+)$/, (m, body) => H.updateSkill(H.must(m[1]), m[2], body)],
  ['DELETE', /^\/api\/projects\/([^/]+)\/skills\/([^/]+)$/, (m) => H.removeSkill(H.must(m[1]), m[2])],
  ['POST', /^\/api\/projects\/([^/]+)\/activate$/, (m) => H.activate(m[1])],
  ['POST', /^\/api\/projects\/([^/]+)\/rebuild$/, (m, body) => H.rebuildProject(m[1], { force: body?.force === true })],
  ['POST', /^\/api\/projects\/([^/]+)\/ledger\/rescan$/, (m, body) => H.rescanLedger(m[1], { replace: body?.replace !== false })],
  ['DELETE', /^\/api\/projects\/([^/]+)$/, (m, body, url) => H.removeProject(m[1], { force: url.searchParams.get('force') === '1' || body.force === true })],
  ['POST', /^\/api\/projects\/([^/]+)\/stages\/([^/]+)\/run$/, (m) => { const p = H.must(m[1]); H.checkStageRunnable(p, m[2]); H.runStage(p, m[2]).catch(e => console.error('[run]', e.message)); return { ok: true }; }],
  ['POST', /^\/api\/projects\/([^/]+)\/stages\/([^/]+)\/approve$/, async (m, body, url, req) => H.approveStage(H.must(m[1]), m[2], body.reviewer, { source: approvalSource(req), ackGaps: body.ack_gaps === true })],
  ['POST', /^\/api\/projects\/([^/]+)\/stages\/([^/]+)\/reject$/, async (m, body) => H.rejectStage(H.must(m[1]), m[2], body)],
  ['POST', /^\/api\/projects\/([^/]+)\/modules\/([^/]+)\/run$/, (m) => { const p = H.must(m[1]); const mod = H.checkModuleRunnable(p, m[2]); H.runModule(p, mod).catch(e => console.error('[run]', e.message)); return { ok: true }; }],
  ['POST', /^\/api\/projects\/([^/]+)\/modules\/([^/]+)\/approve$/, async (m, body, url, req) => H.approveModule(H.must(m[1]), m[2], body.reviewer, { source: approvalSource(req) })],
  ['POST', /^\/api\/projects\/([^/]+)\/modules\/([^/]+)\/reject$/, async (m, body) => H.rejectModule(H.must(m[1]), m[2], body)],
  ['GET', /^\/api\/projects\/([^/]+)\/summary$/, (m) => H.summary(H.must(m[1]))],
  ['GET', /^\/api\/projects\/([^/]+)\/trace$/, (m) => H.trace(H.must(m[1]))],
  ['GET', /^\/api\/projects\/([^/]+)\/asis$/, (m, body, url) => H.asIs(H.must(m[1]), String(url.searchParams.get('screen') || ''))],
  ['POST', /^\/api\/projects\/([^/]+)\/ux\/important$/, (m, body) => H.markImportant(H.must(m[1]), String(body.screen || ''), body.on !== false)],
  ['POST', /^\/api\/projects\/([^/]+)\/skills\/plan$/, (m, body) => H.applySkillPlan(H.must(m[1]), { dryRun: body.dry_run === true })],
  ['POST', /^\/api\/projects\/([^/]+)\/questions\/([^/]+)\/answer$/, async (m, body, url, req) => H.answerQuestion(H.must(m[1]), m[2], { answer: body.answer, by: body.by, source: approvalSource(req) })],
  ['POST', /^\/api\/projects\/([^/]+)\/lessons\/([^/]+)\/approve$/, async (m, body, url, req) => H.approveLesson(H.must(m[1]), m[2], { body: body.body, by: body.by, source: approvalSource(req) })],
  ['POST', /^\/api\/projects\/([^/]+)\/lessons\/([^/]+)\/dismiss$/, async (m, body) => H.dismissLesson(H.must(m[1]), m[2], { by: body.by })],
];

/* ---------- 服务 ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/stream') {
    if (clients.size >= 12) { res.writeHead(503); return res.end('too many streams'); }   // 别让探活连接把浏览器的同源并发槽占满
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', active: H.state().active })}\n\n`);
    clients.add(res);
    let ka;
    const drop = () => { if (ka) clearInterval(ka); clients.delete(res); try { res.end(); } catch { /* 已经断了 */ } };
    // 客户端走了必须收摊：只监听 req.close 会在页面刷新/导航后留下半开连接，
    // 浏览器同源并发（HTTP/1.1 默认 6 条）被这些连接占满后，页面自己的 fetch 会一直排队——表现为「点保存没反应」。
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
    ka = setInterval(() => {
      if (res.writableEnded || res.destroyed) return drop();
      try { res.write(': ka\n\n'); } catch { drop(); }
    }, 20000);
    return;
  }

  if (pathname.startsWith('/api/')) {
    let pathMatched = false;
    for (const [method, re, fn] of routes) {
      const m = pathname.match(re);
      if (!m) continue;
      pathMatched = true;
      if (req.method !== method) continue;          // 同路径不同方法：继续找匹配的那条
      try { return json(res, 200, await fn(m, await readBody(req), url, req)); }
      catch (e) { return json(res, e.status || 500, { error: e.message || 'internal error' }); }
    }
    return pathMatched ? json(res, 405, { error: 'method not allowed' }) : json(res, 404, { error: 'no such api' });
  }

  // 项目预览：/p/<projectId>/… → workspace/<projectId>/…（文件不存在时回落 index.html，供 /course/:id 这类真实路径直接访问/刷新）
  const pv = pathname.match(/^\/p\/([^/]+)(?:\/(.*))?$/);
  if (pv) {
    const dir = /^[A-Za-z0-9._-]+$/.test(pv[1]) ? exec.wsDir(pv[1]) : '';
    const rel = pv[2] ? exec.safeRel(pv[2]) : null;
    let file = dir && rel ? path.join(dir, rel) : '';
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = dir ? path.join(dir, 'index.html') : '';
    if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    // 回落/任意 HTML 都注入 <base>：深链（/p/<id>/course/xx）下页面里的相对资源（./app.mjs、./src/**）才找得到。
    if (path.extname(file) === '.html') {
      const html = fs.readFileSync(file, 'utf8').replace(/<head[^>]*>/i, (m) => `${m}<base href="/p/${pv[1]}/">`);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }

  // 静态
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUB, rel);
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => console.log(`AI Dev Platform · http://${HOST}:${PORT}  (data=${H.DATA_FILE})  (workspace=${process.env.AI_PLATFORM_WORKSPACE || path.join(DIR, 'workspace')})`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { H.flush(); server.close(() => process.exit(0)); });
