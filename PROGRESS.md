# PROGRESS — ai-platform（软件开发可视化平台）

> 交付现状与**可复跑验收**。接手前先读本文件，再读 [`README.md`](README.md)。
> 状态：[[MVP]] 平台可运行，**真实模型生成交付物 + 架构阶段定技术栈与源码目录结构 + 代码按层归档 + 真实落盘/真跑 `node --test` + 多 Agent 并行 + 产物可编辑（已批准锁定）+ 新建项目可上传输入资料 + 「源码」模块（左树右码、高度自适应）+ 各阶段调用模型（缺省 DeepSeek）+ 项目可删除 + 布局自适应**，门禁读真实退出码。
> **源码目录结构规约**：架构阶段在 ARC-01 里声明「技术栈 + 层清单」，模块源码按 `src/<层>/m<NN>-<slug>/` 归档、测试镜像到 `test/<层>/`，产物记录代码位置（真实模型通道与离线通道同一套，见 §9）。
> 实测（2026-10-07）：`bash tools/run_all.sh` = 单测 27 + 离线端到端 64 + UI 检查 65，FAIL=0；`bash tools/run_all.sh --live` 追加真实模型端到端 33，FAIL=0（107s，其中 WBS 阶段按定义调用 deepseek-reasoner）。

## 1 交付了什么

| 层 | 内容 | 落地 |
|---|---|---|
| 状态机（HARNESS） | `harness.mjs`：8 阶段流水线、人工门禁、WBS、**多 Agent 并行开发**、单元测试门禁、驳回返工（反馈喂回模型）、事件流、JSON 持久化 | [[MVP]] |
| 模型通道（AGENT） | `agent.mjs`：OpenAI 兼容 /chat/completions（默认 DeepSeek），提示词 + 输出校验 + 截断重试；**一份交付物一次调用**；**逐阶段调用模型**（`project.models[stageId]`，未定义回落缺省 deepseek） | [[MVP]] |
| 真实执行（EXEC） | `exec.mjs`：工作区写入（路径白名单）→ 真跑 `node --test` / `node --check` → 解析真实统计与退出码 | [[MVP]] |
| 离线通道（SIM） | `sim.mjs`：仅在 `AI_PLATFORM_PROVIDER=sim` 时使用，产出真实可跑的模板代码（也真跑测试，不编数字） | [[MVP]] |
| 服务（API） | `server.mjs`：零依赖 HTTP，REST + **SSE 实时推送** + 工作区文件读取 | [[MVP]] |
| 界面（UI） | `public/`：6 视图 + 暗亮主题 + 密度切换 + 快捷键；「产物」页可看**真实落盘的工作区文件** | [[MVP]] |
| 验收（TESTS） | `test/harness.test.mjs`（17）+ `test/agent.test.mjs`（4，本地假模型服务，断言真发出去的 model 名）+ `test/tree.test.mjs`（6）+ `tools/e2e.mjs`（64）+ `tools/e2e_live.mjs`（33）+ `tools/ui_tree.mjs`（65）+ `run_all.sh` | [[MVP]] |
| 多用户/鉴权、产物 diff | 未做 | [[v2]] |

## 2 需求对照（用户诉求 → 实现 → 由谁证明）

| 诉求 | 实现 | 证明 |
|---|---|---|
| 可运行的软件开发可视化平台 | `node server.mjs`，SSE 实时可视化 | e2e [1]；`--live` [1] 通道 = deepseek-v4-flash |
| 项目初始入口 | 「项目」视图新建表单（名称/技术栈/概要/模式） | e2e [2]、`--live` [2] |
| 每个步骤审核批准才进入下一步 | 阶段执行完 → `awaiting_review`；批准才释放下一阶段；越序执行 409 | 单测「门禁：前序未批准…」；e2e [3][4] |
| WBS 分解 | 真实模型拆 Epic/Task，一等模块生成 | `--live` [3]：6 Epic / 18 Task（借阅核心流程、逾期罚金计算…） |
| 架构阶段定代码结构 | ARC-01 声明「技术栈 + 层清单」json 块 → 平台解析成 `project.arch`；解析失败退回默认层并在事件流说明来源 | 单测「架构规约：ARC-01 声明的层清单被解析…」「parseLayout…」；e2e [6]；`--live` [3b] |
| 没给技术栈就自己定 | 模型把选型写进同一个 json 的 `stack`，作为事实传给 WBS 与代码生成；事件流标明「用户未指定，由模型选型」 | 单测「技术栈缺省时由架构阶段给出…」；`--live` [3b]：模型自选 `Node.js 20 ESM + … + node:test`，自定 5 层 |
| 代码归类到标准目录 | Epic 自报 layer（非法回落）→ `src/<层>/m<NN>-<slug>/`，测试镜像 `test/<层>/`；写盘后校验每个文件都在层目录下 | 单测「模块真的把代码写进工作区…」；e2e [6]：`src/api/m4-接口层/index.mjs`；`--live` [4]：5 个文件全在 `src/core/m1-基础框架/` |
| 产物记录代码位置 | 模块产物头部固定写 `**架构层** / **代码位置** / **测试位置**` + 真实交付文件与行数 | 单测「模块产物应记录代码位置…」；e2e [6]；界面模块详情同步展示 |
| 每个模块开发完成需完成单元测试 | 模型生成代码与测试 → 真实执行 `node --test` → 记录真实统计与退出码 | 单测「模块真的把代码写进工作区…」；`--live` [4]：9/9、退出码 0 |
| 开发多 Agent 并行 | `AI_PLATFORM_CONCURRENCY`（默认 3）个 Dev Agent 并行领取模块，各自写码/跑测/等批准；批准不要求顺序 | 单测「多 Agent 并行开发…」；e2e [5]：Dev-Agent-1/2/3；`--live` [4]：三个 Agent 同时开工 |
| 产物可编辑保存 | 产物正文与工作区文件都能改并落库/落盘；已批准锁定（409）；改代码自动重跑真实单测 | 单测「人工编辑产物…」「人工改工作区代码…」；e2e [2b] 与 [4][6] 的 409 |
| 删除项目 | 卡片上 ✕ 删除（原生确认），连 `workspace/<id>/` 一起删；执行中 409 拒绝；幂等 | 单测「删除项目…」；e2e [7] |
| 描述/布局适配屏宽 | 概要按宽度换行（3 行截断 + title 全文）；多栏在 ≤1560/1360/1120/820 逐级折叠 | 截图 10–13（1000px / 820px 实拍） |
| 目录树高度适配屏幕高度 | 三栏卡片撑满可用高度，左树/代码区各自出滚动条（占位式、看得见）；项目页（项目列表+新建表单）、总览（阶段流水线+活动流）、流程与门禁（阶段详情+阶段交付物）、开发页签（模块开发+模块详情）、任务树同规则吃满窗口，开发阶段的模块区块跟在上面两卡之后；撤掉 `tablewrap` 的 460px 上限，高屏下树跟着窗口长高 | UI 检查 [7]（1440×520 矮窗：两栏 `offsetWidth-clientWidth ≥ 8` ＝滚动条占位可见）+ [8.8]~[8.11]（总览/流程/开发+任务树/项目：1000 与 1400 两档吃满 + 窄屏 58vh）+ [7.5]（1440×1200 高窗：树 983px、留白 ≤2px）、截图 21/24/29/30/32/33 |
| 可定义各阶段调用模型 | 界面「流程与门禁 → 阶段详情」下拉 / `POST /api/projects/:id/models` / 新建项目 `models` 字段；缺省 DeepSeek `deepseek-v4-flash` | 单测「各阶段调用模型…」+ `test/agent.test.mjs`（假模型服务记录请求体）+ e2e [2c] + UI 检查 [8.5] + `--live`（WBS 用 deepseek-reasoner 跑通） |
| 项目信息可编辑保存 | 项目卡「✎ 编辑」→ **右侧那一栏换成「编辑项目」表单，条目与新建完全一致**（名称 / 概要 / 软件分类 / 技术栈（建议下拉）/ 工作流 / 执行模式 / 输入资料）；**分类与工作流可选**，改了按新流程重排阶段（同 id 保留状态与交付物、多的补 pending、去的移除记录，运行中 409）；补资料走 `POST …/inputs`（同名覆盖）；`PUT /api/projects/:id` 幂等、空名 400、超长截断 | 单测「项目信息可以编辑…」「编辑里改软件分类 / 工作流…」+ e2e `[2f]`/`[2g]` + UI 检查 `[8.24]`/`[8.26]`（换分类 → 阶段真重排），截图 `out/60-proj-edit.png` |
| 每个阶段都有自己的专业 skill 文档 | 侧栏「技能」技能库：`name / body / stage`，stage 空=所有阶段；`skillsBrief(project, stageId)` 注入阶段交付物、WBS、模块代码三条路径；每项目上限 60 条 + 单次注入 18000 字符预算。**预设技能库** `skills/*.md` 共 **33 条本地**（每个阶段 2–4 条专业技能 + 开发阶段 7 条技术栈专属：Spring Boot / Struts2 / Node.js / SAP CAP·RAP / Python / 静态网站 / React+Vite + 代码目录与命名规约 `dev-code-layout` + 跨阶段安全底线 `security-baseline` + 跨阶段环境自举 `env-bootstrap`）+ **25 条上游**（`vendor/agent-skills`，只抽 Verification/Red Flags/Rationalizations 三段、每条 ≤1200 字符，见「预设技能库」节的说明），界面按阶段/技术栈筛选一键导入、重复导入自动跳过、超上限自动跳过并说明 | 单测「技能库：增删改查…」「技能可以只作用于某个阶段…」「阶段专属技能只进对应阶段的提示词」「技能太多时按预算截断注入」「预设技能库：每个阶段都有技能文件…」「导入预设技能…」+ e2e [2d][2e] + UI 检查 [8.12][8.13]，截图 34/35 |
| 技能批量删除 | 技能列表每行勾选框 + 「全选 / 取消全选」+「删除选中（N）」（未勾选禁用、confirm 后才删）；`POST …/skills/delete {ids}` 一次事件记账、失效 id 忽略 | 单测「技能批量删除…」+ UI 检查 [8.23] |
| 软件分类（决定流程 + 技能包 + 目录规约） | 每个分类在 `TYPES` 里配三样：默认流程、**技能包**（`skills` 指向 `skills/*.md`，技能页「⬇ 分类技能包（N）」一键导入，幂等；仍以项目自己那份为准）、**目录规约**（`layers`，新建即生效 `arch.from='type-default'`，架构阶段声明合法层时以 ARC-01 为准；♻ 重建或换分类/流程都回到分类自带的那套）；`checkTypes()` 自检技能都在预设库、层清单合法；`/api/state` 把整套配置发给界面（提示行显示「分类技能包 N 条 · 目录规约 a/b/c」） | 单测「项目类型：每个类型带出自己的默认流程…」（含技能包/目录规约自检 + 新建即带目录规约）+ e2e `[2g]`（/api/state 带 skills/layers、网站分类目录规约 core/content/ui/app）+ UI 检查 `[8.13b]`（一键导入 8 条、幂等）+ `[8.25]`（提示行写出技能包与目录规约），截图 `out/61-proj-type.png` |
| 工作流（按客户需求选阶段序列） | 新建项目选一条工作流（`full` / `lean` / `prototype` / `change` / `design`），它决定项目走哪些阶段；老项目无该字段 = 全流程；产物落盘序号与界面序号都跟项目自己的工作流走 | 单测「按客户需求选工作流…」+ UI 检查 [8.22] |
| 并由人工批准方可进入下一阶段 | 模块门禁要求 `FAIL=0` 且退出码 0，前序模块未批准则 409 | 单测「单元测试未通过不能批准」（含退出码非 0 的分支）；`--live` [4] |
| 不是演示数据 | 交付物来自真实模型；代码真实落盘；测试真实执行；无 Key 时明确失败而不是假装成功 | `--live` [2][4]、e2e [6] |
| 整个动态执行过程可视 | SSE + 阶段脉冲 + 事件流 + 工作区文件浏览器 | 截图 02/05/06/07 + 事件流计数 |

## 3 如何验证（实测命令与结果）

```bash
cd ~/Developer/tools/ai-platform-workspace/ai-platform
bash tools/run_all.sh          # 离线：单测 16 + 端到端 52，FAIL=0
bash tools/run_all.sh --live   # 追加真实模型端到端 30，FAIL=0
```

`--live` 一次真实运行的实测输出（2026-10-04，耗时 83.0s）：

```
[1] 模型通道        通道 = live · 模型 = deepseek-chat
[2] 需求交付物      3 份，最短 2480 字符，正文含借阅/还书/罚金
[3] 逐阶段推进      批准 requirements/ux/architecture 各 2–3 份交付物
    WBS: 基础框架 / 图书与读者管理 / 借阅核心流程 / 逾期罚金计算 / 借阅记录查询与统计 / 导出与接口层
                    → 6 Epic / 18 Task，非模板产物
[4] 真实代码+单测   模块 M1「基础框架」→ 4 个文件落盘
    node --test test/m1-mod.test.mjs → total 9 / passed 9 / failed 0 / exit_code 0
                    → 门禁放行批准
RESULT: PASS (PASS=19 FAIL=0)
```

统计口径：离线端到端一次运行 = 5 Epic / 10 Task / 5 模块 / 30 条真实单测 / 22 个工作区文件 / 89 条事件。

截图（`out/`，1680 宽）：

```
00-projects.png    项目入口（新建表单 + 项目卡片）
01-overview.png    总览（KPI + 流水线 + 活动流）
02-flow.png        流程与门禁（8 节点 + 阶段详情 + 交付物 + 门禁面板）
03-wbs-dev.png     WBS / 开发（模块开发 tab；WBS 未完成时为空态）
04-artifacts.png   产物：真实模型生成的《需求规格说明书》正文渲染
05-runs.png        执行记录（事件流）
06-workspace.png   工作区文件：真实落盘内容
07-edit-artifact.png 产物编辑：卡片头部的「✎ 编辑」按钮 + 真实单测输出
08-edit-file.png   工作区文件编辑入口
09-projects-wide.png 项目入口（含 ✕ 删除按钮）
10-projects-narrow.png 1000px：单栏折叠 + 概要换行 + 删除按钮不折行
11-artifacts-narrow.png 1000px：产物三栏折叠
12-overview-narrow.png  1000px：KPI 2 列 + 流水线卡片内横滚
13-flow-tiny.png   820px：窄屏流水线
14-arch-layout.png 架构规约：页头技术栈+分层+来源，模块详情 架构层/代码位置/测试位置
15-upload-form.png 新建项目表单：多选输入资料 + 已选清单 + 清空选择
16-upload-project.png 创建后卡片显示「输入 2 份」
17-workspace-tree.png 源码浏览：左目录树（缩进+目录文件数）+ 右预览
18-workspace-edit.png 源码浏览：右侧编辑态（文本域 + 保存文件）
19-workspace-real.png 真实项目（50 文件）的源码浏览
20-source-module.png 「源码」模块：只列 src/test，右栏带归属模块/层/代码位置/单测
21-code-fit-short.png 矮窗口 1440×520：两栏自滚，页面不滚
22-code-fit-narrow.png 窄窗口 900×700：单栏折叠，整页滚
```

## 4 本轮修掉的真 bug（都抓到并验证）

1. **`NODE_TEST_CONTEXT` 继承 → 嵌套 `node --test` 假绿**。在 `node --test` 驱动的进程里再 spawn `node --test`，子进程会打印 “skipping running files” 并以退出码 0 结束、**零输出**；于是「单测 0 条、退出码 0」被当成通过，自动模式下模块永远卡在门禁上。修法：`exec.mjs` 的 spawn 清掉 `NODE_TEST_CONTEXT`/`NODE_V8_COVERAGE`，并把「零输出」判为失败（`exit_code → -1`），双层防护。
2. **架构阶段的交付物被 max_tokens 截断**，JSON 变 `Unterminated string`。修法：改成一**份交付物一次模型调用**（单份短、可控），并在 `chat()` 里识别 `finish_reason === 'length'` → 自动加大预算重试一次。
3. 离线模板的 `slugify` 断言与实现不一致（`_` 未折叠）→ 真实跑测试时暴露，修正实现。
4. WBS 阶段原先在 `runStage` 里同步校验、异步执行混在一起，路由 `.catch(()=>{})` 让门禁 409 永远返回 200。修法：守卫抽成同步 `checkStageRunnable` / `checkModuleRunnable`，路由与执行器共用。
5. **模型偷偷用第三方包**（真实模型跑出 `import { Pool } from 'pg'` → `ERR_MODULE_NOT_FOUND`）。门禁**正确地**用退出码 1 拦住了批准（这是期望行为），但提示词里补上「禁止任何第三方包，需要存储就用内存对象」提高一次通过率。
6. **人工改坏的模块被 Agent 悄悄重新生成**：编辑代码后测试失败 → 我曾把模块标成 `failed`，而 `kick()` 的候选里含 `failed` → 并行池立刻重新领取并**覆盖掉人工改动**。修法：人工改过的模块一律回到 `awaiting_review`（不触发重生成），批准由真实 `FAIL>0` 拦住；并把 `failed` 的自动重试限制为 3 轮，避免模型反复失败时无限循环。
7. **模块代码被 8192 天花板截断 → 模块直接 failed**（真实项目：`M2 CDS 数据模型` 连败两轮，`模型输出被截断（finish_reason=length，已达 8192 tokens）`）。8192 是平台自己写死的 `MAX_OUT`，不是模型的能力——实测同一通道 `max_tokens=40000` 能一路吐到 `finish_reason=stop`（27155 completion tokens），`max_tokens=131072` 也不被拒（`/models` 只列 `deepseek-flash`、`deepseek-v4-pro`，两个名字都收）。修法：`MAX_OUT` → **65536**，且截断重试不再小步翻倍、直接用满上限（`attempt === 1 ? maxTokens : MAX_OUT`）；`test/agent.test.mjs` 加断言（假服务先回 `length` 再回 `stop`，断言重试真的用 65536；两次都 `length` 才失败）。修后同项目 6 个模块重跑：M1 9/9、M2 16/16（本轮输出 20003 tokens，落 5 个文件）、M4 13/13、M5 12/12、M6 12/12 全 rc=0；M3 10/11 rc=1 —— 模型自己写的测试真挂了，门禁按设计拦住批准。
8. **同路径不同方法的路由全被 405 挡掉**：`GET /file` 排在 `PUT /file` 前面，路由器遇到方法不匹配直接返回 405 而不是继续匹配 → PUT 永远到不了处理器。修法：方法不匹配用 `continue`，整表都没命中再按「路径命中→405 / 没命中→404」返回。
9. **SSE 连接泄漏 → 页面自己的请求永远排队**：`/api/stream` 只监听 `req.close` 收摊，页面刷新/导航后连接可能半开且心跳继续往死 socket 写，`clients` 越攒越多；浏览器对同一 host 的 HTTP/1.1 并发约 6 条，被这些流占满后，界面自己发的 `fetch`（保存技能、切模型）**一直 pending，页面表现是「点了没反应」，而服务端根本没收到请求**。修法：`req`/`res` 的 `close`+`error` 都收摊、心跳检测 `writableEnded/destroyed`、并发流上限 12（超出 503），前端 `pagehide` 主动 `es.close()`。定位过程：UI 检查里挂 fetch 钩子，看到请求发出但无响应，同时 Node 直发同一接口 200。

## 5 设计取舍（有意为之）

- **门禁一律服务端强制**：界面置灰只是提示，真正拦截在 harness 的三个校验函数里，所以能纯 HTTP 断言 409。
- **模型通道与执行通道分离**：`agent.mjs`（怎么想）/ `exec.mjs`（怎么验）互不依赖；换模型只改 `agent.mjs`。
- **产物与代码都落盘**：`workspace/<项目ID>/docs/*.md` 与 `src|test/*.mjs`；界面能直接读真实文件（`/api/projects/:id/file`）。
- **没有 Key 时不假装成功**：阶段直接 `failed` 并给出原因，界面显示「执行失败 + 重试」。
- **只测纯函数**：提示词明确禁止网络/文件系统/时间/随机，保证真实测试可复现。

## 6 已知边界

- 无鉴权、无多用户；模型调用是串行的，一个项目全自动跑完（12–16 次调用）约 3–6 分钟。
- 模型输出质量决定成败：产出的测试若真的失败，门禁会正确拦住（这是设计），此时需要人工驳回并写清返工意见，模型会按意见重做。
- `data/projects.json` 与 `workspace/` 是运行态，可直接删除回到空入口。
- 事件上限 800 条（超出丢弃最旧）。

## 7 下一步（建议）

1. 驳回返工的产物 diff（v(n) → v(n+1)）做出来，回答「为什么最终这样」。
2. 模块开发失败时自动带反馈重试一次，再交人工。
3. 门禁加审批人/角色。
4. 模型调用并行化（模块之间目前严格串行，是为门禁顺序语义保留的）。

## 8 变更历史

| 时间 | 变更 | 实测 |
|---|---|---|
| 2026-10-17 | **要件台帳再走査エンドポイント**（AI ワークフロー設計レビュー §P0-1 対応）：`POST /api/projects/:id/ledger/rescan` を追加。`harness.mjs#rescanLedger()` は入力資料だけから ID を決定的に抽出し直し、消えた ID はモジュールの `req_ids` から自動で落とす（モジュール自体は残す）。走行中は 409、入力無しは 400。スモーク：`P-mvc4ke1z-zu1p`（交通局案件、台帳機能导入前）→ 11 ファイル / 845,590 bytes → 321 IDs、`docs/test-triage-2026-10-17.md` に分類した 42 件の既存テスト失敗のうち # P0-3 は「テスト文言の正本は別ファイル」を表明し、ここでは改正しない方針に変更 | 新規 4 件PASS / 既存回归 0 |
| 2026-10-04 | 首版：状态机 + 服务 + 6 视图 + 离线端到端 | 单测 7 + e2e 23，FAIL=0 |
| 2026-10-04 | 去演示数据：接真实模型（DeepSeek）+ 真实落盘/真跑测试 + 工作区浏览 | 单测 8 + 离线 e2e 30 + 真实模型 e2e 19，FAIL=0 |
| 2026-10-04 | 开发阶段多 Agent 并行（`AI_PLATFORM_CONCURRENCY`，默认 3）+ 提示词禁第三方包 | 单测 9 + 离线 e2e 33 + 真实模型 e2e 20，FAIL=0 |
| 2026-10-04 | 产物与工作区文件可人工编辑保存；已批准锁定；改代码自动重跑真实单测 | 单测 11 + 离线 e2e 39 + 真实模型 e2e 20，FAIL=0 |
| 2026-10-04 | 项目可删除（连 workspace）；布局与项目描述按屏宽自适应 | 单测 12 + 离线 e2e 43 + 真实模型 e2e 20，FAIL=0 |
| 2026-10-04 | **源码目录结构规约**：架构阶段 ARC-01 声明层清单 → 模块按 `src/<层>/m<NN>-<slug>/` 归档、测试镜像到 `test/<层>/`（两通道同一套；路径只算一次）；目录名支持中文（`safeRel` 放行 CJK + NFC 归一） | 单测 13 + 离线 e2e 46 + 真实模型 e2e 21，FAIL=0 |
| 2026-10-05 | 技术栈缺省由架构阶段选型（`stack` 进同一个 json 块，作为事实贯穿 WBS/代码）；产物固定记录 架构层/代码位置/测试位置；界面显示规约与代码位置 | 单测 15 + 离线 e2e 50 + 真实模型 e2e 28，FAIL=0 |
| 2026-10-05 | **新建项目多文件上传**：文本文件（≤256KB/份、≤10 份）→ 落盘 `workspace/<id>/inputs/`、记入 `project.inputs`、内容进提示词（需求/架构/WBS）；空/二进制跳过并写明原因；卡片与总览显示资料数 | 单测 16 + 离线 e2e 52 + 真实模型 e2e 30，FAIL=0 |
| 2026-10-05 | **源码文件浏览**：左目录树（可收起、目录带递归文件数）+ 右预览/编辑；树是纯函数 `public/tree.mjs`（单测 4 条），深链自动补拉；新增自包含 UI 检查 `tools/ui_tree.mjs`（自起服务+Chrome，断言无未捕获异常）并入 `run_all.sh` | 单测 20 + 离线 e2e 53 + UI 检查 17，FAIL=0 |
| 2026-10-05 | **源码模块**（侧栏「源码」，快捷键 4）：只浏览产出代码（`isSource` 排除 docs/inputs/点文件），右栏预览/编辑 + 归属模块/架构层/代码位置/该模块单测状态；与产物页共用 `codeBrowser`/`codeGrid`；工作区列表过滤点文件 | 单测 21 + 离线 e2e 55 + UI 检查 26，FAIL=0 |
| 2026-10-05 | **高度自适应**：宽屏 `.app` 固定 100vh + `.page` flex → 左树/源码区各自占满高度并按内容出滚动条（撤掉 `<pre>` 写死的 68vh）；窄屏单栏改为每栏限高 58vh 自滚、整页滚；UI 检查加矮窗口 1440×520 与窄窗口 900×700 两组断言 | 单测 21 + 离线 e2e 55 + UI 检查 37，FAIL=0 |
| 2026-10-05 | **源码可编辑保存实测 + 修 bug**：UI 检查走完整链路（点✎编辑→改文本→保存文件），断言接口/磁盘内容一致、单测自动重跑且记录刷新、模块不被当成已批准；修「保存后右侧预览仍显示旧内容」（保存后要重新读回文件，`refreshWorkspace` 只刷新列表不刷新正文）；已批准模块界面无编辑按钮 + 绕过界面 PUT 也 409 | 单测 21 + 离线 e2e 55 + UI 检查 56，FAIL=0 |
| 2026-10-06 | **目录树高度真的适配屏高**：左栏卡片本体带 `tablewrap`（`max-height:460px`），高屏下树到 460px 就封顶、卡片里留一大片空白；`public/app.css` 加一条 `.grid.g-tree > .card > .body.tablewrap { max-height:none }`，源码页与产物页共用一套骨架一起修好。UI 检查加高窗口 1440×1200 断言（树高 983px > 460，卡片留白 ≤2px） | 单测 21 + 离线 e2e 55 + UI 检查 59，FAIL=0 |
| 2026-10-07 | **各阶段调用模型（不定义 = 缺省 DeepSeek）**：`project.models[stageId]` 逐阶段定义，未定义/空白回落 `AI_PLATFORM_MODEL`（默认 `deepseek-chat`）；界面「流程与门禁 → 阶段详情」下拉改（运行中禁用），API `POST /api/projects/:id/models`（空串=删除定义，只认 8 个阶段 id），新建项目可带 `models`；生效点：交付物逐份、WBS、模块代码；事件流记录变更与当轮模型；新增**线上字节级**单测 `test/agent.test.mjs`（本地假模型服务记录请求体，断言每阶段真发出去的 model 名 + 错误码不静默降级） | 单测 27 + 离线 e2e 64 + UI 检查 65 + 真实模型 e2e 33，FAIL=0 |
| 2026-10-09 | **编辑按钮双笔**：`act.edit` 的三语词条本身已含 `✎`（`['✎ 编辑','✎ Edit','✎ 編集']`），技能行按钮又硬编码了一个 `✎` → 显示成两支笔。去掉按钮里的硬编码图标（产物/源码的编辑按钮本来就只有词条里那一个）。UI 检查 [8.12] 加守卫：全页没有双 `✎` 按钮、`[data-skill-edit]` 文案恰好一支笔 | 单测 48 + 离线 e2e 96 + UI 检查 150，FAIL=0 |
| 2026-10-09 | **技能列表配色 + 加宽**：技能名/流程序号/流程名三色分开 —— 名字 `--ink`、序号 `--accent`（琥珀、加粗）、流程名 `--ink-2`（`.nmcol .stat .no/.sn`，节点文案拆成两个 span，`[data-skill-stage]` 仍在外层、textContent 保持 `01 需求分析`）；左栏宽度 `minmax(300px,400px)` → `minmax(360px,460px)`（≤1560px 用 `300–380px`），名字基本一行放得下。UI 检查 [8.12] 加三色断言（取 computed color 比不相等）、[8.14] 宽度断言改成 `380 ≤ listW ≤ 470` | 单测 48 + 离线 e2e 96 + UI 检查 149，FAIL=0；实测 dark 主题下三色 `rgb(231,235,239) / rgb(224,163,60) / rgb(174,184,194)`，列表 460px / 右栏 960px；截图 out/49-skills-colors.png |
| 2026-10-09 | **源码页内容区：没内容就留空（写进显示规约）**：`codeBrowser()` 的中间区改成 `mid = WS.content ? <pre>…</pre> : ''` —— 新建项目 / 工作区被清空 / 文件读不到时内容区渲染**空**，不再渲染 `code.hint`/`code.hintPlain` 提示文案（两个词条连同三语一起删掉，`hint:` 参数从两个调用点移除）；空态说明只留左侧列表（`code.emptyList`/`code.emptyWs`）与页头。UI 检查 [8.18] 追加：新建项目内容区 `innerHTML` 长度 0、无 `<pre>`，且左列表仍写「还没有产出源码」 | 单测 50 + 离线 e2e 110 + UI 检查 176，FAIL=0；截图 out/56-source-fresh-blank.png |
| 2026-10-09 | **任务树状态上色 + 执行中自动展开与指示灯**：`public/app.js` 任务树每行改为「状态 = 所属模块状态」（`data-status` 落在 Epic/任务行上），右侧状态区新增 `.stcell`（药丸/小圆点）+ 左缘 2px 同色色条（`:not(.sel)` 避免压掉选中色条）；正在执行的 Epic **自动展开**（`S.epicOpen[e.id] ?? (st === 'running')`）+ 复用 `.pulse` 呼吸灯，子行圆点同动画；卡片底部加 `MSTS` 色图例（三语复用 `wbs.noModule` 新增词条）；`.tnode` 网格第一列（编号）18px/62px → 18px/**92px** 加宽、名称左缘对齐。新断言（真跑一个模块看）：`驳回后重跑 M2：接口侧状态 running（第 2 轮）`、自动展开（2 个子行）、`animationName=pulse` + 蓝点 `rgb(79,157,255)`、子行同动画、跑完指示灯消失并变「待批准」 | 单测 50 + 离线 e2e 110 + UI 检查 174，FAIL=0；截图 out/55-tree-running.png |
| 2026-10-09 | **服务重启后残留「执行中」归位**：`harness.load()` 里把磁盘上仍是 `running` 的阶段/模块归位为 `failed`（error 写明「服务重启中断」）并写一条事件 —— 进程内执行不可能跨重启存活，之前重启后项目永远显示在跑，还挡住重跑与「重新构建」（未 force 直接 409）。本机实测：重启后用户项目的 `development/M3/M4/M5/M6` 五个残留 running 一次性归位并留痕。单测 +1（`flush()` 落盘 → `load()` 重启 → 断言归位与留痕） | 单测 50 + 离线 e2e 110 + UI 检查 174，FAIL=0 |
| 2026-10-09 | **源码面清空后不留旧内容**：`refreshWorkspace()` 拿到新的文件列表后，若 `WS.path` 已不在列表里（重新构建/删除/换盘导致文件消失）就一起清掉 `WS.path`/`WS.content`/`S.editFile`/`DRAFT` —— 否则中间编辑区继续渲染上一份 `<pre>`（用户报告的现象）。`openFile()` 读不到文件时同样清掉，不再留着旧内容。UI 检查新增 `[8.18]`（先确源码面有内容 747 字符 → 重新构建清空工作区 → 断言不再有 `<pre>`、旧内容不出现）；**做了反向验证**：临时把守卫改成 `if (false && …)` 跑一次，`[8.18]` 如实 FAIL 并打出旧文件 `src/api/接口层.mjs`，恢复后 PASS。顺手修掉空态文案里残留的旧目录说明（`code.emptyList` 三语：`src/<层>/m<NN>-<slug>/` → `src/<层>/` 业务命名） | 单测 49 + 离线 e2e 110 + UI 检查 167，FAIL=0；截图 out/54-source-empty.png |
| 2026-10-09 | **文件名不带 WBS 序号（写进开发通用规则）**：`skills/development-通用规范.md` 加一条命名规约（业务语义优先，不写 `M1OrderService.java`/`m1_order_service.py`/`E2T1…`，同层重名换更具体的业务名），`skills/dev-code-layout.md` 同步改口径；平台跟着改：`agent.mjs` 新增 `codeNameOf/srcFileOf/testFileOf`（Node kebab / Python snake / Java PascalCase，`testPathOf(profile,layer,i,name)`），ARC-01 规约行 / langSpec 三处 `files` 规则 / Java 类名与测试类名（`${testClass}` 从测试文件名推，langSpec 不再吃 `modId`）/ 模块 user prompt / JSON 示例全部去掉「文件名带模块号」；`exec.mjs` PROFILES `testPath(layer,file)`；`harness.mjs` 项目名册 `planModules` 的 slug 去掉 `m<NN>-` 前缀（重名才加 `-2`），归属判定改为「生成记录精确匹配 → 该层目录里只有这一个模块」（不再按名字里的模块号认领），规约偏差检查改成「文件名不许以 `M1`/`m1_` 开头」并新增同层重名告警（会同层互相覆盖），顺手把「人工改代码必须重跑单测」从硬编码 `.mjs` 改成按语言档案判（Java/Python 也重跑，并把档案传给 runTests）；`public/app.js` 同一套归属口径；`sim.mjs` 离线模板按业务名出文件（Java 类名=文件名，CJK 标识符已实测可编译可运行） | 单测 49 + 离线 e2e 110 + UI 检查 165，FAIL=0；e2e 实测 `src/api/接口层.mjs`、同层 M1/M5 → `基础工具.mjs`/`质量与交付.mjs` 不重名、Java `src/main/java/core/基础工具.java` + `基础工具Test.java` javac/java PASS=4 退出码 0 |
| 2026-10-09 | **模块开发规则：不再按模块建文件夹**（技能 + 平台一起改，规则要能被验证）：新增预设技能 `skills/dev-code-layout.md`（stage=development，共 30 条）；`exec.mjs` 的 PROFILES `modDir(layer)` 去掉模块 slug → 源码直落层目录（`src/<层>`、`src/main/java/<层>`），`testPath(layer, M<NN>)` 按模块号命名（连带修掉 capNode `testPath` 里引用已不存在函数 `mod_slug` 的隐患）；`agent.mjs` 的 `modDirOf/testPathOf/defaultFiles` 与提示词（ARC-01 规约、langSpec files 规则、模块 user prompt、JSON 示例）全部改口径，模块身份写进文件名 `M<NN>Xxx`；`sim.mjs` 离线模板 Node 产物 `index.mjs` → `M<NN>Core.mjs`（否则同层两模块同名互相覆盖）；`harness.mjs` 文件归属改按文件名模块号（`modNoOf`，兼容旧 `m<NN>-` 目录），规约偏差检查升级为「必须直落层目录 + 文件名带模块号」；`public/app.js` 的 `moduleOfFile` 同一套口径重写（否则界面认不出归属模块 → 批准后仍显示编辑按钮） | 单测 49 + 离线 e2e 110 + UI 检查 165，FAIL=0 |
| 2026-10-09 | **产物页清单列加宽**：`codeGrid(pane,{…,wideLeft})` 新增开关（只在产物页传 `true`），网格类加 `g-wideleft` → `grid-template-columns: 380px minmax(0,1fr) 320px`（原来 300/1fr/320；≤1560px 300/1fr/250）。源码页沿用原宽度，不受影响。UI 检查 [8.16] +1（断言 class 含 `g-wideleft` 且清单 ≥370px 且比 Meta 宽） | 单测 49 + 离线 e2e 104 + UI 检查 165，FAIL=0；实测清单 380px / 正文 706px / Meta 320px；截图 out/53-artifacts-wide-list.png |
| 2026-10-09 | **重新构建（每个项目一个按钮）**：`POST /api/projects/:id/rebuild` + `harness.mjs#rebuildProject()` + `exec.mjs#clearWorkspace(id,{keep:['inputs']})` —— 清掉全部阶段产物 / 阶段状态与轮次 / WBS / 架构规约 / 模块（含源码·单测）/ 事件流 / `workspace/<id>/` 下除 `inputs/` 外的生成目录；保留技能库、输入资料、技术栈与模型配置；清完写一条 `kind='rebuild'` 记账事件（所以事件流恰好剩 1 条）。项目在跑时未 force → 409（同删除项目口径）；**迟到的结果不落地**：`runStage`/`runModule` 在每个 await 后检查 `stale()`（阶段 `attempts` 归零 / 模块不在 `modules[]`）直接 return。UI：项目卡 `♻ 重新构建`（`.btn.warn` 琥珀）+ 中文确认文案（讲清清什么/留什么），i18n 三语。测试：单测 +1（含 409 与迟到结果两条断言）、e2e `[7]` +8、UI `[8.11]` +4 | 单测 49 + 离线 e2e 104 + UI 检查 163，FAIL=0；截图 out/52-rebuild-button.png |
| 2026-10-09 | **项目卡排版**：不再显示项目概要（`.brief` 删掉），**项目名移到概要那一行**（`.pname`，整行宽度、600/15.5px，比统计行 11px 大）；概要只留在名字的悬停 `title`；项目 ID 从标题行挪到统计行开头（`.pid`，窄屏隐藏），标题行只剩模式标签 + 重新构建 + 删除，不再被挤成两行。UI 检查 [8.11] +5 | 单测 49 + 离线 e2e 104 + UI 检查 163，FAIL=0 |
| 2026-10-09 | **技能列表按流程序号排序**：`public/app.js` 的 skills 视图不再用插入顺序，改成 `[...p.skills].sort(stageOrder → 技能编号)`（「所有阶段」（空）排最前，其余按 `p.stages` 顺序；`skillStageOrder()` 复用；不改动 `p.skills` 本身，编辑/删除按 id 查不受影响）。UI 检查 [8.13] 加断言：导入全部后列表里 `[data-skill-stage]` 的顺序对阶段序号单调不降 → 实测 `所有阶段 → requirements×3 → ux×3 → architecture…` | 单测 48 + 离线 e2e 96 + UI 检查 148，FAIL=0；活项目截图 out/48-skills-sorted.png（SK-21 所有阶段 → 01 需求分析 ×3 → 02 UI/UX ×3 → 03 架构设计 …） |
| 2026-10-09 | **技能页列表排版**：技能名与流程节点**上下叠在同一列**（新 `.row .nmcol`：flex 列 + 3px 间距，节点用 mono 小字并带流程序号 `03 架构设计`），行高 34 → 49px；`public/app.css` 一条规则 + `public/app.js` 行结构改 `id / nmcol(名+节点) / 操作`。UI 检查 [8.12] 加两条：左缘差 <4px 且节点在名字下方（真的同列上下）、节点文案带序号；顺手修 [8.12] 末尾「删除后列表消失」的断言竞态（服务端已删但 DOM 还没重渲染，改成 waitFor） | 单测 48 + 离线 e2e 96 + UI 检查 147，FAIL=0；截图 out/47-skills-stacked.png |
| 2026-10-09 | **产物落盘目录规则**：`docs/<原阶段id>/X.md` → **`docs/<两位流程序号>-<流程名>/X.md`**（`docs/01-需求分析/REQ-01.md`、`docs/03-架构设计/ARC-01.md`、`docs/07-部署/DPL-02.md`；模块产物 `M*-CODE` 归到 `docs/05-模块开发/`）。目录名用服务端中文阶段名（磁盘路径不跟界面语言走），名字里的 `/` 折成 `-`（`02-UI-UX 设计`）。`harness.mjs` 新增 `docDirOf()/docPathOf()`，阶段产物落盘与「人工编辑产物重写文件」走同一条规则。**只对新写入生效**：老工作区里 `docs/<阶段id>/` 的旧目录保留不迁 | 单测 48（+1 目录规则）+ 离线 e2e 96（路径断言改新规则）+ UI 检查 145（[2] 工作区树里 docs 目录名匹配 `^\d{2}-`），FAIL=0 |
| 2026-10-09 | **流程名/产物名的显示口径**：① 8 个阶段名接进 i18n（`stage.<id>` 三语，中/英/日），界面按阶段 id 翻译、缺词条回落服务端中文名；② 流程名统一带两位序号（`01 需求分析` … `08 运维`，序号跟流水线顺序）：阶段详情标题、门禁提示、项目卡/KPI 当前阶段、产物归属列、技能页适用阶段都加上；③ 产物名显示成 `序号-流程点名-生成的名字`（`01-需求分析-需求规格说明书`、`05-模块开发-基础框架 · 代码与单测`），前缀跟语言/流水线走、生成的名字不翻译。**只改显示**：产物 id、阶段 id、落盘文件名与提示词一律不动。新增 `test/i18n.test.mjs`（三语齐全 + 8 个阶段名齐备不重复 + 与服务端 STAGES id 对齐）；`public/app.js` 抽 `stageLabel/stageNo/stageLabelN/artOwnerLabel/artFullName` 一套 helper，顺手修掉技能页里同名局部 helper 的遮蔽 bug | 单测 47（+3 i18n）+ 离线 e2e 96 + UI 检查 142（[8.16] 产物顺序、[8.17] 序号 + 中英日切换），FAIL=0 |
| 2026-10-09 | **源码页空白 / 产物乱序两处显示问题**：① 「源码」页在**工作区还空着时**打开过后就再也不刷新（缓存只按 `projectId` 失效，「模块后来才落盘」就一直显示空列表，得手动刷新页面）→ 失效条件抽成 `wsStale(p)`：换项目 / **模块文件数变化** / 上次加载卡住 > 5s；`refreshWorkspace` 补竞态保护（切项目/重入时丢弃旧结果）与失败重试（`modCount=-1`）；`public/tree.mjs` 的源码扩展名补 `.cds`（CAP 的 db/schema.cds、srv/*.cds 现在算源码，实测 115 → 118 个）。② 产物列表原来按生成先后排，WBS 与模块产物被甩到最后 → 改成「**阶段顺序 → 编号数字**」排序（`sort` 稳定，同阶段同编号保持生成顺序 REQ → US → AC）：实测 REQ-01 → US-01 → AC-01 → UX-01 → UX-02 → ARC-01 → ARC-02 → ARC-03 → … → M1-CODE… | 单测 44（tree.test 加 `.java`/`.cds` 判定）+ 离线 e2e 96 + UI 检查 135（新增 [8.15] 同一次导航内源码页自动补文件、[8.16] 产物顺序单调 + REQ-01 第一），FAIL=0；活项目实测：源码页 118 个文件（含 db/schema.cds） |
| 2026-10-09 | **多语言执行：技术栈决定产出与真跑方式（修「技术方案写 Java/CAP，产物却是 .mjs」）**：新增**语言档案** `profileOf(stack)` → node / java / cap-java / cap-node / python，路径规约与运行器都跟着档案走。`exec.mjs`：`runJava`（`javac -d .build <所有 .java>` → `java -cp .build <测试类>`，测试类按 `check(name,ok)`+`tests/pass/fail` 三行+非 0 退出约定解析）、`runPython`（`python3 <测试文件>`，解析 unittest 的 `Ran N tests`/`OK`/`FAILED(...)`）、`runWorkspaceTests`（集成/部署阶段把工作区里各语言产物都真跑）、`checkCds`（结构性校验）、`checkSyntax` 扩到 `.py`；`findJava` 先真跑 `javac -version` 验证候选（macOS `/usr/bin/javac` 是「没装 JDK」的桩，光看可执行位会被骗）→ 命中 `/opt/homebrew/opt/openjdk@21`。缺工具链 → 模块明确失败（绝不静默退回 Node）。`agent.mjs`：按档案生成语言规约提示词（Java：无 package、类名 `M<NN>xxx`、只用 JDK 标准库、测试类约定；Python：stdlib unittest、ASCII snake_case；CAP 追加 CDS 强制条款），模块预算 Java 提到 24000 tokens + 「缺 test 字段就补一次」重试（实测救回一个 9 文件模块）。`harness.mjs`：模块目录/测试路径由档案决定、语言档案写进 arch 与模块产物、模块事件流打印 CDS 校验结论。`sim.mjs`：ARC-01 声明的 stack 跟着项目技术栈走（离线通道不再自说自话声明 Node）；离线模板也按档案产 Java/Python/CDS。UI：模块开发卡片头与模块详情显示**语言档案**。迁移：`tools/migrate_stack.mjs`（`--apply/--clean`） | 单测 44（新增 `test/exec.test.mjs` 8 条：栈识别、**真 javac 编译+执行**、真 python3 unittest、混合语言工作区、缺 JDK 明确失败、CDS 校验）+ 离线 e2e 96（新增 [8] 12 条，真起服务 + 真 javac）+ UI 检查 129，FAIL=0 |
| 2026-10-09 | **用真实模型把三个「栈与产物不符」的项目重做**：`migrate_stack.mjs --apply --clean` 规约 3 个项目（SAP CAP Java ×2、Java Spring Boot ×1）→ 模块退回待开发、旧 .mjs 清理；随后用 DeepSeek 实跑。「开发一个订单管理的sap cap（java版本）」6/6 模块全批准，全部 .java 真编译执行：53/60/31/51/45/80 断言、退出码全 0，并产出真实 CDS（`db/schema.cds` + `srv/order-service.cds`、`srv/pricing-service.cds`、`srv/m6-external-service.cds`，实体带 key、含 Composition 与 action/function）；「受注管理システム」5/5 模块 Java 通过（M3 首次因模型漏 test 字段失败 → 重试后 12 文件 53/53 通过）。截图 out/41-java-project.png | 实测记录见上；磁盘备份 `data/projects.json.bak-*` |
| 2026-10-08 | **技能页列表瘦身**：左侧条目去掉正文简介（正文只留悬停 `title` + 右侧表单），列表列宽改成固定 `minmax(300px,400px)`（≤1560px 用 `minmax(240px,320px)`），右栏吃剩余宽度。UI 检查 [8.14] 重写：列表里没有非条目块、左栏 ≤420px 且右栏 > 2×左栏、每行 title 带正文、窄屏单栏；[8.12] 加「列表里不再铺正文 + title 有全文」两条 | 单测 36 + 离线 e2e 84 + UI 检查 127（列表 400px / 右栏 1020px，29 行 0 个块外元素），FAIL=0；截图 out/40-skills-narrow-list.png |
| 2026-10-08 | **技能页按钮**：「保存技能 / 取消」从撑满整行改成并排、按文字宽度（外面包一层 `display:flex;gap:8px;flex:0 0 auto`，去掉写死的 padding）。UI 检查 [8.12] 加断言：两按钮同一行、各自 <160px、合计不超过表单宽一半 | 单测 36 + 离线 e2e 84 + UI 检查 127（保存 68px + 取消 45px，表单宽 892px），FAIL=0；截图 out/39-skills-buttons.png |
| 2026-10-08 | **技能页排版**：左右两栏从 `1fr / 340px` 调成 `1.7fr / 1fr`（新类 `.g-skills`，窄屏 1.4fr/1fr，≤1120 仍折单栏），右侧表单与预设库不再挤；列表简介按 200 字截断（超出以 … 收尾，`title` 保留全文）。UI 检查加 [8.14]：简介长度 ≤200、截断有省略号、title 是全量、列宽比与窄屏单栏 | 单测 36 + 离线 e2e 84 + UI 检查 126，FAIL=0；截图 out/37-skills-ratio.png |
| 2026-10-08 | **每个阶段的专业技能（29 条预设技能文件）**：在原有 13 条基础上补到每阶段 2–4 条：需求 +非功能指标化 +访谈与冲突裁决；UX +可用性检查表 +可访问性与文案；架构 +数据与一致性 +安全设计；WBS +估算与依赖；开发 +评审清单；测试 +用例设计方法 +性能与安全测试；部署 +配置与密钥 +流水线与灰度；运维 +故障响应与复盘 +备份与恢复演练 +成本与容量；新增跨阶段 `security-通用安全底线`。配套改：技能条数上限 30 → 60；`importSkills` 到顶不再抛错，超出记 `dropped` 并写进事件；`skillsBrief` 加 12000 字符注入预算（超出截断 + 片段里说明「另有 N 条未注入」） | 单测 36（+1 条预算截断；上限/目录/导入三条扩写）+ 离线 e2e 84 + UI 检查 121，FAIL=0；实盘：给「受注管理システム」一键导入 29 条（added 23 / skipped 6 / total 31） |
| 2026-10-08 | **预设技能库（skills/*.md 13 个技能文件 + 一键导入）**：每个阶段一条通用规范（需求/UX/架构/WBS/开发/测试/部署/运维），开发阶段另有 5 条技术栈专属：`dev-java-springboot`、`dev-java-struts`、`dev-nodejs`、`dev-sap-cap-rap`、`dev-python`；文件用 front matter（name/stage/tech）+ 正文，`harness.skillCatalog()` 解析、`importSkills()` 按「同名+同阶段」幂等导入（一条汇总事件）；`GET /api/skills/catalog` + `POST /api/projects/:id/skills/import`；界面加「预设技能库」筛选下拉（全部/各阶段/各技术栈）+「导入选中范围」。栈规范文件开头都写明「平台可执行产物是零依赖 Node ESM，本技能约束命名/分层/接口与验收口径」，避免与模块代码硬性要求打架 | 单测 35（+2：目录解析与各栈文件齐备、导入幂等且真进提示词）+ 离线 e2e 84（+[2e] 8 条）+ UI 检查 121（+[8.13] 7 条），FAIL=0 |
| 2026-10-07 | **技能库功能模块（每个阶段可挂自己的 skill 文档）**：`project.skills[]`（`name / body / stage`，stage 空=所有阶段，未知 id 归空，名字≤60/正文≤4000/≤30 条）；`harness.mjs` 增删改（含事件留痕、老数据无该字段自动补）；`agent.mjs` 的 `skillsBrief(project, stageId)` 注入三条路径（阶段交付物按本阶段过滤、WBS 用 `wbs`、模块代码用 `development`），空库不产生多余提示词；REST `POST/PUT/DELETE /api/projects/:id/skills`；侧栏新增「工程约定 → 07 技能」视图（列表带适用阶段 + 草稿式表单，SSE 刷新不吞输入） | 单测 33（新增 4 条：增删改查/上限/阶段作用域/「阶段专属只进对应阶段」+ 假模型服务断言请求体真带上）+ 离线 e2e 76（新增 [2d] 9 条）+ UI 检查 114（新增 [8.12] 12 条） |
| 2026-10-08 | **修 SSE 连接泄漏（「点保存没反应」的真因）**：`server.mjs` 只监听 `req.close` 就收摊——页面刷新/导航后连接可能半开，keep-alive 还往死 socket 写；`clients` 越攒越多，**浏览器同源并发（HTTP/1.1 默认 6 条）被这些流占满后，页面自己发的 fetch（保存技能、改模型）会一直排队，永远拿不到响应**。修法：`req/res` 的 close+error 都收摊、心跳发现 `writableEnded/destroyed` 就断、并发流上限 12（超出 503）；前端 `pagehide` 主动 `es.close()`。证据：修前 UI 检查里 `fetch /api/projects/…/skills` 永不返回（Node 同时刻直发同一接口 200），修后同一路径 200 且 [8.12] 全绿 | 单测 33 + 离线 e2e 76 + UI 检查 114，FAIL=0 |
| 2026-10-07 | **修 8192 截断（真实模型跑不动模块的硬 bug）**：`MAX_OUT` 8192 → 65536（实测本通道 `max_tokens=40000` 能吐到 `stop`、27155 tokens；131072 也不被拒，8192 是平台自己写死的），截断重试从「翻倍」改成「直接给满上限」；`test/agent.test.mjs` 假服务按序列回 `finish_reason`，断言「先 length 再 stop → 重试用 65536」「两次都 length → 明确失败」 | 单测 28 + 离线 e2e 64 + UI 检查 97，FAIL=0；真实项目「开发一个订单管理的sap的 cap」6 模块重跑：M1 9/9 · M2 16/16（20003 tokens 输出）· M4 13/13 · M5 12/12 · M6 12/12 rc=0，M3 10/11 rc=1（模型自写测试真挂，门禁按设计拦住） |
| 2026-10-07 | **任务树页签 + 项目页也吃满窗口**：任务树原来是一张裸卡（不跟窗口走），包成单卡 fill 网格 `<div class="grid g-fill">` 即复用同一套规则；窄屏给单卡例外 `.grid.g-fill:has(> .card:only-child){flex:1 1 auto;min-height:340px}`（多卡堆叠才需要 58vh 限高）。项目页（项目列表 + 新建表单）同样加 `g-fill`。UI 检查 [8.10] 扩到任务树（1000/1400/窄屏）、新增 [8.11] 项目页四组断言；`tools/shot.mjs` 加任务树截图项 | 单测 27 + 离线 e2e 64 + UI 检查 97，FAIL=0 |
| 2026-10-07 | **流程与门禁 / 开发页签也吃满窗口**：`.grid.g-1-2`（阶段详情 + 阶段交付物）与 `devSection` 的 `.grid.g-side`（模块开发 + 模块详情）都加 `g-fill`，复用总览那套规则。流程页选到「开发」时上层网格不套 `g-fill`（模块开发区块要跟在下面，整页滚），改由模块开发区块自己吃剩余高度。UI 检查加 [8.9]（流程：需求分析 1000/1400 吃满 + 两卡 self-scroll；开发阶段上层不 fill 而 dev 块 fill；窄屏 58vh）与 [8.10]（开发页签同四组断言） | 单测 27 + 离线 e2e 64 + UI 检查 88，FAIL=0 |
| 2026-10-07 | **总览页吃满窗口高度**：「阶段流水线」+「活动流」的网格加 `g-fill`，与源码/产物页共用同一套规则（`.grid:is(.g-tree, .g-fill)`：网格 `flex:1 1 auto; min-height:340px`、卡片 flex 列、卡片体 `overflow:auto`）——页面本身不滚，两张卡各自占满并按内容出滚动条；活动流条目 14 → 60 条（卡片变高后原来填不满）。顺手修窄屏漏网：`body.tablewrap` 的 `max-height:none` 特异性高于媒体查询，单栏时带 tablewrap 的卡片体（总览活动流、源码目录树）不会被 58vh 限高 → 媒体查询里补上 `.body.tablewrap` 选择器 | 单测 27 + 离线 e2e 64 + UI 检查 77（新增 [8.8]：1680×1000 页面不滚/网格底 960 只留 40px 内边距/两卡 auto 且高 684·697；1680×1400 卡片跟着长 732→1132；1000×800 单栏限高 58vh + 整页滚），FAIL=0 |
| 2026-10-07 | **侧栏「产物 / 源码」互换**：`public/index.html` 里两行按钮对调（04 产物 → 05 源码）；数字快捷键改为按**菜单位置**取（`[...document.querySelectorAll('#nav .navbtn')].map(b => b.dataset.view)`，原来读 `Object.keys(VIEWS)` 的书写顺序，会跟菜单脱钩）；UI 检查加 [8.7]：断言 04/05 = 产物/源码 + 按 5/6 真进这两项 | 单测 27 + 离线 e2e 64 + UI 检查 71，FAIL=0 |
| 2026-10-07 | **两栏滚动条真的看得见**：`overflow:auto` 在 macOS 是覆盖式滚动条（不滚动不显示），用户看不出「还能往下翻」。`public/app.css` 加占位式细滚动条：`::-webkit-scrollbar` 10px + `--line-2` 滑块（hover 变 `--accent`）+ `scrollbar-width/color` 给 Firefox，并用 `@supports selector(::-webkit-scrollbar)` 在 Chromium 里把标准属性让回 `auto`（否则 Chromium 走覆盖式，反而看不见）；两栏 `scrollbar-gutter: stable`。UI 检查 [7] 加两条断言：两栏 `offsetWidth-clientWidth ≥ 8`（占位＝可见）、加滚动条后不横向溢出 | 单测 27 + 离线 e2e 64 + UI 检查 68，FAIL=0 |
| 2026-10-07 | **缺省模型改为 `deepseek-v4-flash`**（原 `deepseek-chat`）：`agent.mjs` 回落值、界面下拉选项与「缺省（…）」文案默认值、`test/agent.test.mjs`（断言真发出去的 model 名）、`test/harness.test.mjs`、e2e [2c] 的 `/api/state.default_model` 断言同步；UI 检查 [8.5] 新增「缺省文案里的模型名 = `/api/state.default_model`」与「下拉里有该模型可选」两条断言 | 单测 27 + 离线 e2e 64 + UI 检查 66 + 真实模型 e2e 33（269s，通道 = deepseek-v4-flash，WBS 按定义走 deepseek-reasoner），FAIL=0 |
| 2026-10-10 | **流程点撑满界面宽度 + 每个流程点一个居中图标**（流程与门禁 / 总览共用 `pipe()`）：`.pipe-node` 从固定 `width:104px` 改成 `flex:1 1 0; min-width:96px`（窄屏 84px）—— 8 个阶段点在一条行内等分撑满可用宽度，放不下才在卡片内横向滚动；节点内容居中（`text-align:center` + `.meta` 居中）。新增内联线性 SVG 图标表 `public/app.js` 的 `STAGE_ICO`（8 个阶段各一个，`stroke: currentColor`、选中态琥珀、零依赖不用 emoji/图标字体），渲染在序号与名称之间、水平居中 | 单测 51 + 离线 e2e 110 + UI 检查 **180**（新增 [8.19] 4 条：等宽撑满 / 不溢出不留空 / 8 图标居中 / 窄屏不压扁），FAIL=0；截图 `out/57-flow-rail.png` |
| 2026-10-10 | **流程点图标放大 + 页头备注一行显示**：`.pipe-node .ico svg` 20px → 28px（间距 8/4px），UI 检查 [8.19] 的图标宽度下限跟着提到 26px；`.page-head p` 去掉 `max-width: 78ch` —— 「流程与门禁」下那行中文备注不再被折成两行（窄屏仍由容器宽度自然折行，`overflow-wrap: anywhere` 兜长词） | 单测 51 + 离线 e2e 110 + UI 检查 **182**（新增 [8.20] 2 条：备注 1 行 / 不横向溢出），FAIL=0；截图 `out/02-flow.png` 重拍 |
| 2026-10-10 | **WBS 页签：图标在上文字在下 + 两页签等宽 + 模块开发两栏 4:6**：页签图标复用流程点的 `ICO()`（任务树 = 层级树，模块开发 = 代码括号），`.tab:has(.tico)` 竖排；`.tabs-eq` 用 `display:grid; grid-template-columns:1fr 1fr; width:max-content` 让两枚页签等宽（**`width:max-content` 是关键**：CDP 现场试了 7 种写法，只有它等宽——只写 `1fr 1fr` 时容器宽度不定，fr 退回按内容定宽，实测 59 ≠ 70）；`devSection` 网格加 `g-dev` = `4fr 6fr`（左 模块开发 4 : 右 模块详情 6） | 单测 51 + 离线 e2e 110 + UI 检查 **185**（[8.10] 新增 3 条：4:6 比例 / 图标在上 / 两页签等宽且不折行），FAIL=0；zh/en/ja 三语实测等宽（70=70 / 135=135 / 105=105）；截图 out/03-wbs-dev.png · 03b-wbs-tree.png 重拍 |
| 2026-10-10 | **每个界面的标题前加图标**：`public/app.js` 新增 `VIEW_ICO`（8 个界面各一枚，复用流程点那套 `ICO()`：项目=文件夹、总览=四宫格、流程=分支、WBS=层级树、产物=文档、源码=文档+箭头、执行记录=脉冲、技能=书）+ `viewTitle(id, text)` 统一产出 `<h1><span class="tico">svg</span>标题</h1>`，10 处 `h1` 全改用它（含无项目时的「项目入口」）；`.page-head h1` 改 `display:flex; gap:8px`，图标 18px / `--muted`。加界面只需在 `VIEW_ICO` 加一条 | 单测 51 + 离线 e2e 110 + UI 检查 **186**（新增 [8.21]：8 个界面标题都是 18px 图标开头），FAIL=0；截图全套重拍 |
| 2026-10-11 | **编辑项目挪到右侧那一栏 + 字段与「新建项目」完全一致，软件分类/工作流只读**（用户：编辑项目也在右侧区域不是弹出窗口；编辑和新建项目的内容一样；编辑界面，软件分类和工作流不能选择）：`public/app.js` 的 `editCard` 从卡片内嵌表单改成**占右侧那一栏**（PEDIT 非空时替换「新建项目」卡；项目卡保持原样、可继续点）；编辑表单字段/顺序补齐成 名称 → 概要 → 软件分类 → 技术栈（带该分类建议的 datalist）→ 工作流 → 执行模式，其中**分类与工作流 `disabled`**、下面写明原因（要换就新建项目或 ♻ 重新构建）；`harness.mjs` 的 `updateProject` 只收名称/技术栈/需求/入口模式（传 `type`/`workflow` 忽略），并把建阶段表的代码抽成 `buildStages()` 给新建复用；新建表单的分类/流程选择存进 `NPTYPE`/`NPWF`，SSE 重渲染不再把用户选的分类冲回默认 | 单测 **58**（「项目信息编辑不进分类/工作流：接口忽略它们，阶段不变」）+ 离线 e2e **132**（`[2g]` 断言编辑接口传分类/流程也不动）+ UI 检查 **228**（`[8.24]` 新增：右栏换表单 / 字段与标签和新建一致 / 分类工作流 disabled / 锁定原因在字段下），连跑两次 FAIL=0 |
| 2026-10-11 | **阶段瞬时故障不再吃掉重试额度 + 流程节点右上角「不同的机器人」图标**（用户：需求分析 执行失败：fetch failed；在流程节点上增加一个 robot icon 在右上角 → icon 尺寸加大、针对不同流程点显示不同 icon、真彩色 → 用不同的机器人图标）：① 把模块侧那套瞬时故障处理抽成 `transientBounce(p, x, stageId, label, msg)`（`isTransientModelError` 命中「空响应/超时/429/5xx/连接重置/fetch failed」→ 原地重排、`attempts` 回退、最多 2 次；真故障如 Key 错照旧算进 3 轮），**阶段与模块共用**——原来只有模块用了它，阶段遇到 `fetch failed` 会白白吃掉一轮并停在失败（用户就是这么撞上的）；② `rejectModule` 允许**撤回已批准模块**（`attempts` 归零、事件写明「已批准 → 撤回」）——批准之后发现它把同层别的模块写坏时，人得有办法送回重做；③ `reverifyApprovedModules(p, changed)`：一个模块跑完后复核其它**已批准**模块的用例（ms 级），谁的用例被同层重写搞挂了就打回 `failed` 并带上真实错误 → 重试循环接着修（「批准 = 对当前代码树成立」）；④ 流程点右上角每阶段一枚**不同的机器人**图标：头型（方/圆）、天线（单/双/圆环/三叉/耳）、眼型（双点/三点/方眼/眼罩/独眼/脉搏）、手臂各不相同 + 各自真彩色（需求蓝 #2563EB / UX 紫 #A855F7 / 架构青 #0891B2 / WBS 琥珀 #F59E0B / 开发绿 #16A34A / 测试红 #DC2626 / 部署靛蓝 #6366F1 / 运维青绿 #0D9488），20px 贴右上角，`title` 写「<Agent 名> 执行」；纯内联 SVG，零依赖 | 单测 **66**（瞬时故障测试扩写：阶段也走 `transientBounce`、attempts 回退、Key 错不许重试；新增「已批准模块可以撤回重做」；新增「跨模块复核：同层被重写后已批准模块被打回」）+ UI 检查 **256**（`[8.19]` 新增 4 条：8 个节点都有 20px 机器人 / 8 种不同图形 / 8 种不同颜色 / 贴右上角且 title 有 Agent 名），`bash tools/run_all.sh` 连跑两次 FAIL=0；**实盘**：活项目「sap sd的培训网站」需求阶段那次 `fetch failed` 之后再无卡死，7 阶段 + 6 模块全部 approved（跑完） |
| 2026-10-11 | **生成项目工作区自带的技能优先（并写入通用规则）**（用户：如果生成项目下定义了技能，则优先使用该技能，写入通用规则）：新增第二类技能来源——**生成项目自己的工作区**里的 `workspace/<项目id>/skills/<name>/SKILL.md`（同一套 AI Agent Skills 标准格式，平台预设/工作区技能共用新抽出的 `parseSkill()` 解析）。`harness.mjs` 新增 `workspaceSkills(p)` 与 `refreshWsSkills(p)`，在**每次要调模型前**（`runStage`、`runModule`）按磁盘刷新（**不落库、不拷贝**，改文件即生效；集合变化写进事件流「本项目工作区自带 N 条技能… → 优先于项目技能库与平台预设」）。`agent.mjs` 的 `skillsBrief()` 改成三级优先：**工作区自带技能 > 项目技能库 > 平台通用默认** —— 工作区技能排在注入最前（预算是按顺序截断的，所以绝不会先被丢）、每条带标记「（本项目工作区自带 · 优先）」、片段抬头写明这条优先级（写进通用规则）；`stage` 过滤照旧生效。README「技能」节 + 技能页脚注（三语 `skill.footNote`）同步 | 单测 **64**（新增「生成项目工作区自带的技能（skills/<name>/SKILL.md）优先注入…」：按磁盘读到、显示名取 `metadata.label`、事件记账、注入顺序在项目技能库之前、优先级整句在提示词里、阶段过滤生效、工作区没有技能时不产生多余提示词且不虚报；`test/agent.test.mjs` 的优先级断言改成新的三级句）+ 既有断言全绿；`bash tools/run_all.sh` 连跑两次 FAIL=0；活服务实盘：新建项目里放一条工作区技能 → 重跑阶段 → 事件流出现「本项目工作区自带 1 条技能…」 |
| 2026-10-11 | **修「真实执行 node --test … FAIL=1 不成功」——模块门禁不通过要能自愈**（用户：真实执行 test/core/基础框架层.test.mjs → pass=6 fail=1，不成功请解决）：查出现场是 4 个模块卡在「单测没过却标注等待批准」，**根因链**修掉五处——① `runModule` 不看测试结果一律置 `awaiting_review` → 重试循环（只捞 `failed`）看不见、人也没法批 → 改成「门禁达标才 waiting，否则 `failed` + 记录真实失败用例」；② 重试只喂人工驳回意见、不喂真实测试输出 → `lastFeedback` 加「上一轮真跑输出末尾 1200 字符 + 必须修到 FAIL=0」的反馈；③ 模型空响应/超时/429/5xx 也吃掉 1/3 重试额度 → 新增 `isTransientModelError()` 原地重排并回退 `attempts`（≤2 次）；④ `node --test` 的孙进程攥着管道导致 `close` 永不触发 → `exec.run()` 改 `detached` 起进程组、超时**杀整组并立刻 resolve**（默认 120s，`AI_PLATFORM_TEST_TIMEOUT_MS` 可调），`timed_out` 如实上报；⑤ 启动时对「可重试的失败模块」自动接手（不用人点），并把老逻辑遗留的「单测没过却等待批准」在 `load()` 里归位；另加 `server.mjs` **单实例锁**（`projects.json.lock` 记 PID，第二个实例启动即退）——实测两个 server 同时在线互相 flush，把已批准模块写回了失败快照 | 单测 **63**（新增 3 条：模块单测没过→失败→自动重试→重试后真过、瞬时故障判定正反例、挂住的测试 1.5s 硬超时且如实报超时不算通过）+ 既有断言全绿；`bash tools/run_all.sh` 连跑两次 FAIL=0；**实盘**：活项目 P-mv3t108m-z42q 的 4 个失败模块（M1/M2/M3/M6）经真实模型重试（把真实失败输出喂回）全部通过 → 6 个模块全 approved、开发阶段闭合进入集成测试；用户报的那条命令现在 `pass 5 / fail 0` ✓ |
| 2026-10-11 | **本地技能改成 AI Agent Skills 标准格式**（用户：把当前项目的 skill 按照 ai skill 的标准格式重新设计）：33 个本地技能从 `skills/<id>.md` 单文件改成 `skills/<id>/SKILL.md`（目录名 = frontmatter `name`，小写连字符，符合 agentskills.io 规范，与 `vendor/agent-skills` 同一套）；frontmatter 顶层只留规范允许的 `name`（做什么+何时用的 `description`，≤1024 字符），平台扩展（`stage` / `tech` / `label` 显示名）挪进 `metadata:`；正文按规范推荐顺序固定六节：**Overview / When to Use / Core Process / Common Rationalizations（借口\|事实 表）/ Red Flags / Verification（复选框 + 可验证证据）**。`harness.mjs` 的 `skillCatalog()` 改成扫目录 + 读 `metadata` 块（新增 `metaValue()` 与 `SKILL_SECTIONS`），catalog 条目多一个 `desc` 字段（技能页预设下拉用它做 option 的 title）；**id 一个都没变** → `TYPES[].skills`、分类包、导入接口、界面标签、既有测试全不用改。要挂新技能：建目录照六节写，零代码改动。内容守恒：Core Process 逐条保留原规则的命令/数字/代码跨度/跨技能引用，原来没有的三段（反合理化/红线/验收）按原文事实补出来。**目录名/name 也按规范改成 ASCII lowercase-hyphen**（25 个中文目录名 → `architecture-security-design` / `env-bootstrap` / `wbs-estimate-and-dependencies` …；中文名留在 `metadata.label`，界面与提示词照旧中文）；每段 description 补一句英文 `Use when …`（规范的触发语约定）。**自检直接调上游的参考校验器** `vendor/agent-skills/scripts/lib/skill-lint.js`（单测里 `createRequire` 加载，`vendor/agent-skills/package.json` 显式 `{"type":"commonjs"}` 免得被本项目的 type:module 当 ESM 解析）→ **33 个技能 0 error / 0 warning**（含交叉引用警告；顺手把 `dev-java-springboot` 里 `→ \`service\`` 那种会被误判成技能引用的箭头改成顿号）。**连带改动**：技能正文均值 ~1.0 → ~1.7KB，单次注入预算 `agent.mjs SKILL_PROMPT_MAX` **12000 → 18000 字符**（≈6k tokens；实测分类整包导入后开发阶段 14,664 字符 / 8 条，不再截断）| 单测 **60**（新增「预设技能：AI Agent Skills 标准格式…」：33 个目录、目录名 ASCII kebab、`name` 必须等于目录名、顶层只许三键、description 20–1024 且中英触发语齐、metadata 三字段齐、六节顺序与内容、反合理化是表格、验收是复选框、≤500 行、每条都能被 catalog 解析、**上游校验器 0 error/0 warning**）+ 既有断言全绿（「预设技能库：每个阶段都有技能…」/「导入预设技能…」/「上游技能…」预算检查）；改为并行 10 个子代理改写 33 个技能 + 脚本复核（格式 33/33、内容守恒 33/33：代码跨度与加粗引导零丢失、行数均 ≥0.9×）；e2e 140 与 UI 检查不变；`bash tools/run_all.sh` 连跑两次 FAIL=0；活服务 `/api/skills/catalog` 58 条（33 本地 + 25 上游），stage/tech/label/desc 全部正确带出 |
| 2026-10-11 | **融入上游 agent-skills（vendor + 抽三段，不做原文搬运）**（用户：分析如何把 addyosmani/agent-skills 融入当前工程 → 选方案 C）：`tools/vendor_agent_skills.sh` 一次性 `git clone --depth 1` 到 `vendor/agent-skills/` 并把 commit 写进 `SOURCE`（现 `1be8e341`，MIT，2.1MB），之后全离线；`harness.mjs` 新增 `AGX_MAP`（25 行：上游技能 → 本平台阶段 + 抽取上限，与上游目录一一对应）、`agxSlice()`（只抽 `Verification` / `Red Flags` / `Common Rationalizations` 三段，24/25 都有；按优先级拼到上限即停，缺三段的走各节兜底）、`agxCatalog()`（`id=agx-<上游名>`、`name=上游规范 · <名>`、正文首行写「节选自 addyosmani/agent-skills@<sha8>｜全文 vendor/…」），并进 `skillCatalog()` → 预设技能库 **33 → 58 条**；**导入进项目的是切片拷贝**（≤1400 字符，之后不读 vendor）；五个分类包各挂 1–2 条最对口的（webapp=评审+TDD、website=前端+性能、service=安全+可观测、cli=调试、data=增量+性能）。**关键取舍**：上游单个 SKILL.md 均值 13.7KB > 本平台单次注入预算 12000 字符，且上游流程步骤（逐 task commit / 开 devtools）在本平台的一次性出稿模型里跑不了 → 只取约束段。不做：commands/evals/hooks/各宿主适配目录 | 单测 **59**（新增「上游技能…」：映射表与上游 25 目录一一对应、切片 ≤ 上限且有内容、stage 合法、名字带出处、并进预设库、分类包 id 都在库里、导入的是切片不是原文、整包导入后开发阶段注入 7,307 字符 ≤ 12000 且上游技能没被截掉）+ 离线 e2e 140 + UI 检查；连跑两次 FAIL=0；顺手修两处 UI 检查偶发（侧栏图标注入等 module 落地后读、执行模式说明设值+读回同一次求值） |
| 2026-10-11 | **左侧菜单加图标（图标在序号前面）+ 执行记录时间戳列加宽**（用户：左侧的菜单增加 icon → 左侧菜单的 icon 放到序号的前面；执行记录 事件流的日期宽度增加）：`public/app.js` 新增 `paintNavIcons()`（入口渲染前调一次，幂等）——**复用 `VIEW_ICO`**（和页面标题、快捷键同一枚），塞进每项 `序号` 前面：`图标 / 00 / 菜单名 / 角标`，`.navbtn` 网格 `22px 1fr auto` → `16px 22px 1fr auto`；图标 15px、`--muted`、当前页转 `--accent`；**图标放在 `.ic` 外**（`data-i18n` 换语言时 `textContent` 会把子节点冲掉） | 离线 e2e 140 不变 + UI 检查 **252**（`[8.7]` 新增 2 条：8 项都有 15px 图标、`compareDocumentPosition` 证明图标在序号前面；数字键快捷键断言不变——序号还在）；`[8.27]` 新增 3 条：执行记录时间戳一整行（`.steps-time .s` 首列 64 → 140px + `nowrap`，实测列宽 140px、行数 1） |
| 2026-10-11 | **按分类配置「技能包 + 目录规约」（写入通用配置）**（用户：为每个软件分类配置适合的 skill / 规则库 / 目录结构规则，写入通用配置）：`harness.mjs` 的 `TYPES` 每个分类补两项——**`skills`**（技能包，指向 `skills/*.md` 的预设技能：通用 4 条「通用规范 / 代码目录命名 / 安全底线 / 环境自举」+ 该分类运行时的 `dev-*` + 该分类相关的阶段规则，webapp 8 / website 8 / service 9 / cli 7 / data 8 条）与 **`layers`**（目录规约：webapp `core/domain/service/api/ui`、website `core/content/ui/app`、service `core/domain/api/repo`、cli `core/cli/io`、data `core/io/transform/report`）；`checkTypes()` 加自检（技能必须在预设库里、层清单不重复且层名合法）；新增 `packOf()` 给界面/接口用；**目录规约自动生效**：`typeArch()` 在新建时写入 `p.arch = {layers, from:'type-default'}`（架构阶段提示词直接用这套层清单），`readLayout()` 的回退顺序改成 ARC-01 → 分类自带 → 平台默认，`rebuildProject()` 与「改分类/流程」也回到分类自带的那套（不再是 null/清空）；**技能包一键导入**：技能页新增按钮「⬇ 分类技能包（N）」→ 复用 `POST …/skills/import`（不自动塞给新项目，遵守既有规则「预设库只是模板、显式导入才生效、以项目为准」）；新建/编辑表单的分类提示行写出「分类技能包 N 条（技能页可一键导入）· 目录规约 a / b / c」 | 单测 **58**（类型测试内新增：每类技能包 ≥5 条且都在预设库里、目录规约 ≥3 层不重复、`packOf` 一致、新建即带分类目录规约、技能仍要显式导入；并把「重建/换流程后 arch 作废」改成「回到分类自带的那套」）+ 离线 e2e **140**（`[2g]`：/api/state 每个分类都带 skills/layers、网站分类目录规约 `core,content,ui,app`、重建后 `arch.from==='type-default'`）+ UI 检查 **246**（新增 `[8.13b]`：按钮显示 `（8）`、干净项目点一下真导入 8 条、事件记账、再点幂等；`[8.25]` 提示行写出技能包与目录规约），连跑两次 FAIL=0 |
| 2026-10-11 | **项目卡改版（用户：按钮统一放最下面 / 工作流描述换行 + 执行模式字体增大匹配 / 执行模式图标＋文字上下显示）**：卡片结构改成 卡头（执行模式 + 工作流）→ 名字 → 进度 → 统计 → **按钮行**；`♻ 重新构建`/`✕ 删除` 从卡头挪出来，与 `✎ 编辑` 合成一行 `margin-top:auto` 钉在卡片最下面（等高卡片底边对齐，`getBoundingClientRect` 实测每张卡贴底 ≤15px）；工作流徽标字号 10.5 → 11.5px 且**允许换行**（长流程名不再挤成一行/截断）；执行模式改成**图标在上、文字在下**的方块（`MODE_ICO`：人工审批 = 人形、AI 自动审批 = 机器人头，复用 `ICO()` 线性 SVG，配色沿用 acc/run，20px 图标居中）+ `title` 给全称；表单里的两条长说明（工作流：通用解释 + 当前流程阶段序列；执行模式：两种模式的含义）从下拉框选项里挪到下面那行 `.hint.big`（**12.5px 与正文同字号、会换行**，选完即时更新），顺带修掉「选项文字被下拉框截断」 | 单测 58 不变 + 离线 e2e 138 不变 + UI 检查 **240**（`[8.24]` 新增：按钮全在最下面一行（顶部无按钮 / 同一行 / 每张卡贴底 ≤15px）+ 执行模式图标＋文字上下排（20px 图标居中、与工作流徽标并排）；`[8.25]` 新增：工作流下拉只剩流程名 / 说明换行 ≥2 行且 12.5px / 执行模式说明跟着选择换），连跑两次 FAIL=0；顺手给「源码编辑态」补了一条等待（点了编辑不等文本域出现就写值 → 偶发 FAIL=7） |
| 2026-10-11 | **编辑项目 = 右侧那一栏的「新建项目」等价面板**（用户：编辑项目也在右侧区域不是弹出窗口 → 编辑和新建项目的内容一样 → 软件分类和工作流不能选择 → 编辑项目的软件分类和工作流程可以选择）：最终形态 = 编辑表单**占右侧那一栏**（PEDIT 非空替换「新建项目」卡）、**条目与新建完全一致**（名称 / 概要 / 软件分类 / 技术栈（datalist 建议）/ 工作流 / 执行模式 / 输入资料），且**分类与工作流可选**——改了走 `mergeStages()` 按新流程重排阶段（同 id 保留状态与交付物、多的补 pending、去的移除记录并在事件里列名，`arch` 作废重算），`running` 阶段时 409 拒绝；`harness.mjs` 的 `updateProject` 收 `type`/`workflow`（只给 `type` 按该分类默认流程）、抽出 `freshStage()`/`buildStages()`/`mergeStages()`；新增 `addInputs()` + `POST /api/projects/:id/inputs`（同名覆盖）让编辑里也能补输入资料；`app.js` 把文件读取抽成 `readPicks()` 给两个表单共用、`EPICKS` 存编辑表单的待传文件、新建表单的分类/流程选择存进 `NPTYPE`/`NPWF` 防 SSE 重渲染冲回默认 | 单测 **58**（新增「编辑里改软件分类 / 工作流：按新流程重排阶段…」：只给分类走默认流程 / 保留已批准阶段与产物 / 去掉的阶段移除 / 新补 pending / arch 作废 / 运行中 409 / 幂等 / `addInputs` 落盘+同名覆盖+二进制跳过+400）+ 离线 e2e **138**（`[2f]` 补输入资料往返与落盘读回、`[2g]` 改分类重排 + 保留 5 个已有阶段 + 事件明细）+ UI 检查 **235**（`[8.24]` 右栏换表单 / 条目与标签和新建一致 / 分类工作流可选；新增 `[8.26]` 编辑里换分类 → 工作流跟切 + 建议换 + 真重排 5 阶段 + 事件明细），连跑两次 FAIL=0；截图 `out/60-proj-edit.png`（开着编辑表单拍） |
| 2026-10-11 | **按软件分类给技术栈建议**（用户：根据项目分类，给出技术栈建议）：`TYPES[].tech`（单个示例）→ **`TYPES[].techs`（每类 2–4 条建议）**，`checkTypes()` 加「≥2 条、非空、不重复」自检；`public/app.js` 技术栈输入框换成**原生 `<datalist id="techSug">`**（点/写输入框就出下拉，零依赖、零 JS 库）：初始渲染用第一个分类的建议、切换分类时连同 placeholder 一起换成该分类的（`change` 处理器重建 `<option>`）；技术栈旁边一行 hint 说明「可从建议里挑也可以自己写，技术栈决定按哪套运行时真跑测试」。建议**只落在平台真能跑的四种运行时内**（Node / Java / Python / SAP CAP），不推荐跑不了的栈（比如 Go）——不然选了也只会回落 Node | 单测 **57**（类型测试内新增：每类 2–4 条、不重复、无首尾空格、≤80 字、网站分类头号建议判成 `node` 档案）+ 离线 e2e **131**（`[2g]` 新增 2 条：每类建议 ≥2 条、网站类含 React + Vite）+ UI 检查 **222**（`[8.25]` 新增 4 条：默认分类 3 条建议 / 输入框挂上 datalist / 建议随分类切换（网站类含 Vite 且不含 Next.js）/ 从建议选一条能填进技术栈），FAIL=0 |
| 2026-10-11 | **表单顺序：技术栈挪到软件分类下面**（用户：把技术栈放在分类下面）：`#newProject` 字段顺序改为 名称 → 项目概要 → **软件分类** → **技术栈** → 工作流 → 执行模式 → 输入资料；分类这一项的标签从「项目类型」改成**「软件分类」**（三语，`proj.type`）。理由：分类带出的技术栈示例就紧挨在它下面（`change` 处理器换 placeholder），选完分类一眼能看到「这个分类一般用什么栈」 | UI 检查 **218**（`[8.25]` 新增 2 条：`[name]` DOM 顺序断言「技术栈 = 分类的下一个字段」实测 `name → brief → type → tech → workflow → mode → files`、标签是「软件分类」），FAIL=0；单测 57 不变 |
| 2026-10-11 | **项目类型（新增选项 + 按类型走不同流程）**：`harness.mjs` 新增 `TYPES`（webapp / website / service / cli / data，各带默认流程与技术栈示例）+ `typeOf()` + `checkTypes()` 自检，并补 3 条类型专属流程（`website` 7 阶段不做运维、`service` 7 阶段跳过 UX、`data` 6 阶段跳过 UX·运维）；`createProject` 记 `p.type`、显式 `workflow` 优先、否则用类型的默认流程，创建事件写明类型；`/api/state` 增 `types`；`public/app.js` 新建表单第一项加「项目类型」下拉（选完自动把工作流下拉切到该流程、提示行排出该流程、技术栈 placeholder 换成该类型示例，`change` 委派监听）+ 项目卡统计行前缀显示类型；`proj.edit.note` 与 README 表同步（类型/工作流都不可改） | 单测 **57**（新增「项目类型：每个类型带出自己的默认流程…」：5 个类型逐一建项目断言阶段 = 流程、`checkTypes()`/`checkWorkflows()` 自检、显式工作流优先、未知类型回落、不传类型也照常建）+ 离线 e2e **129**（新增 `[2g]`：/api/state 报 5 类、网站类型 7 阶段、工具类型 5 阶段无 UX、显式工作流优先、事件带类型，跑完清理这三个项目）+ UI 检查 **216**（新增 `[8.25]` 6 条：下拉 5 项 / 选网站→工作流自动切 / 提示行排出 7 步到部署不做运维 / placeholder 换示例 / 建出来的项目 7 阶段 / 卡片标出类型），连跑两次 FAIL=0；截图 out/61-proj-type.png |
| 2026-10-11 | **修 bug：JavaScript 被判成 Java 档案**（用户报「项目没有按技术栈执行」）。根因在 `exec.mjs` 的 `profileOf()`：`/java|spring|struts…/` 会命中 **Java**Script —— 架构阶段声明的 stack 一旦写成「HTML5 + CSS3 + 原生 JavaScript（ES Modules）静态站点」（或技术栈填 `js， html` 再经架构归一），整个项目就按 Java 档案跑：产出 `.java`、`javac` 编译、门禁按退出码判。改成 `/java(?!script)/`（保留 `Java 21` / `java-springboot`，排除 `JavaScript`），cap 分支同修（`SAP CAP + JavaScript` → `cap-node`）。顺手：**能力 1 行修正换来全链路归位**（产 .mjs、`node --test`、目录 `src/<层>/`） | 单测 **56**（`test/exec.test.mjs` 新增 5 条：`js， html` / `原生 JavaScript…静态站点` / `React + Vite + TypeScript` → node；`SAP CAP + JavaScript` → cap-node；`JavaScript 前端 + Java Spring Boot 后端` → java）+ 离线 e2e **122**（`[8]` 新增 6 条：JS 静态站项目驱动到第一个模块 → `arch.profile==='node'`、产出 `src/core/基础工具.mjs`、**一个 .java 都不产**、`node --test` 真跑 PASS=6 FAIL=0），连跑两次 FAIL=0 |
| 2026-10-11 | **项目信息可编辑保存**（建完还能改）：`harness.mjs` 新增 `updateProject(p, {name,tech,brief,mode})`（可只传改动字段、空名 400、超长截断 80/200/20000、四项都没变不写事件）+ `server.mjs` 加 `PUT /api/projects/:id`；`public/app.js` 项目卡右下角「✎ 编辑」→ 卡片**就地变表单**（`PEDIT` 记状态，SSE 重渲染不丢；表单聚焦时只刷页脚不会换掉正在填的内容）+ 保存 / 取消（取消不落库）+ `#editProject` 里的点击不当「点卡片进项目」；i18n `proj.edit.note` 三语 | 单测 **56**（新增「项目信息可以编辑…」：四项都改 / 只传一项不动其余 / 值没变不记事件 / 空名 400 / 超长截断 / 按 id 重取一致）+ 离线 e2e **116**（新增 `[2f]`：PUT 往返 + GET 读回一致 + 事件含改名前后 + 幂等 + 400）+ UI 检查 **210**（新增 `[8.24]` 9 条：卡片带编辑按钮 / 就地变表单并带出当前值 / 卡片让位 / 四项都真落库 / 事件记账 / 卡片名字更新 / 替换回普通卡片 / 再打开带新值 / 取消不落库），连跑两次 FAIL=0；截图 out/60-proj-edit.png |
| 2026-10-11 | **新增预设技能：React + Vite 静态站规范**（`skills/dev-react-vite.md`，stage=development、tech=react-vite，预设技能 32 → 33 条）：平台没有 npm/Vite、`node --check` 不认 JSX → 可执行形态定死为「视图用 `h(type, props, ...children)` 的元素对象（与 `React.createElement` 同构）+ 逻辑用纯函数」；reducer 状态、路由表唯一真源、元素对象层断言 SEO/无障碍、转义与 `dangerouslySetInnerHTML`/`javascript:` 禁忌、组件约定（props 只读 / key 用业务 id / `{count && …}` 的 0 陷阱）、构建与托管（`base` 子路径、`VITE_` 变量、产物公开不许塞密钥）、浏览器行为标明未在平台内真跑 | 单测「预设技能库：每个阶段都有技能文件…」的技术栈断言加 `react-vite`（现 33 条、开发阶段 10 条）；活服务 `/api/skills/catalog` 已能读到（无需重启，skills/ 每次读盘）+ npm test 55 通过 |
| 2026-10-11 | **平台通用规则：项目技能库优先**（写进提示词 + 文档 + 界面说明）：`agent.mjs` 的 `skillsBrief()` 标签加明确优先级——「与本项目无关的平台通用默认冲突时**以本项目的为准**」；模型调用**只注入项目自己的技能库**，预设技能库 `skills/*.md` 只是模板、必须导入才生效（本来就如此，现在把这条写成规则并锁住）；技能页页脚说明（`skill.footNote`，三语）同步写清；README 技能库一节加「优先级（平台的通用规则）」 | 单测 55（`test/agent.test.mjs` 新增断言：请求体里的技能片段必须含「以本项目的为准」——覆盖三条注入路径）+ 离线 e2e 110 + UI 检查 201，FAIL=0 |
| 2026-10-11 | **预设技能下拉改成「按范围 / 按技能」两组**：每条技能的选项文字 = `流程序号_流程名称_技能名`（`stageNo(p,stage)` + `stageLabelById` + 技能名，无阶段的只写 `所有阶段_技能名`），按流程序号排序；选中某条即只导这一条（`id === value`）；原来的「按技术栈」范围项删掉（每栈技能本来就 1 条，现在按名字能直接选到），`stage:` 分支改成显式判断；i18n 补 `sk.cat.byRange` / `sk.cat.bySkill`（三语） | 单测 55 + 离线 e2e 110 + UI 检查 **201**（[8.13] 改：下拉带「全部 / 8 个阶段项」+ 新增「按技能分组每条 32 条都是 序号_流程名_技能名」+ 按技能选中只导一条 / 幂等），FAIL=0 |
| 2026-10-10 | **技能批量删除（导入后清理用）**：`harness.mjs` 新增 `removeSkills(p, ids)`（一次汇总事件、失效 id 进 `missing` 不炸整批、全空 404）；`server.mjs` 加 `POST /api/projects/:id/skills/delete`；技能页列表每行加勾选框（状态 `SKPICK`，重渲染不丢、按当前列表自愈）+ 卡头「全选 / 取消全选」与「✕ 删除选中（N）」（未勾选禁用、`confirm` 后删、删完清空勾选）；i18n 补 `sk.pick*` / `sk.delSel*`（三语） | 单测 **55**（新增「技能批量删除…」：删两条 / missing / 一条事件 / 全空 404）+ 离线 e2e 110 + UI 检查 **200**（新增 [8.23] 9 条：未勾选禁用 / 全选 32 条 / 取消全选 / 勾两条 / 服务端少两条 / 列表消失 / 勾选清空 / 提示 / 事件记账），FAIL=0；截图 out/58-skills-bulk-delete.png |
| 2026-10-10 | **新增预设技能：静态网站开发规范**（`skills/dev-static-site.md`，stage=development、tech=static，预设技能 31 → 32 条）：执行侧没有 npm/打包器，所以把静态站的**可执行形态**定死为「模板是纯函数、内容是数据、页面是字符串」——数据/模板分离、模板函数必须纯、**转义即安全（`esc()` + 属性加引号 + URL 协议白名单）**、路由表是唯一真源且断链要测、分页/排序显式传参、SEO 与无障碍（title/description/canonical/alt/标题层级）也要断言、CSS 与构建工具（Astro/Hugo/11ty/Vite）留架构与部署文档、浏览器交互脚本要标明未在平台内真跑 | 单测「预设技能库：每个阶段都有技能文件…」的技术栈断言加 `static`（现 32 条、开发阶段 9 条）；npm test 54 通过；活服务 `/api/skills/catalog` 已能读到（32 条，dev-static-site stage=development tech=static） |
| 2026-10-10 | **工作流（harness 变体）：按客户的项目需求选不同的阶段序列**：`harness.mjs` 新增 `WORKFLOWS`（5 条预设：标准全流程 / 精简交付 / 原型验证 / 变更维护 / 方案设计）+ `workflowOf` / `stagesOf` / `checkWorkflows`（自检：id 唯一、阶段都在 STAGES、带开发必带 WBS）；`createProject` 按所选工作流建 `p.stages`（老项目没有 `workflow` 字段 = 全流程，未知 id 也回落全流程）；`docDirOf/docPathOf` 加可选第 2 参 `p`，**产物落盘序号跟项目自己的工作流走**（精简流程没有 UX → 架构就是 `docs/02-架构设计`），`writeArtifactFile` 传 p。`server.mjs` 的 `/api/state` 带 `workflows`。界面：新建表单「工作流」下拉（选项直接排出阶段序列）、项目卡与总览的流程徽标、侧栏「流程与门禁」角标 = 该项目阶段数（原写死 8）。不在工作流里的阶段 `run` → 404。i18n 补 `proj.workflow*` 与 `wf.*`（三语） | 单测 **54**（新增「按客户需求选工作流…」：预设自检 / 精简与原型序列 / 未知值回落 / doc 序号 / 非工作流阶段 404）+ 离线 e2e 110 + UI 检查 **191**（新增 [8.22] 5 条：精简项目流水线 5 节点、角标 5、表单 5 个工作流可选、选「方案设计」真落库 4 阶段、项目卡标出工作流），FAIL=0；截图 out/00-projects.png 重拍 |
| 2026-10-10 | **修「一个层的同名类把每个模块都拖红」+ 门禁报错分档**（用户实测报障：CAP 项目所有模块 rc=1、点批准被告知「缺少单元测试记录」）：`exec.mjs` 的 `runJava` 加第 3 参 `ownFiles` —— 模块级执行只编**本模块自己的 .java + 本模块的测试**，集成/部署阶段（`runWorkspaceTests`）仍编全工作区；`runTests` 透传，`harness.mjs` 两处模块级调用传 `mod.files`（人工改文件那处还带上刚改的文件）。命令串写明范围（`· 本模块` / `· 全工作区`）。`harness.mjs` 的批准门禁分档：`缺少单元测试记录` 只在真的没记录时出现，有记录但 rc≠0/total=0 时报「单元测试未通过（编译失败 / 测试没产出结果 …，退出码 N）」。`agent.mjs` Java 语言规约第 2 条从「同层内类名唯一」改成**类名全局唯一**（同一实体只在一个层定义）——根因是各层各写一个 `Order`，无 package 单 classpath 下整个工作区编译失败 | 单测 **53**（新增「Java 模块级执行只编本模块」真跑 javac 两遍对比；门禁编译失败文案；Java 提示词断言）+ 离线 e2e 110 + UI 检查 186，FAIL=0；**真项目实测**：`开发订单管理的sap cap` 6 个模块 rc 1→0、287 条断言（66/41/65/38/42/35）全绿，模块单测记录已按真实重跑写回（备份 `data/projects.json.bak-*`） |
| 2026-10-10 | **通用规则：没有环境，系统自己装并配好**（预设技能 + 执行层一起落地，规则要能被验证）：新增跨阶段技能 `skills/env-环境自举.md`（`stage`/`tech` 皆空 = 所有阶段，预设技能 31 条）—— 探测 → 安装 → 重探 → 装不上才失败，失败要写明试过什么命令/退出码；「自己装」只指运行环境，产物依赖仍按架构规约。`exec.mjs` 新增 `installPlan(kind)` / `ensureToolchain(kind,{probe,plan})`：探不到 JDK / python3 时用系统包管理器装一次（`brew install openjdk@21` / `python@3.12`，15 分钟超时）再重探；`runJava`/`runPython` 改走 `toolchainOrProvision()`，装上了照常真跑，装不上时把「已自动安装 `<命令>`（退出码 N）后仍不可用」写进失败原因（仍绝不静默退回 Node、也不假装装过）。钩子：`AI_PLATFORM_NO_INSTALL=1` 关自举、`AI_PLATFORM_INSTALL_CMD` 换安装通道（走 `sh -c`，自带引号处理）、`probe`/`plan` 可注入 | 单测 **51**（新增「环境自举：缺工具链就装一次再重探，装不上如实失败、已有则不动」；「缺 JDK 时明确失败」补 `AI_PLATFORM_NO_INSTALL` 免得测试真去 brew），FAIL=0；真机探针实跑（注入假安装器）：安装命令**真执行**（留痕 + 退出码 0）、重探仍缺 → 如实报错 |

## 9 源码目录结构规约（架构 → 模块）

用户要求「架构设计阶段定下将来生成源码的目录结构，模块生成时按技术架构的约定把对应模块的源码归类到对应目录下」。
**结构由平台定，层清单由架构阶段填**，落地三处：

| 环节 | 做什么 | 代码 |
|---|---|---|
| 架构设计 | 提示词要求 ARC-01 必须含「源码目录结构」一节 + 固定格式 json 块 `{"stack":"…","layers":[{"dir":"core",…}]}`；用户没给技术栈时由模型在 `stack` 里定选型 | `agent.mjs` `LAYOUT_RULE` |
| 解析 | 取**第一个含 `layers` 的 ```json 块**（数组/对象两种写法都吃），层名按 `^[a-z][a-z0-9_-]*$` 过滤/去重/小写化；`stack` 一并取出作为**事实**（`project.arch.stack`），WBS/代码提示词都用它；解析不到退回 `DEFAULT_LAYERS`（core/domain/service/api）并在事件流写明来源 | `agent.mjs` `parseLayout`（`parseLayers` 为其薄封装）/ `harness.mjs` `readLayout` |
| WBS | 每个 Epic 必须带 `layer`（不在清单里按序回落）；模块对象上存 `layer / slug / dir / test_path_planned` | `agent.mjs` `wbs` / `harness.mjs` `planModules` |
| 模块生成 | 两个通道都只**读** `mod.dir`、`mod.test_path_planned`，不再各自拼路径；测试的导入前缀 = `'../'.repeat(测试路径层数)` | `agent.mjs` `moduleCode` / `sim.mjs` `moduleCode` |
| 记录位置 | 模块产物头部固定 `**架构层** / **代码位置** / **测试位置**`，下面列真实交付文件与行数；界面模块详情同字段展示，页头显示技术栈 + 分层 + 来源 | `harness.mjs` `buildModuleReport` / `public/app.js` |

实测布局（离线自动项目，8 阶段全批准 / 每模块 6 条真实单测 FAIL=0）：

```
src/core/m1-基础工具/index.mjs      test/core/m1-基础工具.test.mjs
src/domain/m2-数据模型/index.mjs    test/domain/m2-数据模型.test.mjs
src/service/m3-核心业务/index.mjs   test/service/m3-核心业务.test.mjs
src/api/m4-接口层/index.mjs         test/api/m4-接口层.test.mjs
src/core/m5-质量与交付/index.mjs    test/core/m5-质量与交付.test.mjs
```

真实模型端到端同样落位：`core` 层 → `src/core/m1-基础框架/{date,money,id,result}.mjs` + `test/core/m1-基础框架.test.mjs`，19 条单测退出码 0。
（此前两次真实模型跑：一次 `core` 层 3 个文件 15 条单测退出码 0；一次 `domain` 层 1 条单测真实失败 FAIL=1 → 门禁 409 正确拦住批准。）

**技术栈缺省（2026-10-05 实测，故意不输入技术栈）**：模型自己给出
`Node.js 20 ESM + NestJS(目标架构) + PostgreSQL(目标)/node:sqlite(落地) + node:test`，
并自定 **5 层** `core / domain / application / infrastructure / interface`（不是平台默认的 4 层），
6 个 Epic 全部归到合法层，模块目录：
`src/core/m1-基础框架、src/domain/m2-领域模型、src/domain/m3-借阅规则、src/application/m4-借阅应用服务、src/infrastructure/m5-持久化适配、src/interface/m6-接口层`；
M1 落盘 5 个文件全在 `src/core/m1-基础框架/` 下，真实跑出 18/19 → 退出码 1 → 门禁 409 拦住批准（期望行为）。

配套放宽的地方：文件→模块的归属判定改为「路径里任一目录段匹配 `^m(\d+)-`」（多一层层目录否则全丢），
`harness.mjs` 与 `public/app.js` 两处同名函数一起改；模型没按规约落位时**不拦流水线**，只在事件流推一条 ⚠
（哪个模块、几个文件、哪些路径）。

目录名允许中文/日文：`exec.safeRel` 的白名单加了 CJK/假名区段（仍拒 `..`、绝对路径、盘符）并统一 `normalize('NFC')`，
`slug()` 同步保留 CJK，于是目录是可读的 `m1-基础工具` 而不是 `m1-mod`。
`ponytail:` 已知天花板：macOS 的 `readdir` 可能回 NFD，与 NFC 的 `mod.dir` 字符串比对会不相等 —— 归属判定有
「路径里任一目录段匹配 `^m(\d+)-`」兜底，所以只会走慢路径、不会丢文件。

