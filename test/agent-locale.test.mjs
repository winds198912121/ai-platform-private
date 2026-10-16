import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let reply = '';
const requests = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', part => { raw += part; });
  req.on('end', () => {
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: reply } }] }));
  });
});
await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
stub.unref();
process.on('exit', () => stub.close());
process.env.AI_PLATFORM_PROVIDER = 'live';
process.env.AI_PLATFORM_API_KEY = 'local-test-only';
process.env.AI_PLATFORM_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_PLATFORM_SETTINGS_FILE = path.join(os.tmpdir(), `aip-agent-locale-${process.pid}.json`);
const agent = await import('../agent.mjs');
const project = { name: 'Locale test', brief: 'Create a report', tech: 'Python 3.12', inputs: [], skills: [] };

test('Model requests require Japanese and English; reasoning never becomes artifact content', async () => {
  reply = '<think>这是不应展示的内部内容</think>{"content":"# 要件定義書\\n\\n日本語の成果物です。"}';
  const result = await agent.stageArtifacts(project, { id: 'requirements', agent: 'BA Agent', name: 'Requirements' });
  assert.equal(result.artifacts.length, 3);
  for (const artifact of result.artifacts) assert.equal(artifact.content, '# 要件定義書\n\n日本語の成果物です。');
  for (const body of requests) {
    const system = body.messages.find(message => message.role === 'system').content;
    assert.match(system, /日本語/);
    assert.match(system, /English/);
    assert.match(system, /中国語は出力しない/);
  }
});

test('Invalid model JSON produces an English error without leaking raw Chinese content', async () => {
  reply = '这不是合法JSON';
  await assert.rejects(agent.wbs(project), /WBS: model did not return valid JSON/);
});

test('An empty WBS response produces an English diagnostic', async () => {
  reply = '{"epics":[]}';
  await assert.rejects(agent.wbs(project), /WBS: model returned no usable epics/);
});
