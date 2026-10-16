import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressOf, stageExecution } from '../public/progress.mjs';

test('执行完成与人工批准分开：待审显示 100%，未开始和驳回归零', () => {
  assert.equal(progressOf({ status: 'awaiting_review', progress: 85 }), 100);
  assert.equal(progressOf({ status: 'approved' }), 100);
  assert.equal(progressOf({ status: 'pending', progress: 85 }), 0);
  assert.equal(progressOf({ status: 'rejected', progress: 100 }), 0);
});

test('失败保留已到达的执行节点；旧数据缺少进度时安全显示零', () => {
  assert.equal(progressOf({ status: 'failed', progress: 35 }), 35);
  assert.equal(progressOf({ status: 'failed' }), 0);
  assert.equal(progressOf({ status: 'running', progress: NaN }), 0);
  assert.equal(progressOf({ status: 'running', progress: 200 }), 100);
  assert.equal(progressOf({ status: 'running', progress: -5 }), 0);
});

test('并行开发聚合所有模块：完成、执行中、失败、未开始都计入分母', () => {
  const stage = { kind: 'development', status: 'failed' };
  const modules = [
    { status: 'awaiting_review' }, { status: 'running', progress: 70 },
    { status: 'failed', progress: 35 }, { status: 'pending' },
  ];
  const result = stageExecution({ modules }, stage);
  assert.equal(result.status, 'running', '部分失败时仍显示其他模块正在运行');
  assert.equal(result.progress, 51);
  assert.equal(result.completed, 1);
  assert.equal(result.total, 4);
  assert.equal(stage.status, 'failed', '展示聚合不改写项目状态');
});

test('前序未批准和全阶段已批准时，不被旧模块进度覆盖', () => {
  const project = { modules: [{ status: 'approved' }] };
  const pending = { kind: 'development', status: 'pending' };
  const approved = { kind: 'development', status: 'approved' };
  assert.equal(progressOf(stageExecution(project, pending)), 0);
  assert.equal(progressOf(stageExecution(project, approved)), 100);
});
