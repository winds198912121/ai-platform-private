import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
process.env.AI_PLATFORM_PROVIDER = 'sim';
process.env.AI_PLATFORM_SETTINGS_FILE = path.join(os.tmpdir(), `aip-locale-settings-${process.pid}.json`);
const H = await import('../harness.mjs');
const sim = await import('../sim.mjs');
const { t, setLang, KEYS } = await import('../public/i18n.mjs');
const chineseOnly = /[这们该个为请软误库录级验栈发实标务协边际优迁约页错终调传户导连适进设认启显继构检报审删权备规择动开关证览问压质对并]/;

test('Every preset skill retains its sections and uses Japanese or English', () => {
  const skills = H.skillCatalog();
  assert.ok(skills.length >= 41);
  for (const skill of skills) {
    if (!skill.id.startsWith('agx-')) for (const section of H.SKILL_SECTIONS) assert.ok(skill.body.includes(`## ${section}`), `${skill.id}: ${section}`);
    for (const field of ['name', 'desc', 'body']) assert.doesNotMatch(skill[field] || '', chineseOnly, `${skill.id}: ${field}`);
  }
});

test('Offline artifacts and WBS no longer introduce Chinese content', () => {
  const project = { name: 'Locale verification', tech: 'Python 3.12' };
  for (const stage of H.STAGES) {
    assert.doesNotMatch(JSON.stringify(sim.planSteps(project, stage)), chineseOnly);
    assert.doesNotMatch(JSON.stringify(sim.planArtifacts(project, stage)), chineseOnly);
  }
  const wbs = sim.planWbs(project);
  assert.doesNotMatch(JSON.stringify(wbs), chineseOnly);
  for (const [i, epic] of wbs.epics.entries()) {
    const result = sim.moduleCode(project, { id: `M${i + 1}`, name: epic.name, layer: epic.layer });
    assert.doesNotMatch(JSON.stringify(result), chineseOnly);
    assert.match(result.files[0].path, /^[\x00-\x7f]+$/);
  }
});

test('All UI translations avoid Chinese-only characters', () => {
  for (const code of ['ja', 'en']) {
    setLang(code);
    for (const key of KEYS) assert.doesNotMatch(t(key), chineseOnly, `${code}: ${key}`);
  }
  setLang('ja');
});

test('Generated Python caches stay out of the visible source list', async () => {
  const exec = await import('../exec.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-locale-files-'));
  try {
    fs.mkdirSync(path.join(root, 'src', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'example.py'), '# example\n');
    fs.writeFileSync(path.join(root, 'src', '__pycache__', 'legacy.pyc'), 'cache');
    assert.deepEqual(exec.listFiles(root), ['src/example.py']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
