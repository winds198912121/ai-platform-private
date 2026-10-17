/* ============================================================
   harness.test.mjs — 状态机规则单测（node --test）
   运行：AI_PLATFORM_SPEED=0 node --test test/
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

process.env.AI_PLATFORM_SPEED = '0';       // 零延迟，异步立刻推进
process.env.AI_PLATFORM_PROVIDER = 'sim';  // 单测走离线通道（不依赖网络与 Key）
process.env.AI_PLATFORM_DATA = path.join(os.tmpdir(), `ai-platform-test-${process.pid}.json`);
process.env.AI_PLATFORM_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-ws-'));
fs.rmSync(process.env.AI_PLATFORM_DATA, { force: true });

const H = await import('../harness.mjs');
const agent = await import('../agent.mjs');        // 只为断言「技能真的拼进提示词」的纯函数
const exec = await import('../exec.mjs');          // 只为断言技术栈建议的运行时判定
const ROOT = path.resolve(import.meta.dirname, '..');   // 仓库根（上游技能在 vendor/agent-skills）
H.load();

const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('waitFor 超时');
};
const stage = (p, id) => p.stages.find(s => s.id === id);
// auto のテストは「完全自動」を検証している → 高リスク段階の人待ち（既定 human_gates）を明示的に外す
const mk = (mode = 'human_gate', name = '测试项目') => H.createProject({ name, brief: '测试用项目概要', tech: 'Node.js', mode, ...(mode === 'auto' ? { human_gates: [] } : {}) });

test('项目信息可以编辑：改名称/需求/技术栈/入口模式 + 校验 + 事件留痕 + 幂等', () => {
  const p = mk('human_gate', '可编辑项目');
  const ev0 = p.events.filter(e => /项目信息已编辑/.test(e.text)).length;

  const up = H.updateProject(p, { name: '可编辑项目 v2', tech: 'Java Spring Boot', brief: '改成 Java 版：Spring Boot + Postgres，含两级审批。', mode: 'auto' });
  assert.equal(up.name, '可编辑项目 v2');
  assert.equal(up.tech, 'Java Spring Boot');
  assert.match(up.brief, /含两级审批/);
  assert.equal(up.mode, 'auto', '入口模式也能改（人工审批 ↔ AI 自动审批）');
  const evs = p.events.filter(e => /项目信息已编辑/.test(e.text));
  assert.equal(evs.length, ev0 + 1, '记一条事件（不是四项各记一条）');
  assert.match(evs.at(-1).text, /项目名、技术栈、需求描述、入口模式/, '事件里列出改了哪几项');
  assert.match(evs.at(-1).text, /可编辑项目 → 可编辑项目 v2/, '改名时事件里能看到前后名字');

  const up2 = H.updateProject(p, { brief: '只改需求这一项。' });
  assert.equal(up2.name, '可编辑项目 v2');
  assert.equal(up2.tech, 'Java Spring Boot', '只传 brief 时其余字段保持不变');
  assert.equal(up2.brief, '只改需求这一项。');

  const n = p.events.length;
  H.updateProject(p, { name: '可编辑项目 v2' });
  assert.equal(p.events.length, n, '值没变就不写事件（幂等）');

  assert.throws(() => H.updateProject(p, { name: '   ' }), (e) => e.status === 400 && /项目名不能为空/.test(e.message), '空名字 400');
  assert.equal(H.updateProject(p, { brief: 'x'.repeat(30000) }).brief.length, 20000, '超长需求按上限截断（不炸、不撑爆界面）');
  assert.equal(H.must(p.id).name, '可编辑项目 v2', '改动真落库（重新按 id 取还是改后的）');
});

test('编辑里改软件分类 / 工作流：按新流程重排阶段，能对上的阶段保留状态与产物；补资料走 addInputs', () => {
  const p = mk('human_gate', '改流程项目');
  p.stages.forEach(s => { if (s.status === 'running') s.status = 'pending'; });        // 单测里造一个「没在跑」的项目
  H.updateProject(p, { type: 'cli' });                                                 // 只给分类 → 流程跟分类的默认走
  assert.equal(p.type, 'cli');
  assert.equal(p.workflow, 'lean');
  assert.equal(p.stages.map(s => s.id).join(','), 'requirements,architecture,wbs,development,testing', '阶段按新流程排');
  assert.match(p.events.at(-1).text, /软件分类、工作流/, '事件里写明改了分类与流程');
  assert.match(p.events.at(-1).text, /重排为「精简交付」/, '事件里写明重排到哪条流程');

  const q = H.createProject({ name: '已跑过的项目', brief: 'b', type: 'webapp' });
  q.stages[0].status = 'approved'; q.stages[0].artifacts = [{ id: 'REQ-01' }];
  q.stages[1].status = 'awaiting_review';                                              // ux 跑过但没批
  q.arch = { layers: ['core'] };
  H.updateProject(q, { workflow: 'lean' });                                            // lean 没有 ux/部署/运维
  assert.equal(q.stages.map(s => s.id).join(','), 'requirements,architecture,wbs,development,testing');
  assert.equal(q.stages[0].status, 'approved', '已批准的需求阶段原样保留');
  assert.equal(q.stages[0].artifacts.length, 1, '产物记录也留着');
  assert.equal(q.stages.some(s => s.id === 'ux'), false, '新流程里没有的阶段被移除');
  assert.equal(q.stages.find(s => s.id === 'testing').status, 'pending', '新补的阶段是 pending');
  assert.equal(q.arch.layers.join(','), H.typeOf('webapp').layers.join(','), '换流程后目录规约回到分类自带的那套');
  assert.equal(q.arch.from, 'type-default');
  const ev = q.events.at(-1).text;
  assert.match(ev, /保留 5 个已有阶段/, `事件写明保留几个：${ev}`);
  assert.match(ev, /去掉 UI\/UX 设计、部署/, '事件写明去掉了哪些阶段');

  const r = mk('human_gate', '跑着的时候改');
  r.stages[0].status = 'running';
  assert.throws(() => H.updateProject(r, { workflow: 'lean' }), (e) => e.status === 409 && /正在执行/.test(e.message), '有阶段在跑 → 409，别在跑的时候动流程');
  const n = r.events.length;
  H.updateProject(r, { workflow: r.workflow, name: r.name });
  assert.equal(r.events.length, n, '没改动不写事件');

  const s = H.createProject({ name: '补资料项目', brief: 'b' });                        // 建完之后再补输入资料
  assert.equal((s.inputs || []).length, 0, '新建时没有资料');
  const added = H.addInputs(s, [{ name: '业务规则.md', content: '逾期罚金每册每天 0.50 元，押金 100 元。' }]);
  assert.equal(added.added, 1);
  assert.equal(s.inputs.length, 1);
  assert.match(s.inputs[0].excerpt, /逾期罚金/);
  assert.ok(fs.existsSync(path.join(process.env.AI_PLATFORM_WORKSPACE, s.id, 'inputs/业务规则.md')), '真落盘到 workspace/<id>/inputs/');
  assert.match(s.events.at(-1).text, /补充输入资料 1 份：业务规则.md/, `事件记账：${s.events.at(-1).text}`);
  H.addInputs(s, [{ name: '业务规则.md', content: '改成 0.80 元。' }]);                  // 同名 = 覆盖，不重复堆
  assert.equal(s.inputs.length, 1, '同名文件覆盖而不是新增一条');
  assert.match(s.inputs[0].excerpt, /0\.80/);
  const bad = H.addInputs(s, [{ name: 'bin.dat', content: 'abc\u0000def' }]);
  assert.equal(bad.added, 0, '二进制跳过');
  assert.match(s.events.at(-1).text, /跳过 1 份文件：bin\.dat（二进制文件（含 NUL），只收文本）/, '跳过原因写进事件');
  assert.throws(() => H.addInputs(s, []), (e) => e.status === 400, '一个文件都没给 → 400');
});

test('项目类型：每个类型带出自己的默认流程；显式工作流优先；未知类型回落', () => {
  assert.deepEqual(H.checkTypes(), [], '类型表自检（id 唯一、指向的流程都存在）');
  assert.deepEqual(H.checkWorkflows(), [], '工作流自检（新加的三条也在：website / service / data）');
  for (const t of H.TYPES) {
    const p = H.createProject({ name: `类型-${t.id}`, brief: 'b', type: t.id });
    assert.equal(p.type, t.id, `${t.id} 落库`);
    assert.equal(p.workflow, t.workflow, `${t.id} → 默认流程 ${t.workflow}`);
    const w = H.WORKFLOWS.find(x => x.id === t.workflow);
    assert.equal(p.stages.map(s => s.id).join(','), w.stages.join(','), `${t.id} 的阶段就是那条流程（${p.stages.length} 个）`);
    assert.match(p.events[0].text, new RegExp(`类型：${t.name}`), `创建事件里带类型：${p.events[0].text.slice(0, 46)}…`);
  }
  const flows = new Set(H.TYPES.map(t => t.workflow));
  assert.ok(flows.size >= 4, `类型覆盖 ≥4 条不同流程：${H.TYPES.map(t => `${t.id}→${t.workflow}`).join('、')}`);

  const catIds = new Set(H.skillCatalog().map(c => c.id));
  for (const t of H.TYPES) {                    // 每个分类都要配齐：技能包 + 目录规约
    assert.ok(t.layers.length >= 3 && new Set(t.layers).size === t.layers.length, `${t.id} 目录规约 ≥3 层且不重复：${t.layers.join('/')}`);
    assert.ok(t.skills.length >= 5 && t.skills.every(s => catIds.has(s)), `${t.id} 技能包 ${t.skills.length} 条、都在预设库里：${t.skills.join('、')}`);
    assert.deepEqual(H.packOf(t.id).layers, t.layers, `${t.id} packOf 与配置一致`);
  }
  const pack = H.createProject({ name: '分类配置包', brief: 'b', type: 'data' });
  assert.equal(pack.arch.from, 'type-default', '新建项目就带上分类的目录规约');
  assert.deepEqual(pack.arch.layers, H.typeOf('data').layers, `目录规约 = data 的层清单（${pack.arch.layers.join('/')}）`);
  assert.equal(pack.skills.length, 0, '技能仍要显式导入（预设库只是模板，以项目为准）');

  for (const t of H.TYPES) {                    // 每个分类都要给技术栈建议（平台上点输入框就出下拉）
    assert.ok(Array.isArray(t.techs) && t.techs.length >= 2 && t.techs.length <= 4, `${t.id} 给 2–4 条建议：${(t.techs || []).join(' ｜ ')}`);
    assert.equal(new Set(t.techs).size, t.techs.length, `${t.id} 建议不重复`);
    assert.ok(t.techs.every(s => s === s.trim() && s.length <= 80), `${t.id} 建议干净（无首尾空格、≤80 字）`);
  }
  assert.equal(exec.profileOf(H.TYPES.find(t => t.id === 'website').techs[0]).id, 'node', '网站分类的头号建议不被误判成 Java 档案');

  const ow = H.createProject({ name: '显式工作流优先', brief: 'b', type: 'website', workflow: 'design' });
  assert.equal(ow.type, 'website', '类型照记');
  assert.equal(ow.workflow, 'design', '显式指定的工作流优先于类型的默认流程');
  assert.equal(ow.stages.length, 4);

  const unk = H.createProject({ name: '未知类型', brief: 'b', type: '并没有这个类型' });
  assert.equal(unk.type, H.TYPES[0].id, '未知类型回落到第一项');
  assert.equal(unk.workflow, H.TYPES[0].workflow);
  assert.equal(H.createProject({ name: '没给类型', brief: 'b' }).type, H.TYPES[0].id, '老客户端不传类型也照常建');
});

test('技能库：增删改查 + 校验 + 事件留痕 + 老项目没有 skills 字段也不炸', () => {
  const p = mk('human_gate', '技能库测试');
  assert.deepEqual(p.skills, [], '新建项目技能库为空');

  const a = H.addSkill(p, { name: '禁止第三方依赖', body: '只允许 Node 内置模块；需要存储用内存对象。' });
  assert.equal(a.id, 'SK-1');
  const b = H.addSkill(p, { name: '测试覆盖边界', body: '每个函数至少一条边界断言。' });
  assert.equal(b.id, 'SK-2', 'id 递增');
  assert.equal(p.skills.length, 2);

  assert.ok(p.events.some(e => /新增技能 SK-1「禁止第三方依赖」.*每次模型调用都会带上/.test(e.text)), '事件流记录新增');

  H.updateSkill(p, 'SK-2', { body: '每个函数至少两条边界断言：空输入与极值。' });
  assert.match(p.skills[1].body, /空输入与极值/, '正文可改');
  assert.equal(p.skills[1].name, '测试覆盖边界', '没传 name 就保留原值');

  const r = H.removeSkill(p, 'SK-1');
  assert.deepEqual([r.id, r.count], ['SK-1', 1]);
  assert.equal(p.skills.length, 1, '真删掉了');

  // 校验与 404
  assert.throws(() => H.addSkill(p, { name: '   ', body: 'x' }), /技能名不能为空/);
  assert.throws(() => H.addSkill(p, { name: 'x', body: '' }), /技能正文不能为空/);
  assert.throws(() => H.updateSkill(p, 'SK-9', { body: 'x' }), /技能不存在：SK-9/);
  assert.throws(() => H.removeSkill(p, 'SK-9'), /技能不存在：SK-9/);
  assert.equal(H.addSkill(p, { name: '超长'.repeat(40), body: 'b' }).name.length, 60, '名字截到 60 字');

  // 老数据（没有 skills 字段）读到就补，不抛异常
  const old = { id: 'P-old', name: '老项目', events: [], skills: undefined };
  assert.deepEqual(H.skillsOf(old), []);
  assert.equal(H.addSkill(old, { name: 'n', body: 'b' }).id, 'SK-1', '老项目也能加');
});

test('技能可以只作用于某个阶段：stage 落库、未知阶段 id 当「所有阶段」、可改', () => {
  const p = mk('human_gate', '阶段技能');
  const s = H.addSkill(p, { name: '需求专属', body: '需求要编号', stage: 'requirements' });
  assert.equal(s.stage, 'requirements');
  assert.equal(H.addSkill(p, { name: '通用', body: 'x' }).stage, '', '不传 stage = 所有阶段');
  assert.equal(H.addSkill(p, { name: '瞎写', body: 'x', stage: 'not-a-stage' }).stage, '', '未知阶段 id 归到「所有阶段」，不报错卡流程');
  assert.ok(p.events.some(e => /新增技能 SK-1「需求专属」· 适用：需求分析/.test(e.text)), '事件里写明适用阶段');

  H.updateSkill(p, 'SK-1', { stage: 'wbs', body: '需求要编号且可测' });
  assert.equal(p.skills[0].stage, 'wbs', '阶段可改');
  assert.ok(p.events.some(e => /技能 SK-1「需求专属」已更新 · 适用：WBS 分解/.test(e.text)));
});

test('技能最多 60 条（防止把提示词顶爆）', () => {
  const p = mk('human_gate', '技能上限');
  for (let i = 0; i < 60; i++) H.addSkill(p, { name: `规则 ${i}`, body: 'x' });
  assert.throws(() => H.addSkill(p, { name: '第 61 条', body: 'x' }), /技能最多 60 条/);
  const r = H.importSkills(p);                          // 到顶了批量导入也不能挂，报 dropped
  assert.equal(r.added, 0);
  assert.ok(r.dropped > 0 && r.total === 60, `超上限的算 dropped：${JSON.stringify(r)}`);
  assert.ok(p.events.some(e => /超（过）?60 条上限/.test(e.text) || /条上限，未导入/.test(e.text)), '事件里说明为什么没全导进来');
});

test('预设技能库：每个阶段都有技能，开发阶段有各技术栈专属技能', () => {
  const cat = H.skillCatalog();
  assert.ok(cat.length >= 25, `skills/<name>/SKILL.md 被读到（${cat.length} 条）`);
  assert.ok(cat.every(c => c.name && c.body && c.id), '每条都有 id / name / 正文');
  const stages = H.stagesMeta().map(x => x.id);
  for (const s of stages) {
    const n = cat.filter(c => c.stage === s).length;
    assert.ok(n >= 2, `阶段「${s}」有 ${n} 条专业技能（每个阶段至少 2 条）`);
  }
  const techs = cat.filter(c => c.stage === 'development' && c.tech).map(c => c.tech);
  for (const t of ['java-springboot', 'java-struts', 'nodejs', 'sap-cap-rap', 'python', 'static', 'react-vite', 'nestjs-nextjs-postgres']) {
    assert.ok(techs.includes(t), `开发阶段有 ${t} 技能文件（实际 ${techs.join('、')}）`);
  }
  assert.ok(cat.filter(c => c.stage === 'development').some(c => !c.tech), '开发阶段还有通用规范');
  assert.ok(cat.some(c => c.stage === '' && /安全/.test(c.name)), '有一条跨阶段的安全底线');
});

test('导入预设技能：落进项目技能库、幂等去重、能直接进提示词', () => {
  const p = mk('human_gate', '技能导入');
  const r1 = H.importSkills(p, ['dev-nodejs', 'dev-python']);
  assert.deepEqual([r1.added, r1.skipped, r1.total], [2, 0, 2]);
  assert.equal(p.skills[0].stage, 'development', '预设的 stage 一起带进来');
  assert.ok(p.skills[0].by.startsWith('预设'), `记录来源：${p.skills[0].by}`);
  assert.ok(p.events.some(e => /从预设技能库导入 2 条技能/.test(e.text)), '导入写一条汇总事件');

  const r2 = H.importSkills(p, ['dev-nodejs', 'dev-python']);
  assert.deepEqual([r2.added, r2.skipped], [0, 2], '重复导入跳过（幂等）');

  H.importSkills(p);                                     // 不带 ids = 全部导入
  assert.equal(p.skills.length, H.skillCatalog().length, `全部导入后 = 预设总数 ${p.skills.length} 条（不重复）`);
  assert.equal(new Set(p.skills.map(s => s.name)).size, p.skills.length, '没有重名技能');
  assert.throws(() => H.importSkills(p, ['根本没有这条']), /没有匹配的预设技能/);

  // 真进提示词：导入的 Java Spring Boot 规范要出现在 development 阶段的技能片段里
  H.importSkills(p, ['dev-java-springboot']);
  const brief = agent.skillsBrief(p, 'development');
  assert.match(brief, /Java Spring Boot/, `development 提示词带上栈规范：${brief.slice(0, 80)}…`);
  assert.ok(!/Java Spring Boot/.test(agent.skillsBrief(p, 'requirements')), '栈专属技能不会串到别的阶段');
});

test('创建项目后，第一个阶段自动执行并停在「等待审核」', async () => {
  const p = mk();
  await waitFor(() => stage(p, 'requirements').status === 'awaiting_review');
  assert.equal(stage(p, 'requirements').status, 'awaiting_review');
  assert.ok(stage(p, 'requirements').artifacts.length >= 3, '应产出需求物资');
  assert.equal(stage(p, 'ux').status, 'pending', '后续阶段不得自动执行');
});

test('阶段进度随真实节点推送，执行完成显示 100% 并保留人工审批门禁', async () => {
  const p = mk('human_gate', '阶段进度');
  const observed = [];
  const unsubscribe = H.subscribe(ev => {
    if (ev.type === 'state' && ev.projectId === p.id) observed.push(stage(p, 'requirements').progress);
  });
  try {
    await waitFor(() => stage(p, 'requirements').status === 'awaiting_review');
    for (const milestone of [20, 35, 90, 100]) assert.ok(observed.includes(milestone), `SSE 应推送 ${milestone}%`);
    assert.ok(observed.every((v, i) => !i || v >= observed[i - 1]), '同一轮执行的进度不倒退');
    assert.equal(stage(p, 'requirements').progress_label, 'awaiting review');
    assert.equal(stage(p, 'ux').status, 'pending', '执行进度 100% 不代表人工已批准');
  } finally { unsubscribe(); }
});

test('门禁：未批准阶段不可批准（状态不对）', async () => {
  const p = mk('human_gate', '门禁-状态');
  await waitFor(() => stage(p, 'ux').status === 'awaiting_review' || stage(p, 'requirements').status === 'awaiting_review');
  assert.throws(() => H.approveStage(p, 'testing'), /不可批准/);
});

test('门禁：前序未批准，后续阶段不可执行', async () => {
  const p = mk('human_gate', '门禁-顺序');
  await waitFor(() => stage(p, 'requirements').status === 'awaiting_review');
  await assert.rejects(H.runStage(p, 'ux'), /前置阶段/);
});

test('批准后释放下一阶段，驳回后退回重做（attempts+1）', async () => {
  const p = mk('human_gate', '批准与驳回');
  await waitFor(() => stage(p, 'requirements').status === 'awaiting_review');
  H.approveStage(p, 'requirements');
  assert.equal(stage(p, 'requirements').status, 'approved');
  await waitFor(() => stage(p, 'ux').status === 'awaiting_review');
  H.rejectStage(p, 'ux', { category: 'UX 问题', comment: '导航层级过深' });
  await waitFor(() => stage(p, 'ux').status === 'awaiting_review');
  assert.equal(stage(p, 'ux').attempts, 2, '驳回后应重做一次');
  assert.equal(stage(p, 'ux').review.decision, 'rejected');
});

test('WBS 分解产出 Epic/Task，并生成等量开发模块', async () => {
  const p = mk('auto', '自动全流程');
  await waitFor(() => p.wbs.epics.length > 0);
  assert.ok(p.wbs.epics.length >= 4, '至少 4 个 Epic');
  assert.equal(p.modules.length, p.wbs.epics.length, '每个 Epic 一个模块');
  assert.ok(p.wbs.task_count >= 8);
});

test('架构规约：ARC-01 声明的层清单被解析，模块按层归档', async () => {
  const A = await import('../agent.mjs');
  assert.deepEqual(A.parseLayers('```json\n{"layers":[{"dir":"Core"},{"dir":"web-api"},{"dir":"bad!"}]}\n```'), ['core', 'web-api'],
    '应解析出合法层名（小写化、丢弃非法名）');
  assert.deepEqual(A.parseLayers('# 没有 json 代码块\n'), [], '没声明就返回空（调用方回落默认层）');
  assert.deepEqual(A.parseLayers('```json\n{"not":"layers"}\n```'), []);

  const p = mk('auto', '规约落位');
  await waitFor(() => p.modules.length > 0, 60000);
  assert.ok(p.arch && p.arch.layers.length > 0, '架构阶段应产出层清单');
  for (const m of p.modules) {
    assert.equal(m.dir, `src/${m.layer}`, `模块目录 = 架构层目录（不再建模块子目录）：${m.dir}`);
    assert.equal(m.test_path_planned, `test/${m.layer}/${m.slug}.test.mjs`, '测试按业务名命名并与源码镜像');
  }
  assert.ok(p.modules.every(m => p.arch.layers.includes(m.layer)), '模块的层只能是架构声明的层');
});

test('技能批量删除：一次删多条、事件只记一条、失效 id 忽略（幂等）', () => {
  const p = mk('human_gate', '批量删技能');
  H.addSkill(p, { name: 'A', body: 'a' }); H.addSkill(p, { name: 'B', body: 'b' }); H.addSkill(p, { name: 'C', body: 'c' });
  const ids = p.skills.map(s => s.id);
  assert.equal(p.skills.length, 3);
  const r = H.removeSkills(p, [ids[0], ids[2], '并没有这条']);
  assert.deepEqual(r.deleted, [ids[0], ids[2]], '删掉选中的两条');
  assert.deepEqual(r.missing, ['并没有这条'], '不存在的 id 单独报出来，不炸整批');
  assert.equal(r.count, 1);
  assert.deepEqual(p.skills.map(s => s.name), ['B'], '剩下的就是没选的那条');
  assert.ok(p.events.some(e => /批量删除技能 2 条/.test(e.text)), '事件流一条汇总，不是两条');
  assert.throws(() => H.removeSkills(p, [ids[0]]), /没有匹配的技能可删/, '全都已删 → 404');
  assert.throws(() => H.removeSkills(p, []), /没有匹配的技能可删/, '空数组也是 404（别静默返回成功）');
});


test('按客户需求选工作流：阶段序列跟着变，老项目与未知值都按标准全流程', () => {
  assert.deepEqual(H.checkWorkflows(), [], '预设工作流自检：id 唯一、阶段都存在、带开发必带 WBS');
  assert.equal(H.WORKFLOWS[0].id, 'full');
  assert.equal(H.workflowOf({}).id, 'full', '没 workflow 字段的老项目 = 全流程');

  const lean = H.createProject({ name: '精简项目', brief: 'b', workflow: 'lean' });
  assert.equal(lean.workflow, 'lean');
  assert.deepEqual(lean.stages.map(s => s.id), ['requirements', 'architecture', 'wbs', 'development', 'testing']);
  assert.ok(lean.stages.every(s => s.id && s.name && s.kind), '阶段对象照旧带名字/kind（第 1 阶段可能已被 kick 领走）');
  assert.ok(lean.events.some(e => /工作流：精简交付（5 个阶段）/.test(e.text)), '创建事件里写明工作流');

  const proto = H.createProject({ name: '原型项目', workflow: 'prototype' });
  assert.deepEqual(proto.stages.map(s => s.id), ['requirements', 'ux', 'wbs', 'development']);

  const weird = H.createProject({ name: '未知工作流' , workflow: '并没有这条' });
  assert.equal(weird.workflow, 'full', '未知工作流回落全流程（别把项目建成空的）');

  // 产物落盘序号跟项目自己的工作流走：精简流程没有 UX，架构就是 02
  assert.equal(H.docDirOf('architecture', lean), 'docs/02-架构设计');
  assert.equal(H.docDirOf('requirements', lean), 'docs/01-需求分析');
  assert.equal(H.docDirOf('development', lean), 'docs/04-模块开发');
  assert.equal(H.docPathOf('testing', 'IT-01', lean), 'docs/05-集成测试/IT-01.md');
  assert.equal(H.docDirOf('architecture'), 'docs/03-架构设计', '不传项目 = 全局顺序（老调用点不变）');

  // 不在工作流里的阶段：跑它要 404，而不是偷偷跑起来
  assert.throws(() => H.checkStageRunnable(lean, 'operations'), /阶段不存在/);
  assert.ok(lean.stages.find(s => s.id === 'architecture'), '工作流里的阶段就在项目里（能不能跑由前序门禁决定，与工作流无关）');
});


test('开发阶段：模块未完成单元测试不能批准', () => {
  const p = mk('human_gate', '单测门禁');
  p.modules = [{ id: 'M1', name: '假模块', status: 'awaiting_review', unit_tests: null, artifacts: [] }];
  assert.throws(() => H.approveModule(p, 'M1'), /缺少单元测试/);
  p.modules[0].unit_tests = { total: 10, passed: 8, failed: 2, exit_code: 1 };
  assert.throws(() => H.approveModule(p, 'M1'), /单元测试未通过/);
  p.modules[0].unit_tests = { total: 10, passed: 10, failed: 0, exit_code: 1 };  // 数字对但退出码非 0
  assert.throws(() => H.approveModule(p, 'M1'), /单元测试未通过/);
  // 编译没过（total=0）不能报成「缺少单元测试记录」——那句话会把人引到错方向
  p.modules[0].unit_tests = { total: 0, passed: 0, failed: 0, exit_code: 1, tail: '编译失败：\n src/main/java/api/Order.java:1: エラー: クラスOrderが重複しています' };
  assert.throws(() => H.approveModule(p, 'M1'), /单元测试未通过（编译失败/);
  p.modules[0].unit_tests = { total: 0, passed: 0, failed: 0, exit_code: -1, tail: '✕ 缺 JDK' };
  assert.throws(() => H.approveModule(p, 'M1'), /测试没产出结果/);
});

test('模块单测没过 = 失败（不是等待批准）：自动重试，并把真实失败输出喂回模型', async () => {
  const p = mk('human_gate', '自愈重试');
  p.stages.find(s => s.id === 'development').status = 'running';
  p.stages.filter(s => s.id !== 'development').forEach(s => { s.status = 'approved'; });
  p.modules = [{ id: 'M1', name: '基础框架层', layer: p.arch.layers[0], dir: `src/${p.arch.layers[0]}`, status: 'awaiting_review',
    attempts: 1, agent: 'Dev-Agent-1', files: [], artifacts: [], review: null, error: null,
    unit_tests: { total: 7, passed: 6, failed: 1, exit_code: 1, ms: 193, cmd: 'node --test test/core/基础框架层.test.mjs',
      tail: '✖ data-repository: 失败抛含 url/status 的 Error 且不写缓存 (44.9ms)\n  AssertionError [ERR_ASSERTION]: Missing expected exception.' } }];
  H.flush(); H.load();                                     // 重启：老逻辑「单测没过却等待批准」的遗留状态要归位，并自动重排
  const m1 = H.get(p.id).modules[0];
  assert.ok(['failed', 'running'].includes(m1.status), `单测没过的模块归位为失败并立即重排（不等人类点）：${m1.status}`);
  assert.ok(H.get(p.id).events.some(e => /老逻辑遗留/.test(e.text) && /自动重排/.test(e.text)), '归位这件事写进事件流');
  assert.equal(H.get(p.id).stages.find(s => s.id === 'development').status !== 'approved', true, '开发阶段没被静默批准');
  assert.ok(H.get(p.id).events.some(e => /领取模块 M1.*第 2 轮/.test(e.text)), '事件流看得出这是第 2 轮重试');

  await waitFor(() => { const m = H.get(p.id).modules[0]; return (m.attempts || 0) === 2 && m.status !== 'running'; }, 15000);
  const m2 = H.get(p.id).modules[0];
  assert.equal(m2.status, 'awaiting_review', `重试后回到等待批准：${m2.status} / ${m2.error || ''}`);
  assert.equal(m2.unit_tests.exit_code, 0);
  assert.equal(m2.unit_tests.failed, 0, `重试后单测真过（FAIL=${m2.unit_tests.failed}）`);
});

test('瞬时模型故障（空响应 / 超时 / 限流 / 网关）不计入 3 轮重试预算', () => {
  for (const msg of ['模型返回空内容', '模型返回空内容（finish_reason=length）', 'fetch failed', 'HTTP 429 Too Many Requests', 'socket hang up', '502 Bad Gateway', 'request timeout']) {
    assert.equal(H.isTransientModelError(msg), true, `应判为瞬时故障：${msg}`);
  }
  for (const msg of ['单元测试未通过：PASS=6 FAIL=1', '模型给的测试路径不合法：/etc/passwd', '模型未产出可写入的文件', '缺 JDK，无法真跑测试']) {
    assert.equal(H.isTransientModelError(msg), false, `不该判成瞬时故障（要算进 3 轮）：${msg}`);
  }
  // 阶段与模块共用同一套处理：fetch failed 不该吃掉一轮额度，也不该让阶段停在失败
  const p = mk('human_gate', '瞬时故障');
  p.stages.filter(s => s.id !== 'requirements').forEach(s => { s.status = 'approved'; });
  const st = p.stages.find(s => s.id === 'requirements');
  st.status = 'running'; st.attempts = 2; st.error = null;
  assert.equal(H.transientBounce(p, st, st.id, '阶段', 'fetch failed'), true, 'fetch failed 判为瞬时故障');
  assert.equal(st.status, 'failed');
  assert.equal(st.attempts, 1, '这一轮不算数（attempts 回退）');
  assert.match(st.error, /瞬时故障，原地重排/);
  assert.ok(p.events.some(e => /⚠ 阶段 requirements「需求分析」fetch failed → 瞬时故障/.test(e.text)), '事件流写明是瞬时故障：' + p.events.at(-1).text);
  st.status = 'running'; st.attempts = 5;
  assert.equal(H.transientBounce(p, st, st.id, '阶段', '模型返回 401：invalid api key'), false, '真故障（Key 错）要算进 3 轮、不许无限重试');
  assert.equal(st.attempts, 5, '非瞬时故障不动 attempts');
});

test('生成项目工作区自带的技能（skills/*/SKILL.md）优先注入，并写进提示词的优先级', () => {
  const p = mk('human_gate', '工作区技能');
  H.addSkill(p, { name: '项目技能库的约定', body: '项目技能库里的约定', stage: '' });
  const dir = path.join(exec.ROOT, p.id, 'skills', 'site-rules');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), [
    '---', 'name: site-rules',
    'description: 站点页面约定。当生成页面时使用；不适用于后端接口。',
    'metadata:', '  stage: ""', '  tech: ""', '  label: 工作区 · 站点约定', '---', '',
    '# 工作区 · 站点约定', '',
    '## Overview', '页面必须用语义化标签。', '',
    '## When to Use', '- 适用：页面渲染', '- 不适用：接口', '',
    '## Core Process', '1. 只用原生语义元素，不要 div 汤。', '',
    '## Common Rationalizations', '| 借口 | 事实 |', '|---|---|', '| div 更省事 | 语义化才可访问 |', '',
    '## Red Flags', '- 满屏 div', '',
    '## Verification', '- [ ] 无 div 汤', '',
  ].join('\n'));
  const ws = H.refreshWsSkills(p);
  assert.equal(ws.length, 1, `读到工作区技能：${ws.map(s => s.id).join('、')}`);
  assert.equal(ws[0].id, 'site-rules');
  assert.equal(ws[0].name, '工作区 · 站点约定', '显示名取 metadata.label');
  assert.equal(ws[0].from, 'workspace');
  assert.ok(H.get(p.id).events.some(e => /工作区自带 1 条技能/.test(e.text) && /优先于项目技能库与平台预设/.test(e.text)), '读到工作区技能要记账');

  const brief = agent.skillsBrief(H.get(p.id), 'development');
  const iWs = brief.indexOf('工作区 · 站点约定'), iOwn = brief.indexOf('项目技能库的约定');
  assert.ok(iWs >= 0 && iOwn > iWs, `工作区技能排在项目技能库前面（${iWs} < ${iOwn}）`);
  assert.match(brief, /（本项目工作区自带 · 优先）/, '工作区技能带标记');
  assert.match(brief, /优先级：工作区自带技能 > 项目技能库 > 平台通用默认/, '提示词写明优先级（写入通用规则）');

  // 阶段过滤照样生效：工作区技能声明了别的阶段 → 不出现在开发阶段
  fs.writeFileSync(path.join(dir, 'SKILL.md'), fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').replace('  stage: ""', '  stage: deployment'));
  H.refreshWsSkills(p);
  const dev = agent.skillsBrief(H.get(p.id), 'development');
  assert.ok(!/工作区 · 站点约定/.test(dev) && /工作区 · 站点约定/.test(agent.skillsBrief(H.get(p.id), 'deployment')), '工作区技能按阶段过滤');

  // 工作区没有技能时：不产生额外提示词，也不虚报
  fs.rmSync(path.join(exec.ROOT, p.id, 'skills'), { recursive: true, force: true });
  H.refreshWsSkills(p);
  assert.ok(!/工作区 · 站点约定|（本项目工作区自带 · 优先）/.test(agent.skillsBrief(H.get(p.id), 'development')), '没有工作区技能时不注入那一条（优先级说明仍在）');
  assert.ok(H.get(p.id).events.some(e => /工作区已无自带技能/.test(e.text)), '清空也记账');
});

test('跨模块复核：同层文件被重写后，已批准模块的用例不再通过就被打回重做', async () => {
  const p = mk('human_gate', '跨模块复核');
  const root = exec.wsDir(p.id);
  fs.mkdirSync(path.join(root, 'src/core'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test/core'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/core/a.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'test/core/a.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../../src/core/a.mjs';\ntest('a=1', () => assert.equal(a, 1));\n");
  fs.writeFileSync(path.join(root, 'test/core/b.test.mjs'),          // 模拟：被重写的模块把 c.mjs 的导出换掉了
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { missing } from '../../src/core/c.mjs';\ntest('依赖 c 的 missing', () => assert.ok(missing));\n");
  p.modules = [
    { id: 'M1', name: '被重写的模块', layer: 'core', dir: 'src/core', status: 'running', attempts: 2, artifacts: [], files: [{ path: 'src/core/a.mjs' }], test_path: 'test/core/a.test.mjs' },
    { id: 'M2', name: '依赖它的模块', layer: 'core', dir: 'src/core', status: 'approved', attempts: 1, artifacts: [], files: [], test_path: 'test/core/b.test.mjs', unit_tests: { total: 1, passed: 1, failed: 0, exit_code: 0 } },
  ];
  const broken = await H.reverifyApprovedModules(p, p.modules[0]);
  assert.deepEqual(broken, ['M2'], `被打回的模块：${broken.join('、') || '（无）'}`);
  assert.equal(p.modules[1].status, 'failed', '用例挂了就不再是「已批准」');
  assert.match(p.modules[1].error, /同层文件被 M1 重写后单元测试不再通过/);
  assert.equal(p.modules[1].unit_tests.failed, 1, '记下真实的失败数（重试时喂回模型）');
  assert.ok(p.events.some(e => /M2「依赖它的模块」的用例在 M1 重写同层文件后失败 → 打回重做/.test(e.text)), '事件流写明为什么打回');
  assert.equal(p.modules[0].status, 'running', '跑的人自己不受影响（它的状态由 runModule 决定）');
  assert.deepEqual(await H.reverifyApprovedModules(p, p.modules[0]), [], '已打回的不会重复打回，running 的不算已批准');
});

test('已批准模块可以撤回重做（人给的机会不计入自动重试的 3 轮）', () => {
  const p = mk('human_gate', '撤回重做');
  p.stages.find(s => s.id === 'development').status = 'running';
  p.stages.filter(s => s.id !== 'development').forEach(s => { s.status = 'approved'; });
  p.modules = [{ id: 'M1', name: '被写坏的模块', layer: p.arch.layers[0], dir: `src/${p.arch.layers[0]}`, status: 'approved',
    attempts: 3, version: 1, artifacts: [], files: [], review: { decision: 'approved', by: '人工', at: 'x' } }];
  const r = H.rejectModule(p, 'M1', { category: '接口不兼容', comment: '它把同层别的模块写坏了' });
  assert.equal(r.review.decision, 'rejected', `驳回要记账（实际状态 ${r.status}）`);
  assert.equal(r.version, 2);
  assert.ok(p.events.some(e => /（已批准 → 撤回）被驳回/.test(e.text)), '事件流写明是撤回：' + p.events.at(-1).text);
  assert.ok(p.events.some(e => /领取模块 M1.*第 1 轮/.test(e.text)), '撤回后按「第 1 轮」重做（attempts 归零，不占自动重试额度）');
  assert.equal(p.stages.find(s => s.id === 'development').status !== 'approved', true, '开发阶段没被静默当成完成');
});

test('模块真的把代码写进工作区，并真的执行 node --test', async () => {
  const p = mk('human_gate', '真实执行');
  for (const sid of ['requirements', 'ux', 'architecture', 'wbs']) {
    await waitFor(() => stage(p, sid).status === 'awaiting_review', 15000);
    H.approveStage(p, sid);
    await waitFor(() => stage(p, sid).status === 'approved');
  }
  await waitFor(() => p.modules[0] && p.modules[0].status === 'awaiting_review', 20000);
  const m = p.modules[0];
  const diag = () => `unit_tests=${JSON.stringify(m.unit_tests)}\nfiles=${JSON.stringify(m.files)}\n状态=${m.status} 错误=${m.error}\n最近事件:\n` + p.events.slice(-6).map(e => `  ${e.kind} | ${e.text}`).join('\n');
  assert.equal(m.unit_tests.exit_code, 0, '真实 node --test 退出码应为 0\n' + diag());
  assert.ok(m.unit_tests.total > 0, '真实执行应产出测试条数\n' + diag());
  assert.ok(m.files.length >= 2, '源码与测试文件都应落盘\n' + diag());
  for (const f of m.files) assert.ok(fs.existsSync(path.join(process.env.AI_PLATFORM_WORKSPACE, p.id, f.path)), `文件应真实存在：${f.path}`);
  // 架构规约：源码直接落在 ARC-01 声明的层目录下（src/<层>/，文件名带模块号），测试按模块号镜像到同层
  assert.match(m.dir, /^src\/[a-z][a-z0-9_-]*$/, `模块目录 = 架构层目录（不带模块子目录）：${m.dir}\n` + diag());
  assert.ok(m.layer && m.dir === `src/${m.layer}`, `模块应记录所属层：layer=${m.layer} dir=${m.dir}`);
  const srcOnly = m.files.filter(f => f.path !== m.test_path_planned);
  assert.ok(srcOnly.length && srcOnly.every(f => f.path.startsWith(`src/${m.layer}/`) && !/^m?\d/i.test(f.path.split('/').pop())),
    `源码直落层目录、文件名为业务语义（不带 WBS 序号）：${srcOnly.map(f => f.path).join('、')}`);
  assert.ok(!/^m?\d/i.test(m.test_path_planned.split('/').pop()), `测试文件名同样不带 WBS 序号：${m.test_path_planned}`);
  for (const f of m.files) {
    assert.ok(f.path === m.test_path || f.path.startsWith(m.dir + '/'), `文件应归到模块的层目录下：${f.path}（dir=${m.dir}）`);
  }
  assert.ok(m.files.some(f => f.path === m.test_path), `单元测试应写在其层目录下：${m.test_path}`);
  // 产物里记录代码位置（用户要求：产物记录对应的代码位置）
  const rep = m.artifacts.find(a => a.id === `${m.id}-CODE`);
  assert.ok(rep && rep.content.includes('**代码位置**') && rep.content.includes(m.dir), `模块产物应记录代码位置：${m.dir}`);
});

test('技术栈缺省时由架构阶段给出，并贯穿到 WBS 与模块', async () => {
  const p = H.createProject({ name: '没给技术栈的项目', brief: '做一个内部用的借阅管理服务', mode: 'human_gate' });   // 故意不传 tech
  for (const sid of ['requirements', 'ux']) {                     // 门禁串行：先放行前两个阶段
    await waitFor(() => stage(p, sid).status === 'awaiting_review', 15000);
    H.approveStage(p, sid);
    await waitFor(() => stage(p, sid).status === 'approved');
  }
  await waitFor(() => stage(p, 'architecture').status === 'awaiting_review', 20000);
  assert.ok(p.arch && p.arch.stack, `架构阶段应给出技术栈，实际 arch=${JSON.stringify(p.arch)}`);
  assert.equal(p.arch.stackFrom, 'ARC-01', '技术栈应取自 ARC-01（用户未指定 → 模型选型）');
  assert.ok(p.arch.layers.length >= 3, `层清单应至少有 3 层：${p.arch.layers}`);
  const arc = stage(p, 'architecture').artifacts.find(a => a.id === 'ARC-01');
  assert.ok(arc.content.includes(p.arch.stack), 'ARC-01 正文里应写明最终技术栈');
  assert.ok(arc.content.includes('源码目录结构'), 'ARC-01 应有「源码目录结构」一节');
});

test('parseLayout：兼容数组旧格式与 stack+layers 新格式', async () => {
  const agent = await import('../agent.mjs');
  assert.deepEqual(agent.parseLayout('```json\n{"layers":["core","api"]}\n```'), { layers: ['core', 'api'], stack: '' });
  assert.deepEqual(agent.parseLayout('```json\n{"stack":"X + Y","layers":[{"dir":"a"},{"dir":"b"}]}\n```'), { layers: ['a', 'b'], stack: 'X + Y' });
  assert.deepEqual(agent.parseLayout('没有代码块'), { layers: [], stack: '' });
  assert.deepEqual(agent.parseLayout('```json\n{"layers":["BAD NAME","ok"]}\n```').layers, ['ok'], '非法层名应被过滤');
});

test('人工编辑产物：未批准可改（落库+落盘），已批准锁定', async () => {
  const p = mk('human_gate', '编辑产物');
  await waitFor(() => stage(p, 'requirements').status === 'awaiting_review');
  const before = stage(p, 'requirements').artifacts.find(a => a.id === 'REQ-01');
  const v = before.version;
  const a = H.editArtifact(p, 'REQ-01', { content: '# 人工改过的需求\n\n补充：逾期罚金上限 100 元。' });
  assert.equal(a.content.length > 0, true);
  assert.ok(a.version > v, '版本应自增');
  assert.equal(a.edited.count, 1);
  assert.ok(fs.readFileSync(path.join(process.env.AI_PLATFORM_WORKSPACE, p.id, 'docs/01-需求分析/REQ-01.md'), 'utf8').includes('逾期罚金上限'), '编辑必须真实落盘');
  H.approveStage(p, 'requirements');
  assert.throws(() => H.editArtifact(p, 'REQ-01', { content: '偷改' }), /已锁定|已批准/);
});

test('人工改工作区代码：必须真跑测试，坏了就不许批准', async () => {
  const p = mk('human_gate', '编辑代码');
  for (const sid of ['requirements', 'ux', 'architecture', 'wbs']) {
    await waitFor(() => stage(p, sid).status === 'awaiting_review', 15000);
    H.approveStage(p, sid);
    await waitFor(() => stage(p, sid).status === 'approved');
  }
  await waitFor(() => p.modules[0] && p.modules[0].status === 'awaiting_review', 20000);
  const srcPath = p.modules[0].files.find(f => /^src\//.test(f.path)).path;

  // ① 改坏源码 → 真实重跑 → FAIL>0 → 批准被拦（且不会自动重生成，免得冲掉人工改动）
  const bad = await H.editWorkspaceFile(p, srcPath, 'export function slugify() { return 42; }\n');
  assert.ok(bad.test && bad.test.failed > 0, `坏代码必须真实测试失败：${JSON.stringify(bad.test)}`);
  assert.equal(p.modules[0].status, 'awaiting_review');
  assert.equal(p.modules[0].attempts, 1, '人工修改不得触发 Agent 重生成');
  assert.throws(() => H.approveModule(p, 'M1'), /单元测试未通过/);

  // ② 改成自洽的源码+测试 → 重跑通过 → 可批准
  await H.editWorkspaceFile(p, srcPath, 'export function add(a, b) { return a + b; }\nexport const N = 2;\n');
  const testPath = p.modules[0].test_path;
  const dirOf = (f) => f.split('/').slice(0, -1).join('/');
  const spec = (() => { const r = path.posix.relative(dirOf(testPath), srcPath); return r.startsWith('.') ? r : './' + r; })();
  const good = await H.editWorkspaceFile(p, testPath, `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '${spec}';\ntest('add', () => { assert.equal(add(1, 2), 3); });\n`);
  assert.equal(good.test.exit_code, 0, `自洽的代码应通过：${JSON.stringify(good.test)}`);
  assert.equal(p.modules[0].status, 'awaiting_review');
  H.approveModule(p, 'M1', '人工');
  assert.equal(p.modules[0].status, 'approved');
});

test('删除项目：移除状态与 workspace；执行中需二次确认（force）；迟到写入不重建目录', async () => {
  const p = mk('human_gate', '待删除项目');
  await waitFor(() => stage(p, 'requirements').status === 'awaiting_review');
  const root = path.join(process.env.AI_PLATFORM_WORKSPACE, p.id);
  assert.ok(fs.existsSync(root), '工作区应先存在');
  stage(p, 'requirements').status = 'running';                    // 模拟执行中
  assert.throws(() => H.removeProject(p.id), /正在执行中/);
  const r = H.removeProject(p.id, { force: true });
  assert.equal(r.forced, true);
  assert.equal(H.get(p.id), undefined, '状态里不应再有该项目');
  assert.ok(!fs.existsSync(root), 'workspace 目录应被删除');
  await assert.rejects(H.editWorkspaceFile(p, 'docs/x.md', 'y'), /已删除/, '迟到的写入必须被拒');
  H.kick(p);                                                      // 迟到的回调也不应推进
  assert.ok(!fs.existsSync(root), '删除后不应被迟到写入重建');

  const q = mk('human_gate', '空闲项目');
  await waitFor(() => stage(q, 'requirements').status === 'awaiting_review');
  assert.equal(H.removeProject(q.id).deleted, q.id, '空闲项目直接删除');
  assert.equal(H.removeProject(q.id).ok, true, '重复删除幂等');
});

test('新建项目可上传多份输入资料：真实落盘、记在项目上、并进提示词', async () => {
  const p = H.createProject({
    name: '带资料的项目', brief: '按上传的资料做', mode: 'human_gate',
    files: [
      { name: '需求-摘要.md', content: '# 需求\n读者能借书，逾期算罚金。' },
      { name: 'sub/dir/接口规格.yaml', content: 'openapi: 3.0.0' },   // 带路径 → 只取 basename
      { name: '空文件.txt', content: '   ' },                          // 空内容 → 跳过
      { name: 'bin.dat', content: 'a\u0000b' },                        // 二进制 → 跳过
    ],
  });
  assert.deepEqual(p.inputs.map(i => i.name), ['需求-摘要.md', '接口规格.yaml'], `应接收 2 份且文件名已归一：${JSON.stringify(p.inputs.map(i => i.name))}`);
  const root = path.join(process.env.AI_PLATFORM_WORKSPACE, p.id);
  for (const i of p.inputs) assert.ok(fs.existsSync(path.join(root, i.path)), `输入资料应真实落盘：${i.path}`);
  assert.ok(fs.readFileSync(path.join(root, 'inputs/需求-摘要.md'), 'utf8').includes('逾期算罚金'), '内容应原样落盘');
  assert.ok(p.events.some(e => e.text.includes('输入资料')), '接收资料要有事件');
  assert.ok(p.events.some(e => e.text.includes('跳过') && e.text.includes('二进制')), '跳过原因要写明');

  const agent = await import('../agent.mjs');
  const ex = await import('../exec.mjs');
  const brief = agent.inputsBrief(p);
  assert.ok(brief.includes('需求-摘要.md') && brief.includes('逾期算罚金'), '上传内容要进提示词片段');
  assert.equal(agent.inputsBrief({ inputs: [] }), '', '没有资料时片段为空');
  assert.ok(agent.inputsBrief({ inputs: [{ name: 'x', bytes: 1, excerpt: 'y'.repeat(9999) }] }).length < 7000, '提示词片段要有总量上限');
  assert.equal(ex.safeName('../../etc/passwd'), 'passwd', '路径穿越只能取 basename');
  assert.match(ex.safeName(''), /^file-/, '空名回落成 file-xxx');
  assert.equal(ex.safeName('a/../b.MD'), 'b.MD', '保留扩展名');
});

test('多 Agent 并行开发：不靠模块批准，多个模块同时被不同 Agent 完成', async () => {
  const p = mk('human_gate', '多 Agent 并行');
  for (const sid of ['requirements', 'ux', 'architecture', 'wbs']) {
    await waitFor(() => stage(p, sid).status === 'awaiting_review', 15000);
    H.approveStage(p, sid);
    await waitFor(() => stage(p, sid).status === 'approved');
  }
  await waitFor(() => p.modules.filter(m => m.status === 'awaiting_review').length >= 2, 30000);
  assert.equal(p.modules.filter(m => m.status === 'approved').length, 0, '此时不应有任何模块被批准');
  const agents = new Set(p.modules.filter(m => m.agent).map(m => m.agent));
  assert.ok(agents.size >= 2, `至少两个 Dev Agent 参与：${[...agents].join('、')}`);
  assert.ok(p.modules.filter(m => m.status === 'awaiting_review').length >= 2, '多个模块并行完成单元测试并待批准');
  // 并行批准不要求顺序：批准最后一个模块也应放行
  const last = p.modules.find(m => m.status === 'awaiting_review' && m.id === p.modules.at(-1).id) || p.modules.filter(m => m.status === 'awaiting_review').at(-1);
  H.approveModule(p, last.id);
  assert.equal(last.status, 'approved');

  // 驳回也要能自动重做（kick 立刻重新领取，attempts+1）——状态会直接进入 running
  const other = p.modules.find(m => m.status === 'awaiting_review');
  H.rejectModule(p, other.id, { category: '技术问题', comment: '禁止第三方依赖，改用内存模拟' });
  assert.notEqual(other.status, 'awaiting_review', '驳回后不应再停留在待批准');
  await waitFor(() => other.status === 'awaiting_review' && other.attempts === 2, 20000);
  assert.equal(other.review.decision, 'rejected');
});

test('各阶段调用模型：定义优先，未定义/非法值回落到缺省 deepseek', () => {
  const p = mk('human_gate', '阶段模型');
  assert.equal(H.DEFAULT_MODEL, process.env.AI_PLATFORM_MODEL || 'deepseek-v4-flash', '缺省模型是 DeepSeek');
  assert.deepEqual(p.models, {}, '新建项目默认不带任何阶段模型定义');
  assert.equal(H.modelFor(p, 'wbs'), H.DEFAULT_MODEL, '未定义 → 缺省');
  assert.equal(H.modelFor(p, 'development'), H.DEFAULT_MODEL, '未定义 → 缺省（源码生成同一条规则）');

  H.setStageModels(p, { wbs: 'deepseek-reasoner', development: 'deepseek-chat', 'no-such-stage': 'x', ux: '   ', requirements: 'y'.repeat(80) });
  assert.equal(H.modelFor(p, 'wbs'), 'deepseek-reasoner', '定义过 → 用定义的模型');
  assert.ok(!('no-such-stage' in p.models), '未知阶段 id 被忽略');
  assert.ok(!('ux' in p.models), '空白值不算定义');
  assert.ok(!('requirements' in p.models), '超长模型名被忽略');
  assert.equal(H.modelFor(p, 'requirements'), H.DEFAULT_MODEL, '其他阶段不受影响');
  assert.ok(p.events.some(e => /阶段调用模型/.test(e.text)), '模型变更写进事件流（可追溯）');

  assert.deepEqual(H.setStageModels(p, { wbs: '' }), { development: 'deepseek-chat' }, '传空串即删除该阶段定义');
  assert.equal(H.modelFor(p, 'wbs'), H.DEFAULT_MODEL, '删除定义 → 回到缺省 deepseek');
});

test('新建项目可直接带上各阶段模型定义（POST /api/projects 的 models 字段）', () => {
  const p = H.createProject({ name: '带模型创建', brief: 'x', mode: 'human_gate', models: { wbs: 'deepseek-reasoner', bogus: 'x' } });
  assert.equal(p.models.wbs, 'deepseek-reasoner');
  assert.ok(!('bogus' in p.models), '非法阶段 id 在入口就被挡掉');
  assert.equal(H.modelFor(p, 'ux'), H.DEFAULT_MODEL);
});

test('自动模式：全流程跑完，8 阶段全部批准，模块全部批准且单测 FAIL=0', async () => {
  const p = mk('auto', '端到端自动');
  await waitFor(() => p.stages.every(s => s.status === 'approved'), 150000);
  assert.equal(p.stages.filter(s => s.status === 'approved').length, 8);
  assert.equal(p.modules.length, p.wbs.epics.length);
  assert.ok(p.modules.every(m => m.status === 'approved'), '所有模块应批准');
  assert.ok(p.modules.every(m => m.unit_tests.failed === 0 && m.unit_tests.exit_code === 0), '单测必须 FAIL=0 且退出码 0');
  assert.ok(p.modules.reduce((a, m) => a + m.unit_tests.total, 0) > 0, '应有真实单元测试记录');
  const s = H.summary(p);
  assert.equal(s.stages_done, 8);
  assert.equal(s.modules_done, s.modules_total);
});

test('产物落盘目录按「流程序号-流程名」（模块产物归到模块开发）', () => {
  assert.equal(H.docDirOf('requirements'), 'docs/01-需求分析');
  assert.equal(H.docDirOf('ux'), 'docs/02-UI-UX 设计', '名字里的 / 折成 -，不制造多级目录');
  assert.equal(H.docDirOf('architecture'), 'docs/03-架构设计');
  assert.equal(H.docDirOf('wbs'), 'docs/04-WBS 分解');
  assert.equal(H.docDirOf('testing'), 'docs/06-集成测试');
  assert.equal(H.docDirOf('deployment'), 'docs/07-部署');
  assert.equal(H.docDirOf('operations'), 'docs/08-运维');
  assert.equal(H.docDirOf('M3'), 'docs/05-模块开发', '模块产物归到「模块开发」');
  assert.equal(H.docPathOf('deployment', 'DPL-02'), 'docs/07-部署/DPL-02.md');
  assert.equal(H.docDirOf('unknown-x'), 'docs/unknown-x', '认不出就原样兜底，不炸');
});

test('重新构建：清空全部产物与历史痕迹（阶段/WBS/架构/模块/工作区文件），技能与输入资料保留', async () => {
  const p = H.createProject({
    name: '重新构建测试', brief: '订单管理', tech: 'Node.js', mode: 'auto', human_gates: [],
    files: [{ name: 'brief.md', content: '输入资料：逾期罚金每册每天 0.50 元' }],
  });
  H.addSkill(p, { name: '约定A', body: '只允许 Node 内置模块' });
  await waitFor(() => p.stages.every(s => s.status === 'approved'), 150000);
  await waitFor(() => p.modules.length && p.modules.every(m => m.files.length), 150000);

  const ws = path.join(process.env.AI_PLATFORM_WORKSPACE, p.id);
  const arts = p.stages.reduce((a, s) => a + s.artifacts.length, 0) + p.modules.reduce((a, m) => a + m.artifacts.length, 0);
  const evBefore = p.events.length, modsBefore = p.modules.length;
  assert.ok(arts > 8 && p.modules.length > 0 && p.events.length > 10, '先得有东西可清');
  assert.ok(fs.existsSync(path.join(ws, 'docs')) && fs.existsSync(path.join(ws, 'inputs')), '工作区里有产物与输入资料');

  const r = H.rebuildProject(p.id);
  assert.equal(r.cleared.artifacts, arts, '记账的产物数与清掉的一致');
  assert.equal(r.cleared.modules, modsBefore, '模块数记在账上');
  assert.equal(r.cleared.events, evBefore, '事件条数记在账上');
  assert.equal(r.kept.skills, 1);
  assert.equal(r.kept.inputs, 1);
  assert.ok(p.stages.every(s => s.status === 'pending' && s.artifacts.length === 0 && s.attempts === 0 && !s.review && !s.error), '阶段回到未开始');
  assert.equal(p.wbs.epics.length, 0, 'WBS 清空');
  assert.equal(p.arch.from, 'type-default', '架构规约回到分类自带的那套（不再是 null）');
  assert.deepEqual(p.arch.layers, H.typeOf(p.type).layers, `目录规约 = 分类 ${p.type} 的层清单`);
  assert.equal(p.modules.length, 0, '模块清空');
  assert.equal(p.events.length, 1, '历史痕迹只剩重建这一条');
  assert.equal(p.events[0].kind, 'rebuild');
  assert.match(p.events[0].text, /技能 1 条、输入资料 1 份保留/);
  assert.equal(p.skills.length, 1, '技能保留');
  assert.equal(p.skills[0].name, '约定A');
  assert.equal(p.inputs.length, 1, '输入资料保留');
  assert.ok(fs.existsSync(path.join(ws, 'inputs')) && !fs.existsSync(path.join(ws, 'docs')), '工作区只留 inputs/');
  assert.ok(p.tech === 'Node.js' && p.name === '重新构建测试', '技术栈与项目名不变');

  // 正在执行时不许重建（与删除项目同一套口径）；强制重建后，在飞的那一轮结果不许再落地
  H.runStage(p, 'requirements').catch(() => {});
  await waitFor(() => stage(p, 'requirements').status === 'running', 5000);
  assert.throws(() => H.rebuildProject(p.id), /正在执行中/);
  const r2 = H.rebuildProject(p.id, { force: true });
  assert.equal(r2.cleared.artifacts, 0, '刚清完还没有新产物');
  await new Promise(res => setTimeout(res, 300));
  assert.equal(stage(p, 'requirements').status, 'pending', '在飞的那一轮不会把阶段推回 awaiting_review');
  assert.equal(stage(p, 'requirements').artifacts.length, 0, '在飞的旧结果不写回产物');
  assert.equal(p.events.length, 1, '事件流没有被旧一轮污染');
});

test('服务重启后残留的「执行中」状态归位（不假装还在跑，也不挡住重跑/重建）', async () => {
  const p = mk('human_gate', '重启归位测试');
  H.runStage(p, 'requirements').catch(() => {});
  await waitFor(() => stage(p, 'requirements').status === 'running');
  H.flush();                                     // 落盘：模拟「进程崩在跑了一半」的状态
  H.load();                                      // 重启（load 会重新解析磁盘上的状态，旧对象作废）
  const p2 = H.get(p.id);
  const st = stage(p2, 'requirements');
  assert.notEqual(st.status, 'running', '重启后不该还有 running');
  assert.match(st.error || '', /服务重启/, `要写明归位原因：${st.error}`);
  assert.ok(p2.events.some(e => /服务重启/.test(e.text)), '事件流里留痕');
});

test('上游技能（vendor/agent-skills）：映射表对得上、切片在预算内、导入后不依赖 vendor', () => {
  const sha = H.agxSha();
  assert.match(sha, /^[0-9a-f]{40}$/, 'vendor/agent-skills/SOURCE 记着 commit');
  const up = fs.readdirSync(path.join(ROOT, 'vendor/agent-skills/skills')).sort();
  assert.deepEqual(Object.keys(H.AGX_MAP).sort(), up, '映射表与上游 25 个技能一一对应（不多不少）');

  const agx = H.agxCatalog();
  assert.equal(agx.length, 25, `上游技能全部解析出来：${agx.length}`);
  for (const c of agx) {
    const max = H.AGX_MAP[c.id.slice(4)].max;
    const slice = c.body.split('\n').slice(1).join('\n');                 // 去掉「节选自…」抬头
    assert.ok(slice.length <= max + 40, `${c.id} 切片 ${slice.length} ≤ ${max}`);
    assert.ok(slice.length > 200 && slice.startsWith('【'), `${c.id} 有内容且按段抽取`);
    assert.ok(c.stage === '' || H.STAGES.some(s => s.id === c.stage), `${c.id} 阶段合法：${c.stage}`);
    assert.ok(c.name.startsWith('上游规范 · '), `${c.id} 名字带出处前缀：${c.name}`);
  }
  const catIds = new Set(H.skillCatalog().map(c => c.id));
  assert.ok(agx.every(c => catIds.has(c.id)), '上游技能并进预设技能库（能和本地技能一起选/导）');
  const fell = agx.filter(c => !/【Verification】|【Red Flags】/.test(c.body)).map(c => c.id);
  assert.ok(fell.length <= 1, `缺三段的走「各节兜底」的只有 using-agent-skills 这类：${fell.join('、') || '无'}`);
  for (const t of H.TYPES) {
    const ids = (t.skills || []).filter(s => s.startsWith('agx-'));
    assert.ok(ids.length >= 1 && ids.every(id => catIds.has(id)), `分类 ${t.id} 挂的上游技能都在库里：${ids.join('、')}`);
  }

  const p = H.createProject({ name: '上游技能导入', brief: 'b' });
  H.importSkills(p, ['agx-code-review-and-quality']);
  assert.equal(p.skills.length, 1, '导入一条');
  const one = p.skills[0];
  assert.equal(one.name, '上游规范 · code-review-and-quality');
  assert.ok(one.body.includes('【Verification】') && one.body.length <= 1400, `存的是切片文本（${one.body.length} 字符），不是 14KB 原文`);
  assert.ok(one.body.includes(sha.slice(0, 8)), '正文里写明取自哪个 commit（可追溯）');

  const q = H.createProject({ name: '预算检查', brief: 'b' });            // 分类自带的技能包整包导入，看注入预算
  H.importSkills(q, H.typeOf('webapp').skills);
  const brief = agent.skillsBrief(q, 'development');
  assert.ok(brief.length <= 18000, `单次注入 ≤ 18000 字符（实际 ${brief.length}）`);
  assert.ok(/上游规范 · code-review-and-quality/.test(brief), '预算塞得下：开发阶段的上游技能没被截掉');
});

test('预设技能：AI Agent Skills 标准格式（目录名=name、description 含触发、六节齐全、≤500 行）', () => {
  const dirs = fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  assert.ok(dirs.length >= 33, `skills/ 下每个技能一个目录（${dirs.length} 个）`);
  for (const id of dirs) {
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${id} 目录名要 lowercase-hyphen（规范的命名规则）`);
    const raw = fs.readFileSync(path.join(ROOT, 'skills', id, 'SKILL.md'), 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${id} 有 frontmatter`);
    const top = fm[1].split('\n').filter(l => /^\S/.test(l)).map(l => l.split(':')[0].trim());
    assert.deepEqual(top, ['name', 'description', 'metadata'], `${id} 顶层只许 name/description/metadata（实际 ${top.join('、')}）`);
    assert.match(fm[1], new RegExp(`^name:\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `${id}: name 必须等于目录名（小写连字符）`);
    const desc = (fm[1].match(/^description:\s*(.+)$/m) || [])[1] || '';
    assert.ok(desc.length >= 20 && desc.length <= 1024, `${id} description 长度 ${desc.length}（≤1024）`);
    assert.match(desc, /当|适用|使用/, `${id} description 要写清「何时用」：${desc.slice(0, 40)}`);
    assert.match(desc, /\buse (this )?when\b|\buse (before|after|during)\b/i, `${id} description 要有英文触发语（上游校验器认这条）`);
    for (const k of ['stage', 'tech', 'label']) assert.match(fm[1], new RegExp(`^\\s+${k}:`, 'm'), `${id} metadata 有 ${k}`);
    const heads = [...raw.matchAll(/^## (.+)$/gm)].map(m => m[1].trim());
    assert.deepEqual(heads, H.SKILL_SECTIONS, `${id} 六节顺序：${heads.join(' / ')}`);
    assert.ok(raw.split('\n').length <= 500, `${id} ≤500 行（实际 ${raw.split('\n').length}）`);
    const sec = (h) => raw.split(new RegExp(`^## ${h}$`, 'm'))[1].split(/\n## /)[0];
    assert.ok(sec('Common Rationalizations').includes('|'), `${id} 反合理化是表格`);
    assert.ok(/^- \[ \]/m.test(sec('Verification')), `${id} 验收是复选框清单`);
    for (const h of H.SKILL_SECTIONS) assert.ok(sec(h).trim().length > 20, `${id} 「${h}」有内容`);
    const c = H.skillCatalog().find(x => x.id === id);
    assert.ok(c && c.name && c.desc && c.body.includes(`## ${H.SKILL_SECTIONS[0]}`), `${id} 被 skillCatalog 正确解析（name=${c?.name}）`);
  }
  // 再用上游自带的参考校验器跑一遍（vendor 在才跑）：0 error / 0 warning = 真·标准格式
  const lintPath = path.join(ROOT, 'vendor/agent-skills/scripts/lib/skill-lint.js');
  if (fs.existsSync(lintPath)) {
    const { lintSkill } = createRequire(import.meta.url)(lintPath);
    const known = new Set(dirs);
    for (const id of dirs) {
      const r = lintSkill(id, path.join(ROOT, 'skills'), known);
      assert.deepEqual(r.errors, [], `${id} 上游校验器无 error`);
      assert.deepEqual(r.warnings, [], `${id} 上游校验器无 warning（含交叉引用）`);
    }
  }
});
