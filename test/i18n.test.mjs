import { test } from 'node:test';
import assert from 'node:assert/strict';
const i18n = await import('../public/i18n.mjs');
const harness = await import('../harness.mjs');

const CODES = i18n.LANGS.map(l => l.code);
const STAGE_IDS = harness.STAGES.map(s => s.id);

test('Japanese and English are the only supported locales; every entry is complete', () => {
  assert.deepEqual(CODES, ['en', 'ja']);
  assert.deepEqual(i18n.audit(), []);
  assert.ok(i18n.KEYS.length > 300);
});

test('Every stage has a distinct translated label in both supported locales', () => {
  assert.equal(STAGE_IDS.length, 8);
  for (const code of CODES) {
    i18n.setLang(code);
    const names = STAGE_IDS.map(id => {
      const key = `stage.${id}`;
      assert.ok(i18n.has(key), `${code}: missing ${key}`);
      const value = i18n.t(key);
      assert.notEqual(value, key);
      assert.ok(value.trim());
      return value;
    });
    assert.equal(new Set(names).size, 8);
  }
  i18n.setLang('en');
  assert.equal(i18n.t('stage.development'), 'Module development');
  i18n.setLang('ja');
  assert.equal(i18n.t('stage.requirements'), '要件定義');
  assert.equal(i18n.t('stage.operations'), '運用');
});

test('Legacy Chinese and invalid locale preferences fall back to Japanese', () => {
  for (const code of ['zh', 'zh-CN', 'unknown', '']) {
    i18n.setLang(code);
    assert.equal(i18n.lang(), 'ja');
    assert.equal(i18n.t('stage.requirements'), '要件定義');
  }
});

test('Server stages and UI translation keys stay aligned', () => {
  for (const stage of harness.STAGES) assert.ok(i18n.has(`stage.${stage.id}`), stage.id);
});
