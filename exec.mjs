/* ============================================================
   exec.mjs — 真实执行层：工作区文件系统 + 真的跑 node --test
   产出的代码写进 workspace/<projectId>/，単体テスト真的执行，
   门禁读的是真实終了コード与统计，不是编出来的数字。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.AI_PLATFORM_WORKSPACE || path.join(DIR, 'workspace');

export const wsDir = (id) => path.join(ROOT, id);

/** 合法相对路径：允许 CJK/假名目录名（Windows 盘符、`..`、绝对路径一律拒），统一归一成 NFC。
    ponytail: macOS 的 readdir 可能回 NFD，字符串比对会不相等 —— 归属判定以模块生成records里的原路径为准（见 harness.mjs 的 moduleOfFile）。 */
const REL_NAME = /^[\w\u3040-\u30ff\u4e00-\u9fff][\w\u3040-\u30ff\u4e00-\u9fff./-]*$/;
export function safeRel(p) {
  const s = String(p || '').normalize('NFC').replace(/\\/g, '/').trim();
  if (!s || s.startsWith('/') || s.includes('..') || /^[a-zA-Z]:/.test(s)) return null;
  if (!REL_NAME.test(s)) return null;
  return s;
}

export function writeFiles(root, files) {
  const written = [];
  for (const f of files || []) {
    const rel = safeRel(f && f.path);
    if (!rel || typeof f.content !== 'string') continue;
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
    written.push({ path: rel, loc: f.content.split('\n').length, bytes: Buffer.byteLength(f.content) });
  }
  return written;
}

/** 读一files的行数与字节数（用于产物/文件列表显示真实规模）。 */
export function statOf(root, rel) {
  try { const c = fs.readFileSync(path.join(root, rel), 'utf8'); return { loc: c.split('\n').length, bytes: Buffer.byteLength(c) }; }
  catch { return { loc: 0, bytes: 0 }; }
}

export function listFiles(root) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === '__pycache__' || e.name.endsWith('.pyc')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else out.push(path.relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

/** 单个测试命令的硬超时（默认 120s；单测里设短值来验证「挂住的测试不会挂住整条流水线」）。 */
const TEST_TIMEOUT_MS = () => Number(process.env.AI_PLATFORM_TEST_TIMEOUT_MS || 120000);

function run(cmd, args, cwd, timeoutMs, extraEnv = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // 关键：清掉测试运行器的继承变量，否则在被 node --test 驱动的进程里再跑 node --test
    // 会被判定为「递归调用」而直接跳过执行 → 終了コード 0 但零输出（假绿）。
    const env = { ...process.env, NODE_NO_WARNINGS: '1', ...extraEnv };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_V8_COVERAGE;
    // detached：自己起一个进程组，超时能连子孙一起杀（node --test 会把测试文件当子进程跑，
    // 只杀父进程的话孙进程还攥着管道 → 'close' 永不触发 → 整条流水线卡死在这儿）。
    const p = spawn(cmd, args, { cwd, env, detached: true });
    let out = '';
    let done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(killer); resolve({ code, out, ms: Date.now() - t0 }); };
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    const killer = setTimeout(() => {
      try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} }   // 整组杀
      out += `\n[timeout ${timeoutMs}ms, process group force-killed]`;
      finish(-1);                                                                              // 不等 close：可能永远等不到
    }, timeoutMs);
    p.on('close', (code) => finish(code));
    p.on('error', (e) => { out += String(e.message); finish(-1); });
  });
}

/** 真实执行测试：按栈档案选运行器（Node / Java / Python），统计从真实输出解析。 */
export async function runTests(root, target = 'test/', profile = PROFILES.node, ownFiles = null) {
  if (profile.id === 'java' || profile.id === 'cap-java') return runJava(root, target, ownFiles);
  if (profile.id === 'python') return runPython(root, target);
  if (profile.id === 'ts-node') return runTs(root, target);
  return runNodeTests(root, target);
}

/** 真实执行 `node --test <target>`，从真实输出里解析统计。
    Node v24 bug：直接传目录会被 require() 处理而挂掉；目录参数自动展开为 test/ 下显式文件列表。 */
export async function runNodeTests(root, target = 'test/', profile = PROFILES.node, ownFiles = null) {
  // 目录参数 → 展开为 test/**/*.test.mjs。
  let args;
  if (typeof target === 'string' && (target.endsWith('/') || !/\.test\.[a-z]+$/.test(target))) {
    const list = listFiles(root).filter((f) => /^test\/.+?\.test\.(?:m?js|cjs)$/.test(f));
    if (list.length) args = ['--test', ...list];
  }
  if (!args) args = ['--test', target];
  const cmd = `node ${args.join(' ')}`;
  const { code, out, ms } = await run(process.execPath, args, root, TEST_TIMEOUT_MS());
  const timedOut = code === -1 && /\[timeout \d+ms, process group force-killed\]/.test(out);
  const num = (k) => { const m = out.match(new RegExp(`^[\\sℹ#]*${k}\\s+(\\d+)\\s*$`, 'm')); return m ? Number(m[1]) : null; };
  let total = num('tests'), passed = num('pass'), failed = num('fail');
  if (total === null) {                       // 回退：数 ✔/✖（TAP/spec 两种输出都覆盖）
    passed = (out.match(/^(?:ok|✔)/gm) || []).length;
    failed = (out.match(/^(?:not ok|✖)/gm) || []).length;
    total = passed + failed;
  }
  // 没有任何输出却退出 0 = 根本没跑（例如运行器递归跳过），不许当成通过。
  const ran = out.trim().length > 0;
  if (!ran) { total = 0; passed = 0; failed = 0; }
  return {
    cmd, exit_code: ran ? code : -1, total, passed, failed, ms, timed_out: timedOut,
    ok: ran && code === 0 && failed === 0,
    at: new Date().toISOString(), tail: out.slice(-1200) || '(no output: tests did not actually run)',
  };
}

/** 真实構文チェック：.mjs/.js 用 node --check，.py 用 python3 -m py_compile（Java checked by javac）。 */
export async function checkSyntax(root) {
  const all = listFiles(root);
  const files = all.filter(f => /\.(mjs|js|cjs)$/.test(f));
  const errors = [];
  for (const f of files) {
    const { code, out } = await run(process.execPath, ['--check', f], root, 20000);
    if (code !== 0) errors.push({ file: f, error: out.split('\n').slice(0, 3).join(' ').trim() });
  }
  const pys = all.filter(f => /\.py$/.test(f));
  const py = findPython();
  for (const f of pys) {
    if (!py) { errors.push({ file: f, error: 'python3 missing — cannot run syntax check' }); continue; }
    const { code, out } = await run(py, ['-m', 'py_compile', f], root, 20000);
    if (code !== 0) errors.push({ file: f, error: out.split('\n').slice(-3).join(' ').trim() });
  }
  const javas = all.filter(f => /\.java$/.test(f));
  return { checked: files.length + pys.length + javas.length, errors, ok: errors.length === 0,
    byLang: { js: files.length, py: pys.length, java: javas.length } };   // java 不单独查：由 runJava 的 javac 编译覆盖
}

/** 上传文件名归一：只取 basename，去掉路径分隔符/控制字符，保留 CJK 与扩展名；空则回落。 */
export function safeName(name, fallback = 'file') {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
  const cleaned = base.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')          // 控制字符
    .replace(/[<>:"|?*]/g, '_')                     // 文件系统敏感字符
    .replace(/^\.+/, '')                            // 别变成 . 或 ..
    .trim().slice(0, 80);
  return cleaned || `${fallback}-${Date.now().toString(36)}.txt`;
}

/** 写项目输入materials到 inputs/ 下（内容为空/含 NUL 的二进制文件跳过）。 */
export function writeInputs(root, files) {
  const out = [], skipped = [];
  for (const f of files || []) {
    const name = safeName(f && f.name);
    const content = typeof (f && f.content) === 'string' ? f.content : '';
    if (!content.trim()) { skipped.push({ name, why: 'content is empty' }); continue; }
    if (content.includes('\u0000')) { skipped.push({ name, why: 'binary file (contains NUL); text only' }); continue; }
    const rel = `inputs/${name}`;
    const written = writeFiles(root, [{ path: rel, content }])[0];
    if (!written) { skipped.push({ name, why: 'invalid file name' }); continue; }
    out.push({ name, path: rel, bytes: written.bytes, loc: written.loc, excerpt: content.slice(0, 4000), at: new Date().toISOString() });
  }
  return { inputs: out, skipped };
}

export function rmWorkspace(id) { stopPostgres(wsDir(id)); fs.rmSync(wsDir(id), { recursive: true, force: true }); }

/** 清掉工作区里的**生成物**，保留 keep 列出的目录（缺省 inputs/ —— 用户上传的输入materials不是产物）。
    返回删掉的顶层条目名，便于事件里记账。 */
export function clearWorkspace(id, { keep = ['inputs'] } = {}) {
  const dir = wsDir(id);
  if (!fs.existsSync(dir)) return [];
  const gone = [];
  for (const name of fs.readdirSync(dir)) {
    if (keep.includes(name)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    gone.push(name);
  }
  return gone;
}

/* ============================================================
   多语言栈：技術スタック → 路径规约 + 真实工具链
   Node 零依赖；Java 走 javac/java；Python 走 python3（stdlib unittest）。
   工具链缺失 ⇒ 明确失败并説明缺什么，绝不静默退回 Node。
   ============================================================ */

/* 路径规约（按栈档案）：源码直接落在レイヤーディレクトリ里 —— 不为模块建文件夹，文件名也**不带 WBS 序号**，
   用业务语义命名（OrderService.java / order-service.mjs / order_service.py），同层靠business-name区分。 */
export const PROFILES = {
  node: { id: 'node', label: 'Node.js（ESM / node --test）', ext: '.mjs', cds: false,
    modDir: (layer) => `src/${layer}`,
    testPath: (layer, file) => `test/${layer}/${file}` },
  python: { id: 'python', label: 'Python（stdlib unittest）', ext: '.py', cds: false,
    modDir: (layer) => `src/${layer}`,
    testPath: (layer, file) => `test/${layer}/${file}` },
  java: { id: 'java', label: 'Java（javac + java）', ext: '.java', cds: false,
    modDir: (layer) => `src/main/java/${layer}`,
    testPath: (layer, file) => `src/test/java/${layer}/${file}` },
  capJava: { id: 'cap-java', label: 'SAP CAP Java（CDS + Java，javac + java）', ext: '.java', cds: true,
    modDir: (layer) => `src/main/java/${layer}`,
    testPath: (layer, file) => `src/test/java/${layer}/${file}` },
  capNode: { id: 'cap-node', label: 'SAP CAP Node.js（CDS + ESM，node --test）', ext: '.mjs', cds: true,
    modDir: (layer) => `src/${layer}`,
    testPath: (layer, file) => `test/${layer}/${file}` },
  ts: { id: 'ts-node', label: 'TypeScript（NestJS / Next.js + PostgreSQL · npm allowlist · tsx + node --test）', ext: '.ts', cds: false, deps: true,
    modDir: (layer) => `src/${layer}`,
    testPath: (layer, file) => `test/${layer}/${file}` },
};
/** 技術スタック文本 → 栈档案。判不出就 Node（平台默认，零依赖）。 */
export function profileOf(tech = '') {
  const s = String(tech || '').toLowerCase();
  if (/python|django|flask|fastapi/.test(s)) return PROFILES.python;
  const cap = /sap\s*cap|\bcap\b|\brap\b|\bcds\b/.test(s);
  if (cap) return /java(?!script)|spring|kotlin/.test(s) ? PROFILES.capJava : PROFILES.capNode;
  if (/java(?!script)|spring|struts|kotlin|quarkus/.test(s)) return PROFILES.java;
  // 宣言が framework/DB 前提なら依存ありの TS 档案（npm install が通る前提）。素の「TypeScript / React」は従来どおり Node。
  if (/\bnest(?:\.?js)?\b|next\.?js|postgres/.test(s)) return PROFILES.ts;
  return PROFILES.node;
}

const isExec = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
function which(bin) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) if (d && isExec(path.join(d, bin))) return path.join(d, bin);
  return null;
}

/** 真跑一把 `javac -version`：macOS 的 /usr/bin/javac 是个「没装 JDK」的桩，光看可执行位会被骗。 */
const javaOk = (dir) => {
  const jc = path.join(dir, 'javac');
  try {
    const r = spawnSync(jc, ['-version'], { encoding: 'utf8', timeout: 20000 });
    return r.status === 0 && /^javac\s+\d/m.test(String(r.stdout || '') + String(r.stderr || ''));
  } catch { return false; }
};

/** 找一个可用的 java/javac。JAVA_HOME → PATH → Homebrew keg（macOS 上 keg-only 不链接进 PATH）。 */
export function findJava() {
  if (process.env.AI_PLATFORM_NO_JDK) return null;            // test hook: simulate "no JDK on machine"
  const home = process.env.JAVA_HOME;
  const inPath = which('javac') ? [path.dirname(which('javac'))] : [];
  const dirs = [
    home && path.join(home, 'bin'),
    '/opt/homebrew/opt/openjdk@21/bin', '/opt/homebrew/opt/openjdk/bin', '/opt/homebrew/opt/openjdk@27/bin',
    '/usr/local/opt/openjdk/bin',
    ...inPath,
    ...String(process.env.PATH || '').split(path.delimiter),
  ].filter(Boolean);
  for (const d of [...new Set(dirs)]) {
    if (isExec(path.join(d, 'java')) && javaOk(d)) return { javac: path.join(d, 'javac'), java: path.join(d, 'java'), home: d };
  }
  return null;
}

export function findPython() {
  if (process.env.AI_PLATFORM_NO_PYTHON) return null;          // test hook: simulate "no python3 on machine"
  const c = which('python3') || (isExec('/usr/bin/python3') ? '/usr/bin/python3' : null);
  return c;
}

export const toolchain = (profile) => profile.id === 'python'
  ? (findPython() ? { ok: true, cmd: findPython() } : { ok: false, why: 'python3 missing (real execution requires stdlib unittest runner)' })
  : (profile.id === 'java' || profile.id === 'cap-java')
    ? (findJava() ? { ok: true, ...findJava() } : { ok: false, why: 'JDK missing (java/javac not in PATH, and JAVA_HOME not found)' })
    : profile.id === 'ts-node'
      ? (findNpm() ? { ok: true, cmd: findNpm() } : { ok: false, why: 'npm missing (TypeScript profile needs npm install for its allowlisted dependencies)' })
      : { ok: true, cmd: process.execPath };

/* ---------- 环境自举：缺工具链就自己装并配好（预设技能 `env-环境自举` 的落地） ---------- */

/** 各工具链的安装计划：系统包管理器优先，没有安装通道就返回 null（交回调用方明确失败）。 */
export function installPlan(kind) {
  if (process.env.AI_PLATFORM_INSTALL_CMD)                    // 自定义/测试通道：整条命令交给 sh（自带引号处理）
    return ['sh', '-c', process.env.AI_PLATFORM_INSTALL_CMD];
  const brew = which('brew') || (isExec('/opt/homebrew/bin/brew') ? '/opt/homebrew/bin/brew' : null);
  if (!brew) return null;
  return kind === 'python' ? [brew, 'install', 'python@3.12'] : [brew, 'install', 'openjdk@21'];
}

/**
 * 缺工具链 → 自己装一次，装完重探。返回 null = 不需要装（已有 / 关掉自举 / 没有安装通道）。
 * 钩子：`AI_PLATFORM_NO_INSTALL=1` 关掉自举（测试与 CI，避免在别人机器上真装）；
 * `probe` / `plan` 可注入，用来测「装了没装上」两条路而不碰真机。超时 15 分钟（brew 拉大包够用）。
 */
export async function ensureToolchain(kind, { probe, plan } = {}) {
  const find = probe || (kind === 'python' ? findPython : findJava);
  if (find()) return null;                                    // 有就不动
  if (process.env.AI_PLATFORM_NO_INSTALL) return null;
  const cmd = plan || installPlan(kind);
  if (!cmd) return null;                                      // 没有安装通道 → 明确失败，不假装装过
  const r = await run(cmd[0], cmd.slice(1), DIR, 900000);
  return { kind, cmd: cmd.join(' '), code: r.code, ok: !!find(), tail: r.out.slice(-400) };
}

/** 取工具链：缺就先自举一次再重探；仍不可用时把「已经试过装」写进原因，别让人以为是没试。 */
async function toolchainOrProvision(profile, kind) {
  const tc = toolchain(profile);
  if (tc.ok) return tc;
  const b = await ensureToolchain(kind);
  const again = toolchain(profile);
  if (again.ok) return { ...again, bootstrapped: b };
  return { ok: false, why: b ? `${again.why}; auto-install of \`${b.cmd}\` (exit code ${b.code}) did not produce a working toolchain` : again.why };
}

const nowIso = () => new Date().toISOString();
const miss = (why, cmd = '(not executed)') => ({ cmd, exit_code: -1, total: 0, passed: 0, failed: 0, ms: 0, ok: false, at: nowIso(), tail: why });

/** 真实执行 Java：javac 编译工作区所有 .java → java 跑测试类（默认包；带 package 声明的自动补前缀）。 */
export async function runJava(root, testPath = '', ownFiles = null) {
  const tc = await toolchainOrProvision(PROFILES.java, 'java');
  if (!tc.ok) return miss(`✕ ${tc.why} — do NOT silently fall back to Node; module marked failed`, 'javac/java (not found)');
  const all = listFiles(root).filter(f => f.endsWith('.java'));
  // 模块级执行只编「本模块自己的 .java + 本模块的测试」：没有 package、全工作区共用一个 classpath，
  // 两个层各写一个同名类（Order / ApiResponse）就是 `クラスXが重複しています`，一个层的问题会让**每个**模块全红。
  // 集成阶段（ownFiles=null）仍编全工作区 —— 那正是要看各层能不能真的 compose。
  const want = ownFiles ? new Set([...ownFiles.filter(f => f.endsWith('.java')), testPath]) : null;
  const srcs = want ? all.filter(f => want.has(f)) : all;
  if (!srcs.length) return miss('no .java source files in workspace', 'javac (no input)');
  const outDir = '.build';
  const javacArgs = ['-encoding', 'UTF-8', '-d', outDir, ...srcs];
  const cmd = `javac -d ${outDir} <${srcs.length} .java file(s)${want ? ' · this module' : ' · entire workspace'}> && java -cp ${outDir} <TestClass>`;
  const cmp = await run(tc.javac, javacArgs, root, 180000);
  if (cmp.code !== 0) return { ...miss(`compilation failed:\n${cmp.out.slice(-1200)}`, cmd), exit_code: cmp.code, ms: cmp.ms };
  const rel = String(testPath || '').replace(/\\/g, '/');
  const cls = path.basename(rel).replace(/\.java$/, '') || 'Main';
  let pkg = '';
  try { const m = fs.readFileSync(path.join(root, rel), 'utf8').match(/^\s*package\s+([\w.]+)\s*;/m); if (m) pkg = m[1] + '.'; } catch { /* 测试文件不在就不管，java 会自己报错 */ }
  const r = await run(tc.java, ['-Dfile.encoding=UTF-8', '-cp', outDir, pkg + cls], root, 180000);
  const num = (k) => { const m = r.out.match(new RegExp(`^\\s*${k}\\s+(\\d+)\\s*$`, 'm')); return m ? Number(m[1]) : null; };
  let total = num('tests'), passed = num('pass'), failed = num('fail');
  if (total === null) {                                        // 回退：数 not ok / 終了コード
    failed = (r.out.match(/^not ok/gm) || []).length; passed = (r.out.match(/^ok\b/gm) || []).length; total = passed + failed;
  }
  const ran = r.out.trim().length > 0;
  return {
    cmd, exit_code: ran ? r.code : -1, total, passed, failed, ms: cmp.ms + r.ms,
    ok: ran && r.code === 0 && failed === 0 && (total || 0) > 0,
    at: nowIso(), tail: `--- javac ---\n${cmp.out.slice(-400)}\n--- java ---\n${r.out.slice(-1200)}`.trim(),
  };
}

/** 真实执行 Python：python3 直接跑测试文件（文件尾部自带 unittest.main()）。 */
export async function runPython(root, testPath = '') {
  const tc = await toolchainOrProvision(PROFILES.python, 'python');
  if (!tc.ok) return miss(`✕ ${tc.why} — do NOT silently fall back to Node; module marked failed`, 'python3 (not found)');
  const py = tc.cmd;
  const rel = exec_safe(testPath);
  if (!rel) return miss(`invalid test path: ${testPath}`, 'python3 (no input)');
  const cmd = `python3 ${rel}`;
  const r = await run(py, [rel], root, 180000);
  const m = r.out.match(/^Ran (\d+) tests?/m);
  const bad = (r.out.match(/FAILED \(([^)]*)\)/) || [, ''])[1];
  const n = (k) => Number((bad.match(new RegExp(`${k}=(\\d+)`)) || [, 0])[1]);
  const failed = bad ? n('failures') + n('errors') : 0;
  const total = m ? Number(m[1]) : failed;
  const okd = /^OK\b/m.test(r.out);
  return {
    cmd, exit_code: r.code, total, passed: Math.max(0, total - failed), failed, ms: r.ms,
    ok: r.code === 0 && okd && total > 0, at: nowIso(), tail: r.out.slice(-1200),
  };
}
const exec_safe = (p) => { const s = safeRel(p); return s && /\.py$/.test(s) ? s : null; };

/** 工作区整体测试：工作区里有哪些语言的产物就跑哪些（集成/部署阶段用）。 */
export async function runWorkspaceTests(root) {
  const files = listFiles(root);
  const ts = files.some(f => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'));
  // TS 工作区里的 .js 多半是 next.config.js 之类的配置：只有真有 *.test.mjs 时才另跑 node --test。
  const has = { node: ts ? files.some(f => /^test\/.+\.test\.(?:m?js|cjs)$/.test(f)) : files.some(f => /\.(mjs|js|cjs)$/.test(f)),
    python: files.some(f => f.endsWith('.py')), java: files.some(f => f.endsWith('.java')), ts };
  const parts = [];
  if (has.ts) parts.push(await runTs(root, 'test/'));
  if (has.java) parts.push(await runJava(root, files.filter(f => /Test\.java$/.test(f)).sort((a, b) => a.localeCompare(b))[0] || ''));
  for (const f of files.filter(f => /\.test\.py$/.test(f))) parts.push(await runPython(root, f));
  if (has.node) parts.push(await runNodeTests(root, 'test/'));
  if (!parts.length) return miss('no executable test artifacts in workspace', '(none)');
  const sum = (k) => parts.reduce((a, p) => a + (p[k] || 0), 0);
  return {
    cmd: parts.map(p => p.cmd).join('  &&  '), exit_code: (parts.find(p => p.exit_code !== 0) || { exit_code: 0 }).exit_code,
    total: sum('total'), passed: sum('passed'), failed: sum('failed'), ms: sum('ms'),
    ok: parts.every(p => p.ok), at: nowIso(), tail: parts.map(p => p.tail).join('\n---\n').slice(-2000),
    skipped: sum('skipped'), ...(parts.find(p => p.db) ? { db: parts.find(p => p.db).db } : {}),
    ...(parts.find(p => p.install) ? { install: parts.find(p => p.install).install } : {}),
  };
}

/** CDS 構造検証（不是编译器：没有 cds-dk 就没法真编译，这里只查结构，别当成编译通过）。 */
export function checkCds(root) {
  const files = listFiles(root).filter(f => f.endsWith('.cds'));
  const errors = [];
  for (const f of files) {
    const c = fs.readFileSync(path.join(root, f), 'utf8');
    const open = (c.match(/\{/g) || []).length, close = (c.match(/\}/g) || []).length;
    if (open !== close) errors.push({ file: f, error: `unbalanced braces ({ ${open} open / } ${close} close)` });
    if (!/\b(namespace|entity|service|type|aspect)\b/.test(c)) errors.push({ file: f, error: 'missing namespace/entity/service/type/aspect declaration' });
    for (const m of c.matchAll(/entity\s+([\w.]+)\s*(?::\s*[\w.]+\s*)?\{([\s\S]*?)\n\s*\}/g)) {
      if (!/\bkey\b/.test(m[2])) errors.push({ file: f, error: `entity ${m[1]} has no key element` });
    }
  }
  return { kind: 'cds-structural', files: files.length, errors, ok: errors.length === 0, at: nowIso() };
}

/* ============================================================
   TypeScript 档案（NestJS / Next.js / PostgreSQL）：工作区自带真 package.json，
   依存は許可リストから平台が版を固定 → npm install（キャッシュ・オフライン耐性）→ tsx + node --test
   （package.json が jest / vitest を宣言していればそれで実行）。
   PostgreSQL は Docker で起動して DATABASE_URL を注入。Docker が無ければ「skipped」と明記し、緑にはしない。
   ============================================================ */

/** 依存許可リスト：名前 → 平台が固定するバージョン範囲。モデルは名前だけ要求でき、版は選べない。
    `AI_PLATFORM_NPM_ALLOW=name@range,name2` で案件ごとに追加可（範囲省略は "*"）。 */
export const NPM_ALLOW = {
  '@nestjs/common': '^10.4.0', '@nestjs/core': '^10.4.0', '@nestjs/testing': '^10.4.0', '@nestjs/platform-express': '^10.4.0', express: '^4.21.0',
  'reflect-metadata': '^0.2.2', rxjs: '^7.8.1', 'class-validator': '^0.14.1', 'class-transformer': '^0.5.1', zod: '^3.23.0',
  next: '^14.2.0', react: '^18.3.1', 'react-dom': '^18.3.1',
  pg: '^8.13.0',
  typescript: '^5.6.0', tsx: '^4.19.0', '@types/node': '^22.0.0', '@types/pg': '^8.11.0', '@types/react': '^18.3.0', '@types/express': '^4.17.21',
  jest: '^29.7.0', 'ts-jest': '^29.2.0', '@types/jest': '^29.5.0', vitest: '^2.1.0',
};
const DEV_ONLY = new Set(['typescript', 'tsx', 'jest', 'ts-jest', 'vitest', '@nestjs/testing']);
export function npmAllow() {
  const extra = {};
  for (const x of String(process.env.AI_PLATFORM_NPM_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const at = x.lastIndexOf('@');
    if (at > 0) extra[x.slice(0, at)] = x.slice(at + 1) || '*'; else extra[x] = '*';
  }
  return { ...NPM_ALLOW, ...extra };
}

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022', module: 'commonjs', moduleResolution: 'node', lib: ['ES2022', 'DOM'], jsx: 'react-jsx',
    strict: true, esModuleInterop: true, skipLibCheck: true, experimentalDecorators: true, emitDecoratorMetadata: true,
    outDir: 'dist', rootDir: '.',
  },
  include: ['src', 'test'],
};

/** stack 文本 → 平台基线依存（NestJS 系は常に、PostgreSQL 宣言なら pg も）。 */
function baselineDeps(stack = '') {
  const s = String(stack).toLowerCase();
  const deps = ['reflect-metadata', 'rxjs', '@nestjs/common', '@nestjs/core'];
  if (/postgres|\bpg\b/.test(s)) deps.push('pg', '@types/pg');
  return [...deps, 'typescript', 'tsx', '@types/node'];
}

const readPkg = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return null; } };
const pkgDeps = (pkg) => ({ ...((pkg && pkg.dependencies) || {}), ...((pkg && pkg.devDependencies) || {}) });

/**
 * package.json / tsconfig.json を用意し、要求された依存を許可リストで篩って追記する。
 * 返り値：{ added, rejected }（rejected は許可リスト外 —— 追記しない。呼び出し側がイベントに出す）。
 */
export function ensurePackageJson(root, { stack = '', deps = [] } = {}) {
  const allow = npmAllow();
  const file = path.join(root, 'package.json');
  fs.mkdirSync(root, { recursive: true });
  const pkg = readPkg(root) || { name: 'workspace', version: '0.0.0', private: true, scripts: { test: 'node --import tsx --test' } };
  pkg.dependencies = pkg.dependencies || {}; pkg.devDependencies = pkg.devDependencies || {};
  const added = [], rejected = [];
  const want = [...(readPkg(root) ? [] : baselineDeps(stack)), ...(Array.isArray(deps) ? deps : [])]
    .map(d => String(d || '').trim().replace(/@[\^~]?[\d.x*]+$/, '')).filter(Boolean);   // 版指定は捨てる：版は平台が決める
  for (const name of [...new Set(want)]) {
    if (!Object.hasOwn(allow, name)) { rejected.push(name); continue; }
    if (pkgDeps(pkg)[name]) continue;
    (DEV_ONLY.has(name) || name.startsWith('@types/') ? pkg.devDependencies : pkg.dependencies)[name] = allow[name];
    added.push(name);
  }
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  const tsc = path.join(root, 'tsconfig.json');
  if (!fs.existsSync(tsc)) fs.writeFileSync(tsc, JSON.stringify(TSCONFIG, null, 2) + '\n');
  return { added, rejected };
}

export function findNpm() {
  if (process.env.AI_PLATFORM_NO_NPM) return null;              // test hook: simulate "no npm on machine"
  if (process.env.AI_PLATFORM_NPM) return process.env.AI_PLATFORM_NPM;
  const side = path.join(path.dirname(process.execPath), 'npm');
  return isExec(side) ? side : which('npm');
}

const NPM_TIMEOUT_MS = () => Number(process.env.AI_PLATFORM_NPM_TIMEOUT_MS || 600000);
const INSTALL_STAMP = path.join('node_modules', '.ai-platform-install.json');

/**
 * npm install（--ignore-scripts：postinstall は走らせない）。
 * キャッシュ：package.json の内容ハッシュが前回成功時と同じ & node_modules があれば実行しない。
 * オフライン耐性：--prefer-offline → 通常 → --offline の順に試す（古いメタデータで ETARGET になる事があるため）。
 * 許可リスト外の依存が package.json にあれば install せずに失敗（モデルが package.json を直接書いた場合）。
 */
export async function npmInstall(root) {
  const npm = findNpm();
  if (!npm) return { ok: false, why: 'npm missing', cmd: 'npm install (not executed)' };
  const pkg = readPkg(root);
  if (!pkg) return { ok: false, why: 'package.json missing', cmd: 'npm install (not executed)' };
  const allow = npmAllow();
  const bad = Object.keys(pkgDeps(pkg)).filter(n => !Object.hasOwn(allow, n));
  if (bad.length) return { ok: false, why: `dependencies outside the allowlist: ${bad.join(', ')}`, cmd: 'npm install (refused)' };
  const hash = crypto.createHash('sha1').update(JSON.stringify({ d: pkg.dependencies || {}, v: pkg.devDependencies || {} })).digest('hex');
  try {
    const st = JSON.parse(fs.readFileSync(path.join(root, INSTALL_STAMP), 'utf8'));
    if (st.hash === hash) return { ok: true, cached: true, cmd: 'npm install (cached)', ms: 0 };
  } catch { /* 初回 or 変更あり */ }
  const base = ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'];
  const tries = [['--prefer-offline'], [], ['--offline']];
  let last = null, ms = 0;
  for (const extra of tries) {
    const r = await run(npm, [...base, ...extra], root, NPM_TIMEOUT_MS());
    ms += r.ms; last = { ...r, args: extra };
    if (r.code === 0) {
      fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(root, INSTALL_STAMP), JSON.stringify({ hash, at: nowIso(), mode: extra[0] || 'online' }));
      return { ok: true, cached: false, cmd: `npm ${[...base, ...extra].join(' ')}`, ms, mode: extra[0] || 'online' };
    }
  }
  return { ok: false, why: `npm install failed (prefer-offline / online / offline all failed): ${last.out.slice(-600)}`, cmd: `npm ${base.join(' ')}`, ms };
}

/* ---------- PostgreSQL（統合テスト用）：Docker で postgres:16 を起動、無ければ明示 skip ---------- */

export function findDocker() {
  if (process.env.AI_PLATFORM_NO_DOCKER) return null;           // test hook: simulate "no Docker"
  for (const c of [which('docker'), '/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'])
    if (c && isExec(c)) return c;
  return null;
}
const PG_MARK = '.aip-postgres.json';
const pgName = (root) => `aip-pg-${crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 10)}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** この工作区は DB を必要とするか：pg/typeorm 依存 or テストが DATABASE_URL を参照。 */
export function needsPostgres(root) {
  const deps = pkgDeps(readPkg(root));
  if (deps.pg || deps.typeorm) return true;
  return listFiles(root).filter(f => /^test\/.+\.(?:ts|tsx|mjs|js)$/.test(f))
    .some(f => { try { return /DATABASE_URL/.test(fs.readFileSync(path.join(root, f), 'utf8')); } catch { return false; } });
}

/**
 * PostgreSQL を用意：AI_PLATFORM_DATABASE_URL があればそれ（external）、無ければ Docker で工作区専用コンテナを起動/再利用。
 * 返り値 status：'external' | 'ready' | 'skipped'（why 付き）。skipped は「統合テストを走らせていない」の意味で、成功ではない。
 */
export async function ensurePostgres(root) {
  if (process.env.AI_PLATFORM_DATABASE_URL) return { status: 'external', url: process.env.AI_PLATFORM_DATABASE_URL };
  const docker = findDocker();
  if (!docker) return { status: 'skipped', why: 'Docker not installed — PostgreSQL integration tests not run' };
  const info = await run(docker, ['info', '--format', '{{.ServerVersion}}'], root, 20000);
  if (info.code !== 0) return { status: 'skipped', why: `Docker daemon not reachable — PostgreSQL integration tests not run (${info.out.trim().split('\n').pop().slice(0, 160)})` };
  const name = pgName(root);
  const image = process.env.AI_PLATFORM_PG_IMAGE || 'postgres:16-alpine';
  const running = await run(docker, ['inspect', '-f', '{{.State.Running}}', name], root, 20000);
  if (running.code !== 0 || running.out.trim() !== 'true') {
    await run(docker, ['rm', '-f', name], root, 20000);
    const up = await run(docker, ['run', '-d', '--name', name, '--label', 'ai-platform=postgres',
      '-e', 'POSTGRES_USER=aip', '-e', 'POSTGRES_PASSWORD=aip', '-e', 'POSTGRES_DB=app', '-p', '127.0.0.1::5432', image], root, 300000);
    if (up.code !== 0) return { status: 'skipped', why: `docker run ${image} failed — PostgreSQL integration tests not run: ${up.out.trim().slice(-300)}` };
  }
  const t0 = Date.now();
  for (;;) {
    const r = await run(docker, ['exec', name, 'pg_isready', '-U', 'aip', '-d', 'app'], root, 10000);
    if (r.code === 0) break;
    if (Date.now() - t0 > 60000) return { status: 'skipped', why: `PostgreSQL container ${name} did not become ready in 60s — integration tests not run` };
    await sleep(1000);
  }
  const port = (await run(docker, ['port', name, '5432/tcp'], root, 10000)).out.match(/:(\d+)\s*$/m);
  if (!port) return { status: 'skipped', why: `could not read published port of ${name} — integration tests not run` };
  try { fs.writeFileSync(path.join(root, PG_MARK), JSON.stringify({ container: name, image, at: nowIso() })); } catch {}
  return { status: 'ready', container: name, image, url: `postgres://aip:aip@127.0.0.1:${port[1]}/app`, ms: Date.now() - t0 };
}

/** 工作区削除時：起動していたコンテナを片付ける（マーカーがある時だけ docker を呼ぶ）。 */
export function stopPostgres(root) {
  if (!fs.existsSync(path.join(root, PG_MARK))) return;
  const docker = findDocker();
  if (docker) try { spawnSync(docker, ['rm', '-f', pgName(root)], { timeout: 20000 }); } catch {}
}

/** jest（"Tests: 1 failed, 2 passed, 3 total"）/ vitest（"Tests  1 failed | 2 passed (3)"）/ node --test の集計。 */
export function parseTestCounts(out) {
  const node = (k) => { const m = out.match(new RegExp(`^[\\sℹ#]*${k}\\s+(\\d+)\\s*$`, 'm')); return m ? Number(m[1]) : null; };
  if (node('tests') !== null) return { passed: node('pass') || 0, failed: (node('fail') || 0) + (node('cancelled') || 0), skipped: (node('skipped') || 0) + (node('todo') || 0) };
  const line = (out.match(/^\s*Tests:?\s+.*\d.*$/m) || [''])[0];
  if (line) {
    const n = (k) => Number((line.match(new RegExp(`(\\d+) ${k}`)) || [, 0])[1]);
    return { passed: n('passed'), failed: n('failed'), skipped: n('skipped') + n('todo') };
  }
  return { passed: (out.match(/^(?:ok|✔)/gm) || []).length, failed: (out.match(/^(?:not ok|✖)/gm) || []).length, skipped: 0 };
}

/** 真实执行 TS：package.json → npm install → (PostgreSQL) → project の test runner。 */
export async function runTs(root, target = 'test/', { stack = '' } = {}) {
  const tc = toolchain(PROFILES.ts);
  if (!tc.ok) return miss(`✕ ${tc.why} — do NOT silently fall back to zero-dependency Node; module marked failed`, 'npm (not found)');
  const pkgInfo = ensurePackageJson(root, { stack });
  const inst = await npmInstall(root);
  const install = { ...inst, added: pkgInfo.added };
  if (!inst.ok) return { ...miss(`✕ ${inst.why}`, inst.cmd), ms: inst.ms || 0, install };
  const db = needsPostgres(root) ? await ensurePostgres(root) : null;
  const deps = pkgDeps(readPkg(root));
  const rel = String(target || '').replace(/\\/g, '/');
  const files = /\.test\.(?:tsx?|mts|cts)$/.test(rel) ? [rel]
    : listFiles(root).filter(f => /^test\/.+\.test\.(?:tsx?|mts|cts)$/.test(f));
  if (!files.length) return { ...miss(`no TypeScript test files under ${rel || 'test/'}`, '(no input)'), install, ...(db ? { db } : {}) };
  const bin = (n) => { try { return fs.realpathSync(path.join(root, 'node_modules', '.bin', n)); } catch { return null; } };
  let args, label;
  if (deps.vitest && bin('vitest')) { args = [bin('vitest'), 'run', ...files]; label = 'vitest run'; }
  else if (deps.jest && bin('jest')) { args = [bin('jest'), '--ci', ...files]; label = 'jest --ci'; }
  else {
    if (!fs.existsSync(path.join(root, 'node_modules', 'tsx'))) return { ...miss('✕ tsx not installed — cannot run TypeScript tests', 'node --import tsx --test'), install, ...(db ? { db } : {}) };
    args = ['--import', 'tsx', '--test', ...files]; label = 'node --import tsx --test';
  }
  // DATABASE_URL は常に上書き：サーバ側の環境変数を継承して本物の DB に触る事故を防ぐ。
  const env = { DATABASE_URL: (db && db.url) || '', AI_PLATFORM_DB: db ? db.status : 'not-needed' };
  const cmd = `${inst.cached ? '' : 'npm install && '}${label} ${files.length === 1 ? files[0] : `<${files.length} test file(s)>`}${db ? ` [PostgreSQL: ${db.status}]` : ''}`;
  const r = await run(process.execPath, args, root, TEST_TIMEOUT_MS(), env);
  const timedOut = r.code === -1 && /\[timeout \d+ms, process group force-killed\]/.test(r.out);
  const ran = r.out.trim().length > 0;
  const c = ran ? parseTestCounts(r.out) : { passed: 0, failed: 0, skipped: 0 };
  const total = c.passed + c.failed;                       // skipped は total に入れない：走っていないものは合格でも不合格でもない
  const dbNote = db && db.status === 'skipped' ? `\n[PostgreSQL skipped: ${db.why}; ${c.skipped} test(s) skipped — NOT counted as passed]` : '';
  return {
    cmd, exit_code: ran ? r.code : -1, total, passed: c.passed, failed: c.failed, skipped: c.skipped, ms: (inst.ms || 0) + r.ms, timed_out: timedOut,
    ok: ran && r.code === 0 && c.failed === 0 && c.passed > 0,
    at: nowIso(), tail: (r.out.slice(-1200) || '(no output: tests did not actually run)') + dbNote,
    install, ...(db ? { db: { status: db.status, why: db.why || null, container: db.container || null, image: db.image || null } } : {}),
  };
}
