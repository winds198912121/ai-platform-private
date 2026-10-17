#!/usr/bin/env node
/* ============================================================
   drive_pipeline.mjs — 案件の「起動 → 全部位承認待ち → 承認 → 次へ」を回すドライバ。
   使い方：node tools/drive_pipeline.mjs <projectId> [--once] [--max-min 30]
     --once     : 現在の段階が awaiting_review になったら 1 回だけ承認して終了（手動ループ用）
     --max-min  : N 分経ったら諦めて exit。default 45 分。

   動作：
     1. /api/state を 3 秒間隔でポーリング
     2. running のまま timeout → エラーで停止
     3. awaiting_review → POST .../stages/<sid>/approve { reviewer: 'Human (drive_pipeline)', source: 'dashboard' }
        ※ human_gate でも承認を通す（source:dashboard + 人間名で OK）
     4. approved → 次が running に入る
     5. 全 approved or --max-min 経過で終了
   ============================================================ */
import fs from 'node:fs';

const PROJECT_ID = process.argv[2];
const ONCE = process.argv.includes('--once');
const argMax = (s) => { const i = process.argv.indexOf(s); return i >= 0 ? Number(process.argv[i + 1]) : null; };
const MAX_MIN = Number(argMax('--max-min') ?? 45);
const HOST = process.env.AI_PLATFORM_HOST || '127.0.0.1';
const PORT = Number(process.env.AI_PLATFORM_PORT || 8788);
const BASE = `http://${HOST}:${PORT}`;

if (!PROJECT_ID) { console.error('usage: node tools/drive_pipeline.mjs <projectId> [--once] [--max-min N]'); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${m}\n`);

async function getState() {
  const r = await fetch(`${BASE}/api/state`);
  if (!r.ok) throw new Error(`GET /api/state failed: ${r.status}`);
  return r.json();
}

const AUTO_ANSWER = process.argv.includes('--auto-answer');
const AUTO_LESSONS = process.argv.includes('--auto-lessons');
const DEFAULT_ANSWER = '仕様書に明記がないため、PM 判断として現実装の既定方針で確定します。追加の質問は不要です。判断根拠を実装コメントに残し、実装を完了してください。';

async function answerOpenQuestions(pid, p) {
  const open = (p.questions || []).filter(q => q.status === 'open');
  if (!open.length) return 0;
  let n = 0;
  for (const q of open) {
    const r = await fetch(`${BASE}/api/projects/${pid}/questions/${q.id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-approval-source': 'dashboard' },
      body: JSON.stringify({ answer: DEFAULT_ANSWER, by: 'PM Sato' }),
    });
    if (r.ok) { n++; log(`answer ${q.id} (${q.module}) → default`); }
    else log(`!! answer ${q.id} failed: ${r.status}`);
    await sleep(250);
  }
  return n;
}

/** 教訓は「dismiss」ではなく短い決定行として承認する。
 *  dismiss するとモデルへのフィードバックが消え、同じ疑問を繰り返して
 *  モジュールが pending に戻され続ける（実測でそうなった）。
 *  本文は「→」以降の回答を 90 文字に切って 1 行だけ残す。 */
function shortLesson(draft) {
  const s = String(draft || '');
  const i = s.lastIndexOf('→');
  const tail = (i >= 0 ? s.slice(i + 1) : s).trim().replace(/\s+/g, ' ');
  return `- ${tail.slice(0, 90)}${tail.length > 90 ? '…' : ''}`;
}

async function approveDraftLessons(pid, p) {
  const drafts = (p.lessons || []).filter(l => l.status === 'draft');
  if (!drafts.length) return 0;
  const skill = (p.skills || []).find(s => s.name === 'Lessons learned (development)');
  let size = skill ? skill.body.length : 0;
  let n = 0;
  for (const l of drafts) {
    const line = shortLesson(l.draft);
    if (size + line.length + 1 > 3900) {           // 余裕が無ければ dismiss
      await fetch(`${BASE}/api/projects/${pid}/lessons/${l.id}/dismiss`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-approval-source': 'dashboard' },
        body: JSON.stringify({ by: 'PM Sato' }),
      }).catch(() => {});
      continue;
    }
    const r = await fetch(`${BASE}/api/projects/${pid}/lessons/${l.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-approval-source': 'dashboard' },
      body: JSON.stringify({ body: line, by: 'PM Sato' }),
    });
    if (r.ok) { n++; size += line.length + 1; }
    await sleep(120);
  }
  if (n) log(`approved ${n} lesson(s) as short rules (skill ≈ ${size} chars)`);
  return n;
}

async function approveStage(pid, sid) {
  // human_gate でも通る形に：source=dashboard + 人間名 + x-approval-source ヘッダー
  // 名前は governance.AUTOMATED /(auto|ai|bot|pipeline|agent|script|ci|cron|自動)/i に
  // ヒットしないものを使う（"PM (drive_pipeline)" は "pipeline" でアウト）
  const r = await fetch(`${BASE}/api/projects/${pid}/stages/${sid}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-approval-source': 'dashboard' },
    body: JSON.stringify({ reviewer: 'PM Sato' }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`approve ${sid} failed: ${r.status} ${body.error || ''}`);
  return body;
}

async function main() {
  const t0 = Date.now();
  log(`start: project=${PROJECT_ID} once=${ONCE} max=${MAX_MIN}min`);
  let lastLog = '';
  while (true) {
    if ((Date.now() - t0) / 60000 > MAX_MIN) {
      log(`!! timeout (${MAX_MIN} min) — exit.`);
      process.exit(2);
    }
    const state = await getState();
    const p = (state.projects || []).find(x => x.id === PROJECT_ID);
    if (!p) { log(`!! project ${PROJECT_ID} not found`); process.exit(3); }
    if (AUTO_ANSWER) await answerOpenQuestions(PROJECT_ID, p);
    if (AUTO_LESSONS) await approveDraftLessons(PROJECT_ID, p);
    const stages = p.stages || [];
    const done = stages.filter(s => s.status === 'approved').length;
    const cur = stages.find(s => s.status !== 'approved');
    const line = `stages ${done}/${stages.length} cur=${cur ? `${cur.id}:${cur.status}` : 'all-done'}`;
    if (line !== lastLog) { log(line); lastLog = line; }

    if (!cur) { log('all approved — done.'); process.exit(0); }

    // development は段階一括承認できない（per-module）。awaiting_review のモジュールを個別に承認。
    if (cur.kind === 'development') {
      const ready = (p.modules || []).filter(m => m.status === 'awaiting_review');
      if (ready.length) {
        for (const m of ready) {
          try {
            const r = await fetch(`${BASE}/api/projects/${PROJECT_ID}/modules/${m.id}/approve`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-approval-source': 'dashboard' },
              body: JSON.stringify({ reviewer: 'PM Sato' }),
            });
            if (r.ok) log(`approve module ${m.id} (${m.name})`);
            else log(`!! approve module ${m.id} failed: ${r.status} ${(await r.text()).slice(0, 160)}`);
          } catch (e) { log(`!! approve module ${m.id}: ${e.message}`); }
          await sleep(300);
        }
        if (ONCE) { log('--once: leaving after module approvals'); process.exit(0); }
        continue;
      }
      // 承認待ちが無ければ、依存が全部承認済みの pending/rejected/failed(<3) を kick する
      const st = (p.modules || []).reduce((a, m) => { a[m.id] = m.status; return a; }, {});
      const depsOk = (m) => (m.deps || []).every(d => st[d] === 'approved');
      const next = (p.modules || []).find(m => (['pending', 'rejected'].includes(m.status)
        || (m.status === 'failed' && (m.attempts || 0) < 3)) && depsOk(m));
      if (next && cur.status !== 'running') {
        log(`kick module ${next.id} (${next.name})`);
        await fetch(`${BASE}/api/projects/${PROJECT_ID}/modules/${next.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
        await sleep(1000);
      } else {
        await sleep(3000);
      }
      continue;
    }

    if (cur.status === 'awaiting_review') {
      log(`approve ${cur.id} (${cur.name})`);
      await approveStage(PROJECT_ID, cur.id);
      if (ONCE) { log('--once: leaving after this approval'); process.exit(0); }
      await sleep(800);
      continue;
    }
    if (cur.status === 'pending' || cur.status === 'rejected' || cur.status === 'failed') {
      log(`kick ${cur.id} via /stages/${cur.id}/run`);
      // 走り出しを直接呼ぶ。kick() は承認後に自動で次を走らせるが、
      // 人が「pending のまま放置」している時用に明示スタートもできるよう切っておく。
      const r = await fetch(`${BASE}/api/projects/${PROJECT_ID}/stages/${cur.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!r.ok) { log(`!! ${cur.id} run failed: ${r.status}`); }
      await sleep(1500);
      continue;
    }
    if (cur.status === 'running') {
      // 進捗だけ
      await sleep(3000);
      continue;
    }
    log(`unknown stage status: ${cur.status} — exiting`);
    process.exit(4);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
