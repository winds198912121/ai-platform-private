/* ============================================================
   capture.mjs — プロトタイプ HTML → PNG（純 Node + Chrome DevTools Protocol、puppeteer 不要）
   tools/shot.mjs と同じ CDP 手順（Page.navigate → Page.captureScreenshot）を、
   ヘッドレス Chrome を自前で 1 本起動して回す。ブラウザが無ければ { skipped } を返すだけ（失敗にしない）。
   - AI_PLATFORM_SHOTS=0        撮影しない（node --test 配下は既定で撮影しない。=1 で撮る）
   - AI_PLATFORM_CHROME=<path>  ブラウザの実行ファイルを指定
   - BU_CDP_PORT=<port>         既に起動済みの Chrome（--remote-debugging-port）に接続
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowser() {
  if (process.env.AI_PLATFORM_SHOTS === '0') return { path: null, why: 'disabled (AI_PLATFORM_SHOTS=0)' };
  if (process.env.NODE_TEST_CONTEXT && process.env.AI_PLATFORM_SHOTS !== '1') return { path: null, why: 'disabled under node --test (set AI_PLATFORM_SHOTS=1)' };
  if (typeof WebSocket === 'undefined') return { path: null, why: `Node ${process.version} has no global WebSocket (needs Node 22+)` };
  const env = process.env.AI_PLATFORM_CHROME;
  if (env) return fs.existsSync(env) ? { path: env } : { path: null, why: `AI_PLATFORM_CHROME not found: ${env}` };
  const hit = CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  return hit ? { path: hit } : { path: null, why: 'no Chrome/Chromium/Edge found (set AI_PLATFORM_CHROME)' };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function launch(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-shot-'));
  const proc = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) { proc.kill('SIGKILL'); throw new Error('browser did not start (no DevToolsActivePort)'); }
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const close = () => { try { proc.kill('SIGKILL'); } catch {} setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500); };
  return { port, close };
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const waits = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waits.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const open = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('CDP websocket error'))); });
  return { open, send, close: () => { try { ws.close(); } catch {} } };
}

/**
 * jobs: [{ html: <絶対パス>, png: <絶対パス> }] を順に撮る。
 * 返り値：{ shots: [png 絶対パス], skipped: null | 理由, errors: [{ html, error }], browser, ms }
 */
export async function capture(jobs, { width = 1280, height = 800, settle = 120 } = {}) {
  const t0 = Date.now();
  const ext = process.env.BU_CDP_PORT;
  const found = findBrowser();
  const br = ext && !/^disabled/.test(found.why || '') ? { path: `cdp:${ext}` } : found;
  if (!br.path) return { shots: [], skipped: br.why, errors: [], browser: null, ms: 0 };
  if (!jobs.length) return { shots: [], skipped: null, errors: [], browser: br.path, ms: 0 };
  let inst = null, cdp = null;
  try {
    inst = ext ? { port: ext, close: () => {} } : await launch(br.path);
    const list = await (await fetch(`http://127.0.0.1:${inst.port}/json/list`)).json();
    let page = list.find(t => t.type === 'page');
    if (!page) page = await (await fetch(`http://127.0.0.1:${inst.port}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = connect(page.webSocketDebuggerUrl);
    await cdp.open;
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const shots = [], errors = [];
    for (const j of jobs) {
      try {
        await cdp.send('Page.navigate', { url: pathToFileURL(j.html).href });
        await sleep(settle);
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.mkdirSync(path.dirname(j.png), { recursive: true });
        fs.writeFileSync(j.png, Buffer.from(data, 'base64'));
        shots.push(j.png);
      } catch (e) { errors.push({ html: j.html, error: e.message }); }
    }
    return { shots, skipped: null, errors, browser: br.path, ms: Date.now() - t0 };
  } catch (e) {
    return { shots: [], skipped: `browser unavailable: ${e.message}`, errors: [], browser: br.path, ms: Date.now() - t0 };
  } finally {
    cdp?.close();
    inst?.close();
  }
}
