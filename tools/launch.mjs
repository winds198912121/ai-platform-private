#!/usr/bin/env node
/* ============================================================
   launch.mjs — クロスプラットフォーム「一键起動」
   動作：
     1. ポート 8788 (AI_PLATFORM_PORT で上書き可) が空いてるか確認
     2. 既起動なら「→ 既に動いてる」 → 直接ブラウザを開く
     3. 未起動なら node server.mjs をバックグラウンド起動 → HTTP 200 を確認
     4. 既定ブラウザで http://127.0.0.1:8788 を開く
     5. Ctrl+C で綺麗に stop
   使い方：
     node tools/launch.mjs          # 既存の setup/install.sh 設定を読まずに直接動かす
     bash setup/install.sh start    # 本ツール経由じゃなくておとなしく起きたい人向け
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');
const PORT = Number(process.env.AI_PLATFORM_PORT || 8788);
const HOST = process.env.AI_PLATFORM_HOST || '127.0.0.1';
const URL = `http://${HOST}:${PORT}`;

const C_RESET = '\x1b[0m', C_GRN = '\x1b[32m', C_YEL = '\x1b[33m', C_RED = '\x1b[31m', C_DIM = '\x1b[2m', C_BLD = '\x1b[1m';
const useColor = process.stdout.isTTY !== false;
const col = (c, s) => useColor ? `${c}${s}${C_RESET}` : s;
const sym = { ok: '✓', warn: '!', err: '✗', dot: '·', arr: '→' };
const step = (n, total, label) => process.stdout.write(`\n${col(C_BLD, `[${n}/${total}]`)} ${label}\n`);

/* ---------- 1. PID が既に走ってないか ---------- */

let serverProc = null;
let serverLogFd = null;

function findExistingServer() {
  // 1a. data/projects.json.lock に pid が書かれていて、生きてればそれ
  const lock = path.join(ROOT, 'data', 'projects.json.lock');
  if (fs.existsSync(lock)) {
    try {
      const d = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (d.pid && alive(d.pid) && cmdline(d.pid).includes('server.mjs')) {
        return { pid: d.pid, source: 'lock' };
      }
    } catch {}
  }
  // 1b. ポートで LISTEN してる pid を取りに行く
  return portOwner(PORT);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function cmdline(pid) {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    return (r.stdout || '').trim();
  }
  return '';
}

function portOwner(port) {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    const pid = parseInt((r.stdout || '').split('\n')[0].trim(), 10);
    if (Number.isFinite(pid) && pid > 0 && alive(pid)) return { pid, source: 'port' };
  }
  return null;
}

/* ---------- 2. 既存チェック ---------- */

async function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/state`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/* ---------- 3. 起動 ---------- */

function startServer() {
  const logPath = path.join(ROOT, 'setup', 'run', `ai-platform-${PORT}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  serverLogFd = fs.openSync(logPath, 'a');
  fs.writeSync(serverLogFd, `\n[launch.mjs] start at ${new Date().toISOString()}\n`);
  serverProc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT, detached: true,
    stdio: ['ignore', serverLogFd, serverLogFd],
    env: { ...process.env, AI_PLATFORM_PORT: String(PORT), AI_PLATFORM_HOST: HOST },
  });
  serverProc.unref();
  fs.writeFileSync(path.join(ROOT, 'data', 'launch.pid'), String(serverProc.pid));
}

async function waitHealthy(maxMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await ping()) return true;
    if (serverProc && !alive(serverProc.pid)) return false;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

/* ---------- 4. ブラウザ ---------- */

function openBrowser() {
  // mac は open、Linux は xdg-open、Windows は cmd /c start
  const cmds = {
    darwin: ['open', [URL]],
    linux:  ['xdg-open', [URL]],
    win32:  ['cmd', ['/c', 'start', '', URL]],
  };
  const [bin, args] = cmds[process.platform] || ['xdg-open', [URL]];
  spawn(bin, args, { stdio: 'ignore', detached: true }).unref();
}

function cleanupAndExit(code) {
  if (serverProc && alive(serverProc.pid)) {
    try { process.kill(serverProc.pid, 'SIGTERM'); } catch {}
  }
  if (serverLogFd) { try { fs.closeSync(serverLogFd); } catch {} }
  process.exit(code);
}

process.on('SIGINT', () => cleanupAndExit(0));
process.on('SIGTERM', () => cleanupAndExit(0));

/* ---------- main ---------- */

async function main() {
  console.log(col(C_BLD, '\nAI Dev Platform — 一键起動\n'));
  console.log(col(C_DIM, `  url: ${URL}`));
  console.log(col(C_DIM, `  root: ${ROOT}`));

  step(1, 4, '既存サーバ確認');
  const existing = findExistingServer();
  if (existing) {
    console.log(`  ${col(C_GRN, sym.ok)} pid ${existing.pid} が既に動いています（${existing.source} 経由）`);
    if (!(await ping())) {
      console.log(`  ${col(C_RED, sym.err)} pid は生きてるけど http に到達できません`);
      cleanupAndExit(1);
    }
  } else {
    console.log(`  ${col(C_DIM, sym.dot)} 起動していないので新規に起こします`);
  }

  step(2, 4, 'サーバ起動');
  if (!existing) {
    try { startServer(); }
    catch (e) { console.log(`  ${col(C_RED, sym.err)} ${e.message}`); cleanupAndExit(1); }
    console.log(`  ${col(C_DIM, sym.dot)} 子プロセス pid=${serverProc.pid}（detached, log: setup/run/ai-platform-${PORT}.log）`);
    const ok = await waitHealthy();
    if (!ok) {
      console.log(`  ${col(C_RED, sym.err)} ${Math.round((Date.now() - Date.now()) / 1000)} 秒待っても http 200 にならない`);
      console.log(`  末尾ログ: ${tail(path.join(ROOT, 'setup', 'run', `ai-platform-${PORT}.log`), 15)}`);
      cleanupAndExit(2);
    }
    console.log(`  ${col(C_GRN, sym.ok)} HTTP 200`);
  }

  step(3, 4, '状態取得');
  await new Promise(r => setTimeout(r, 300));
  console.log(`  ${col(C_DIM, sym.dot)} /api/state を ${URL}/api/state で確認できます`);

  step(4, 4, 'ブラウザ起動');
  openBrowser();
  console.log(`  ${col(C_GRN, sym.arr)} ${URL}`);

  console.log(col(C_YEL, '\n  止めるときは Ctrl+C または別ターミナルで:'));
  console.log(col(C_DIM, `    kill $(cat data/launch.pid 2>/dev/null) 2>/dev/null`));
  console.log(col(C_DIM, `    bash setup/install.sh stop\n`));

  // 起動しっぱなしにする：サーバは detached なのでこのプロセス自体は役目を終える
  cleanupAndExit(0);
}

function tail(p, n) {
  try { return fs.readFileSync(p, 'utf8').split('\n').slice(-n).join('\n'); }
  catch { return '(log を読めません)'; }
}

main().catch(e => { console.error(e); cleanupAndExit(1); });
