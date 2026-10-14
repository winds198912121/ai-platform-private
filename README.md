# AI Dev Platform · Software Development Visualization Platform

Make "AI-driven software development" a platform that **actually runs end-to-end**: project entry → real model produces deliverables → human approval before advancing to the next stage → WBS breakdown → **real code generation + real unit test execution** → human approval before the next module → integration testing → deployment → operations. The whole process is visible in the UI in real time.

This is **not demo data**: deliverables are produced by a real large model; module code is written to disk; **unit tests run on real toolchains per stack** (Node → `node --test`; Java → `javac` compilation + `java` running the test class; Python → `python3` + standard library `unittest`; SAP CAP additionally produces `db/schema.cds`/`srv/*.cds` and does structural validation), and the gates read real exit codes.

Zero dependencies (Node standard library) — `node server.mjs` just runs. The UI reuses the design system at `~/Desktop/work/pm/design` (instrument gray + single amber + IBM Plex, dark/light themes, density toggle).

## Running

```bash
cd ~/Desktop/work/pm/ai-platform
node server.mjs                 # → http://127.0.0.1:8788
```

Environment setup, configuration, start/stop, health checks, and acceptance have a CLI entry point: `bash setup/install.sh <check|install|configure|verify|start|status|stop|selftest>`. See `setup/README.md` for the prerequisites table, environment variables, config priority, multi-instance & lock file, and common issues.

Model key lookup order: `AI_PLATFORM_API_KEY` → `DEEPSEEK_API_KEY` → `DEEPSEEK_API_KEY` in `~/.hermes/.env`.
**No key? It will not fake success**: the stage explicitly fails and tells you the key isn't configured. To use the offline template channel, explicitly set `AI_PLATFORM_PROVIDER=sim` (the top bar will mark "Offline Template Channel").

| Environment variable | Description |
|---|---|
| `AI_PLATFORM_PORT` / `AI_PLATFORM_HOST` | Bind address, defaults `8788` / `127.0.0.1` |
| `AI_PLATFORM_PROVIDER` | `live` (default, calls real model) / `sim` (offline templates) |
| Single-output token cap | The platform sets its own `max_tokens` cap at **65536** (not the model's). Normal calls use each stage's budget; if `finish_reason=length`, retry once with 65536. Both attempts truncated ⇒ fail. Empirically `max_tokens=40000` lets this channel run all the way to `stop` (27k tokens). |
| `AI_PLATFORM_API_KEY` / `AI_PLATFORM_BASE_URL` / `AI_PLATFORM_MODEL` | Model channel, default DeepSeek `deepseek-v4-flash`; `AI_PLATFORM_MODEL` is the **default model**, overridable per stage in a project. |
| `AI_PLATFORM_DATA` | State file, default `data/projects.json` |
| `AI_PLATFORM_WORKSPACE` | Working directory for generated code, default `workspace/` |
| `AI_PLATFORM_CONCURRENCY` | **Concurrency of the development stage** (how many Dev Agents write code at the same time), default `3`, range `1–8`; `1` = serial and requires the previous module approved first |
| `AI_PLATFORM_SPEED` | Step pacing multiplier; `0` = no wait (for tests) |

## Core Model

```
Project entry (name / brief / tech stack / execution mode)
        │
        ▼
① Requirements ──▶ Real model produces deliverables ──▶ ⏸ Human gate ✓/✕
② UI/UX design ──▶ Real model produces deliverables ──▶ ⏸ Human gate
③ Architecture ──▶ Real model produces deliverables ──▶ ⏸ Human gate
④ WBS breakdown ──▶ Real model splits into Epic/Task ──▶ ⏸ Human gate
⑤ Module development ──▶ Dev-Agent-1..N pick up modules in parallel
                For each module: model writes code → writes to disk → runs real tests per stack (Node/Java/Python) ──▶ ⏸ Each has its own human gate
                The stage closes after all modules are approved (approval order is not required)
⑥ Integration testing ──▶ Run the full test suite in the workspace ──▶ ⏸ Human gate
⑦ Deployment ──▶ Real syntax check + smoke test ──▶ ⏸ Human gate
⑧ Operations ──▶ Real model produces runbook ──▶ ⏸ Human gate
```

**Gates are enforced server-side** (not just UI decoration):

- Trying to run a later stage when the previous one is unapproved → `409 Previous stage "X" is not approved`
- Approving/rejecting a stage/module that isn't in "awaiting review" → `409`
- Module **without real** unit tests, `FAIL>0`, or non-zero exit code → approve returns `409`, button is grayed out
- Previous module unapproved → next module cannot be developed
- Reject must include a `category` (reason classification) and `comment`; the feedback is fed back to the model, the module is regenerated with `attempts+1`, and resubmitted

**Execution mode**: `human_gate` (default, every step waits for human approval) / `auto` (gates auto-pass; for demoing the full pipeline).

**Workflows (harness variants — pick based on client project needs)**: when creating a new project, you pick a workflow which decides which stages the project runs (more stages ⇒ more complete delivery, but more time and tokens). 8 presets are preconfigured (one row per workflow in `harness.mjs`'s `WORKFLOWS`; add a new one by adding a row):

| id | Name | Stages |
|---|---|---|
| `full` | Standard full pipeline (default) | Requirements → UX → Architecture → WBS → Development → Testing → Deployment → Operations |
| `lean` | Lean delivery | Requirements → Architecture → WBS → Development → Testing (back-end/API projects; no UX, deployment, or operations) |
| `prototype` | Prototype validation | Requirements → UX → WBS → Development (verify it works first) |
| `change` | Change / maintenance | Requirements → WBS → Development → Testing → Deployment (modify existing systems) |
| `design` | Solution design | Requirements → UX → Architecture → WBS (deliverables and plan only, no code) |
| `website` | Website / static site | Requirements → UX → Architecture → WBS → Development → Testing → Deployment (content sites, no operations) |
| `service` | Back-end service / API | Requirements → Architecture → WBS → Development → Testing → Deployment → Operations (no UI; skip UX) |
| `data` | Data processing / migration | Requirements → Architecture → WBS → Development → Testing → Deployment (batch/migration/reports; skip UX and operations) |

- **A workflow = an ordered subset of stage ids**; constraints: "id must come from `STAGES`" + "if it includes development, it must also include wbs" (modules come from WBS). `checkWorkflows()` does this self-check; unit tests call it.
- Project data carries its own `workflow` field; **old projects without the field = full pipeline** (no migration); unknown ids also fall back to full pipeline, no empty pipelines.
- A stage not in the workflow: `POST …/stages/<id>/run` returns `404 stage not found`; it won't quietly run.
- **Deliverable file ordering follows the project's own workflow** (`docDirOf(ownerId, p)`): a lean workflow without UX puts architecture deliverables under `docs/02-Architecture/`. The on-screen stage numbers follow the same logic (`stageNo` uses `p.stages` index).

**Software type (auto-brings the default workflow above)**: the first field of the new-project form is **Software type** — it expresses "what is this thing?" and brings its default workflow; the **Tech stack input sits directly under it** (after picking a type, its placeholder immediately switches to that type's example), and the Workflow dropdown below can still be overridden in place (an explicit workflow takes precedence over the type). 5 presets are configured (`TYPES` in `harness.mjs`):

Form order: **Name → Brief → Software type → Tech stack → Workflow → Execution mode → Input materials** (decide "what to do, what kind, then which stack and which stages").

| Type id | Name | Default workflow | # stages | Skill pack | Directory convention (layers) |
|---|---|---|---|---|---|
| `webapp` | Web app (front-end + back-end + DB) | `full` | 8 | 8 (general conventions / code layout / security baseline / env bootstrap / Node.js / Spring Boot / layering contracts / coverage matrix) | `core / domain / service / api / ui` |
| `website` | Website / static site (content-driven) | `website` | 7 | 8 (… / static site / React+Vite / information architecture / release & rollback) | `core / content / ui / app` |
| `service` | Back-end service / API (no UI) | `service` | 7 | 9 (… / Spring Boot / Node.js / Python / data consistency / monitoring & ops) | `core / domain / api / repo` |
| `cli` | Tool / script (CLI) | `lean` | 5 | 7 (… / Node.js / Python / review checklist) | `core / cli / io` |
| `data` | Data processing / migration / report | `data` | 6 | 8 (… / Python / Node.js / data consistency / perf & security testing) | `core / io / transform / report` |

**Each type = a generic config of "workflow + skill pack + directory convention"** (all in `TYPES` in `harness.mjs`; one row per type):

- **Workflow**: the type brings the default workflow (table above; the dropdown can still override it; explicit workflow wins).
- **Skill pack** (`TYPES[].skills`, pointing to `skills/*.md` presets): the Skills page has a one-click "⬇ Type skill pack (N)" button (`data-type-import` → reuses `POST …/skills/import`); clicking imports the relevant skills into this project (idempotent). Still "explicit import to take effect" — the preset library is just templates; once imported the project can edit/delete; calls use the project's own copy (consistent with the "project skill library takes priority" rule).
- **Directory convention** (`TYPES[].layers`): included on project creation, **auto-applied** (`p.arch.from = 'type-default'`) — the architecture stage prompt uses this layer list, and module sources land directly in `src/<layer>/`; if the architecture stage declares a valid layer list in ARC-01, **that wins** (`from: 'ARC-01'`). **Clicking ♻ Rebuild, or changing type/workflow in Edit, reverts the directory convention to the type's own (no longer "empty").**
- Type self-check `checkTypes()`: id unique, workflow exists, 2–4 tech stack suggestions, **skills must exist in the preset library**, layer list ≥1 and unique, layer name valid (lowercase letters/digits/hyphens) — unit tests call it.
- The new-type self-check also runs: `/api/state` sends `types` (with `skills` / `layers` / `techs`) to the UI, so the "New Project" hint line will read `Type skill pack N items (one-click import on Skills page) · Directory convention a / b / c`.

- The software type lands in `project.type`: **old projects without this field don't show the type** (UI doesn't error, no data migration); `typeOf()` falls back to the first item (Web app) for unknown/empty, and `checkTypes()` self-checks "id unique + workflow exists" (unit tests call it).
- Software type carries **tech stack suggestions** (`TYPES[].techs`, 2–4 per type): after picking a type, the tech stack input directly below it gets ① a placeholder swapped to the top suggestion, ② a native `<datalist>` (clicking/typing the input pops a dropdown) — **suggestions follow the type**, and you can also type your own. Suggestions are limited to runtimes the platform can actually run (Node / Java / Python / SAP CAP), not stacks the platform can't handle.
- **Tech stack remains "user input first"**: it's used to determine the language profile (`profileOf`, see language profile table) and decide what to produce and what command runs the tests; type suggestions are just typing candidates, never auto-filled (to prevent submitting with the example without noticing). Picking a type immediately shows its default workflow in the hint (e.g., Website/Static site → Requirements → UI/UX → Architecture → WBS → Module development → Integration testing → Deployment, no operations), and the created project runs exactly that workflow.
- **Software type and workflow are immutable after creation** (changing them reorders stages and orphans deliverables) — "✎ Edit" prompts make this clear.
- Verification: unit test "Project type: each type brings its own default workflow…" (stages = workflow / explicit workflow wins / unknown type falls back / legacy client creates without type / 2–4 suggestions per type, unique, no leading/trailing whitespace / website type's top suggestion maps to node profile) + e2e `[2g]` (create 3 projects: 7-stage, 5-stage, explicit 4-stage; type and suggestions persisted; events include type) + UI check `[8.25]` (12 items: type dropdown / **tech stack sits under type** (asserts DOM order) / label is "Software type" / default type has 3 suggestions / has datalist / picking a type auto-switches workflow / hint line lists workflow / placeholder swaps to top suggestion / **suggestions follow type** / choosing a suggestion fills tech stack / created project has 7 stages / card shows type), screenshot `out/61-proj-type.png`.
- UI: New-Project form's "Workflow" dropdown (options directly list the stage sequence), project card and overview workflow badge, sidebar "Workflow & Gates" badge = the project's stage count.
- Verification: unit test "Pick workflow by client need…" (preset self-check / lean and prototype sequences / unknown value falls back / doc numbering / non-workflow stage returns 404) + UI check `[8.22]` (lean project pipeline 5 nodes, badge 5, picking "Solution design" in the form actually creates a 4-stage project, project card shows workflow).

## Real Execution (not a numbers game)

- After the model returns code, `exec.mjs` writes files into `workspace/<projectId>/` (whitelist-checked paths, rejecting `..`/absolute paths).
- Then in the workspace it actually executes by **language profile**: Node → `node --test <test file>`; Java → `javac -d .build *.java && java -cp .build <test class>`; Python → `python3 <test file>` (stdlib unittest). Parse the real output to get `tests/pass/fail/exit_code/elapsed`; raw output is also stored in the deliverable. When a toolchain is missing (no JDK / no python3), the module **explicitly fails and says what's missing**; it does not silently fall back to Node.
- Integration testing / deployment stages run for real too, producing "Integration test report (real execution)" and "Build validation report".
- Only pure functions are tested, not nondeterministic behavior; tests that didn't actually run (zero output) are judged failed — no "fake green" allowed.

## Language Profiles (tech stack decides what to produce and how to run)

`exec.mjs`'s `profileOf(tech)` infers the language from `arch.stack` (architecture-declared) → `project.tech`; falls back to Node if unrecognised:

| Profile | Detection keywords | Source / test paths | Real run command |
|---|---|---|---|
| `node` | default | `src/<layer>/order-service.mjs`, `test/<layer>/order-service.test.mjs` | `node --test <test file>` |
| `java` | java / spring / struts / kotlin / quarkus (**`java(?!script)`**: `JavaScript` / `JS` / `static site` don't count as Java) | `src/main/java/<layer>/OrderService.java` (file name = public class name), `src/test/java/<layer>/OrderServiceTest.java` | `javac -d .build <all .java>` → `java -cp .build <test class>` |
| `cap-java` | SAP CAP / CAP / RAP / CDS + java (also `java(?!script)`) | Same as java, plus `db/schema.cds`, `srv/<name>-service.cds` | Same as java + CDS structural validation |
| `cap-node` | SAP CAP + node | Same as node, plus CDS | `node --test` + CDS structural validation |
| `python` | python / django / flask / fastapi | `src/<layer>/order_service.py`, `test/<layer>/order_service.test.py` | `python3 <test file>` (stdlib unittest) |

- **Java test class convention** (written into the prompt; the model follows it): `public class M<NN>Test` + `main`, accumulates `pass/fail` via `check(name, ok)`, prints `tests N` / `pass N` / `fail N` at end, and exits with `System.exit(fail==0?0:1)` — the platform relies on that exit code and three-line stats for the gate.
- **CDS is not a compiler**: when `@sap/cds-dk` isn't installed locally, it only does structural validation (brace pairing / has `namespace|entity` / each entity has a `key`), and the report says "this is not the result of `cds compile`"; only with cds-dk installed does it attempt real compilation.
- **Toolchain discovery**: `JAVA_HOME` → `PATH` → Homebrew kegs (`/opt/homebrew/opt/openjdk@21|27/bin`, keg-only isn't in PATH); it actually runs `javac -version` once to verify (macOS's `/usr/bin/javac` is a "JDK not installed" stub; just checking executable bit will be fooled). Python uses `python3`.
- **Missing toolchain? Self-install** (skill `env-bootstrap` implementation): when JDK / python3 is not detected, `exec.mjs`'s `ensureToolchain()` runs the system package manager once (`brew install openjdk@21` / `python@3.12`, 15-minute timeout), then re-probes; if installed, just run normally. **Only fails when installation itself fails**, and the failure reason records "which command was tried, exit code" — it never silently switches to Node and never pretends to have installed. Disable self-install: `AI_PLATFORM_NO_INSTALL=1`; custom install channel: `AI_PLATFORM_INSTALL_CMD='<full command>'` (runs via `sh -c`).
- **Java compile scope = this module**: module-level execution only compiles `mod.files` (this module's own `.java` + this module's test), while the **integration/deployment stage** (`runWorkspaceTests`) compiles the whole workspace. Reason: no package, the whole workspace shares one classpath — if two layers each define a same-named class (`Order` / `ApiResponse`), the error is "duplicate class Order", and one layer's problem turns **every** module red (verified: one CAP project's 6 modules all returned rc=1; compiling per module = 0 errors, 287 assertions all green). The command string shows scope: `<N .java · this module>` / `<N .java · whole workspace>`. Verification: `test/exec.test.mjs` "Java module-level execution only compiles this module" (same-named class: this module scope actually passes; whole workspace scope must report duplicate). Prompt update: `agent.mjs` Java language spec rule 2 changed to **class names must be globally unique** (the same entity is defined in only one layer; other layers reuse it or pick a more specific name); `test/agent.test.mjs` enforces this.
- **Gate errors are tiered**: "missing unit test record" only appears when there's truly no record; when a record exists but the test produced no result (compile failed, toolchain missing), it reports "unit tests not passed (compile failure / no test result …, exit code N)" — the old "missing record" message misdirected users. Verification: `test/harness.test.mjs` "Module without completed unit tests cannot be approved".
- Integration test and deployment use `runWorkspaceTests()`: whichever languages have artifacts in the workspace, all of them run for real (Java compiles all `.java` and runs each test class on the same classpath; Python file by file; Node runs `test/`).
- **Legacy project migration**: `node tools/migrate_stack.mjs` (`--apply` to persist, `--clean` to drop sources that don't fit the new profile) re-computes module directories for projects that say "Java in the design but produce .mjs" and pushes them back to awaiting development; approved stages and document deliverables are preserved.

## Display Conventions: Workflow Names and Deliverable Names (unified UI wording)

- **Workflow names (stages)**: always "two-digit ordinal + name", with the ordinal following the pipeline order (`01 Requirements` … `08 Operations`); names render in the UI language (Chinese / English / 日本語, keyed off `public/i18n.mjs`'s `stage.<stageId>`; the server only stores the Chinese name, and translation happens at render time, falling back to the original when the key is missing). Used in: pipeline nodes, stage detail titles, gate prompts, project card and KPI's "current stage", deliverable ownership column, "applicable stage" on the Skills page.
- **Deliverable names**: shown as `ordinal-workflow-name-generated-name` (e.g., `01-Requirements-Requirements Specification`, `05-Module Development-Basic Framework · Code and Unit Tests`). The ordinal and workflow name follow the pipeline and language; **the generated name itself is domain content produced by the model — not translated, not rewritten**.
- **Pipeline nodes (`pipe()`)**: 8 stage nodes fill a single line at equal widths (`flex: 1 1 0` + `min-width: 96px`, 84px on narrow screens; horizontal scroll inside the card only when they don't fit), node content centered; each node has an **inline linear SVG icon** between ordinal and name (the `STAGE_ICO` in `public/app.js`, `stroke: currentColor`, accent on selection) — zero dependencies, no emoji or icon font, add a stage in one place. Overview and Workflow & Gates share `pipe()`, so changes propagate. **A "who's executing" robot icon** lives in each node's top-right (`STAGE_ROBOT` + `stageBadge()`, 20px, at top:5/right:6): every stage has a **different robot** in **true color** (Requirements blue / UX purple / Architecture cyan / WBS amber / Development green / Testing red / Deployment indigo / Operations teal), with differences in head shape (square/round), antenna (single/double/ring/tri-prong/ear), eye type (double dot/triple dot/square eye/eye patch/cyclops/pulse), arms; `title` says "<Agent name> executing"; same inline SVG, zero dependencies, add to `STAGE_ROBOT` per new stage. Verification: UI check `[8.19]` (8 equally wide nodes, 0 right margin, 28px icon centered) plus 4 robot assertions (20px / 8 shapes / 8 colors / top-right + title), screenshot `out/57-flow-rail.png`.
- **WBS top tabs (Task tree / Module Development)**: icon on top, text below (`.tab:has(.tico) { flex-direction: column }`; icons reuse the pipeline's `ICO()` — task tree = hierarchy tree, module development = code brackets), the two tabs are **equal width** and don't wrap text (`.tabs-eq { display: grid; grid-template-columns: 1fr 1fr; width: max-content }`; **`width: max-content` is the key** — with just `1fr 1fr`, the container width is undetermined, fr falls back to per-content width; tested at 59px ≠ 70px. CDP tested 7 approaches; only this one is equal). Verification: UI check `[8.10]` (15px icons on top, 70px = 70px, `white-space: nowrap`, 0 overflow); equal width in zh/en/ja (70 / 135 / 105).
- **Module Development two columns 4:6**: `devSection`'s grid is `g-dev` (`.g-dev { grid-template-columns: 4fr 6fr }`; the base rule and ≤1560 media query each declare it once — under same specificity the latter wins), left "module development" 4 : right "module details" 6. Verification: UI check `[8.10]` (568 / 852 = 0.400).
- **Page title icon**: each view has a linear icon before `h1` (`VIEW_ICO` + `viewTitle(id, text)` in `public/app.js`, reusing the same `ICO()`), 18px, `--muted`, same line as the title (`.page-head h1 { display:flex; gap:8px }`) — adding a view only changes `VIEW_ICO`; the empty "Project Entry" view also has an icon. Verification: UI check `[8.21]` (8 view titles 18px, `h1` first child is `.tico`).
- **Left menu icon**: each item = `icon / ordinal / menu name / badge` — the icon **precedes the ordinal** (`paintNavIcons()` is called once on entry, idempotent; same `VIEW_ICO`), 15px, `--muted`, current page turns `--accent`; `.navbtn` grid `16px 22px 1fr auto`. Icons sit **outside** the `.ic` (ordinal): when switching languages `[data-i18n]` will `textContent =` overwrite children, putting them inside the label would be wiped. The ordinal is kept (digits 1–7 are shortcut-key hints). Verification: UI check `[8.7]` (8 items have 15px icons + `compareDocumentPosition` proves they're before the ordinal; numeric key assertions unchanged).
- **Run Log event stream**: timestamp column 140px + `white-space: nowrap` (`.steps-time .s`, `2026-10-11 17:44:02` on one line; unaffected by the two `.steps-mini` in the file list). Verification: UI check `[8.27]` (column 140px, 1 line, `nowrap`).
- **Page-head note on one line**: `.page-head p` (the gray hint line under view titles like "Workflow & Gates") **does not set `max-width`** — the Chinese note fits on one line at normal window width, so don't wrap it into two (the old `78ch` cap would break CJK into two); on narrow screens, the container width naturally wraps, with `overflow-wrap: anywhere` for long words. Verification: UI check `[8.20]` (1680 window: 55 chars on 1 line, no horizontal overflow in either the note or the page).
- This prefix convention only affects **display**: deliverable ids (`REQ-01`/`US-01`/…), stage ids, and written file names are untouched — don't write display wording into data or prompts, or reads won't match.
- **Deliverable directory** (rule): `docs/<two-digit-stage-ordinal>-<stage-name>/<deliverable-id>.md`, e.g. `docs/01-Requirements/REQ-01.md`, `docs/03-Architecture/ARC-01.md`, `docs/07-Deployment/DPL-02.md`; module deliverables (`M1-CODE`…) go under `docs/05-Module-Development/`. Directory names use the **server-side stage name** (Chinese), not the UI language — disk paths can't follow the UI language; `/` in names becomes `-` (e.g., `02-UI-UX-Design`). The rules live in `harness.mjs`'s `docDirOf()` / `docPathOf()`; manual edits to a deliverable use the same path.
- **Empty content area stays empty** (rule): the middle content area of the source page and the "Files" tab on the deliverables page (`codeBrowser()`'s `mid`) only renders `<pre>` / editor **when a file is selected**; new projects, an empty workspace, or unreadable files all render **empty** (no hint text). The empty-state hint lives in the **left list only** (`code.emptyList` / `code.emptyWs`) and the page header; the right content area stays clean.

## Source Directory Convention (set by architecture stage, followed by module stage)

Module sources don't each pick their own place — the location is decided by **the architecture stage's ARC-01** and **the platform** together:

```
docs/architecture/ARC-01.md   Architecture design — includes a "Source Directory Structure" section + a json code block declaring the layer list
        │  Platform parses the layer list out of ARC-01 (fallback → platform default core/domain/service/api; event stream notes the source)
        ▼
src/<layer>/order-service.mjs         One Epic = one module = a set of business-named files, **directly under the layer directory**
test/<layer>/order-service.test.mjs   Unit tests mirror source by business name (relative import ../../src/<layer>/…)
```

- Each Epic in WBS must carry `layer` (must be from ARC-01's declared list; illegal value falls back by order), and the module object stores `layer / slug / dir / test_path_planned` directly.
- **Both real-model and offline channels only read those fields**; they don't each build their own path — changing the layout is a single-place change.
- If the model doesn't follow the convention, the pipeline isn't blocked, but an event is pushed: ⚠ which module, how many files, which paths, so the deviation is visible.

## Multi-Agent Parallel Development

The development stage doesn't queue modules — **N Dev Agents pick up in parallel** (default 3, tunable via `AI_PLATFORM_CONCURRENCY`):

- `kick()` fills the idle slots atomically: `slots = concurrency - currently running modules`, picked up synchronously (the state machine itself is the lock — `runModule` marks the module `running` before the first `await`, so there are no double-claims).
- Each Agent independently: model writes code → writes to disk → actually runs `node --test` → stops for **its own** human approval; releasing a slot the moment one is approved, immediately picking up the next.
- **Approval order is not required** (in parallel development M4 may finish before M1); the development stage only closes after **all modules are approved**.
- Both the event stream and the UI mark "who is doing which module": `▶ Dev-Agent-2 picked up module M4 "Borrowing core flow"`.
- `concurrency=1` falls back to the legacy serial semantics (and requires the previous module approved first) for cases requiring strict order.
- **Unit test failure = module failure (not "awaiting review")**: gates require `PASS>0 & FAIL=0 & exit_code=0`; otherwise the module is marked `failed` and the real failing cases are recorded. The retry loop auto-retries (**≤3 rounds**, looking only at `attempts`); on retry the **real test output from the previous round** (last 1200 chars) is fed back to the model — feeding only human rejection feedback would just make the model blindly regenerate. After 3 rounds it stops at `failed`, with the UI saying "needs human action (view real output, or reject this module to retry)"; reject = the human's 4th chance.
- **Transient failures don't consume the retry budget**: model empty response / timeout / 429 / 5xx / connection reset (`isTransientModelError()`) re-queues in place and rolls back `attempts` (up to 2 attempts), otherwise one network blip eats 1/3 of the budget.
- **Tests have a hard timeout**: the default for a single test command is 120s (`AI_PLATFORM_TEST_TIMEOUT_MS`); at the deadline **kill the entire process group** and report "test timeout" honestly — `node --test` runs test files as child processes; killing only the parent leaves grandchildren holding the pipe, `close` never fires, and the whole pipeline hangs here (tested: 20 minutes of no movement). Timeout doesn't count as a pass.
- **Service is single-instance**: `data/projects.json.lock` records the PID; the second instance exits immediately — two servers each holding a memory copy and each `flush()`ing silently overwrite each other's progress (tested: an approved module was written back to failed by the old snapshot).

## Deliverables are editable (human can modify and save)

Every deliverable on the "Deliverables" page has **✎ Edit** — modify and save → version +1, persisted, and **actually written** to `workspace/<projectId>/docs/…`. Switch to "Workspace Files" in the left column to directly edit the **real file** (including model-generated code and unit tests) and save.

Two hard rules (enforced server-side):

- **Once approved, it's locked**: a stage/module's deliverables and code are no longer editable after approval (`409`). Otherwise "what was approved" and "what came later" wouldn't be the same thing, and the gate loses meaning; to change, reject and redo.
- **Editing code must re-run tests**: after editing `.mjs` under `src/mN-*` or `test/mN-*`, the platform **automatically re-runs that module's real `node --test`** and refreshes the unit test record with the new result. If tests fail → state returns to "awaiting review" but approval is blocked by `409` (button grays out), prompting `FAIL=n exit_code=1`. **It will never use pre-edit test results to approve post-edit code.**
- A human-edited module **won't** be auto-regenerated by the Agent (`attempts` is unchanged) — preventing your changes from being overwritten by the next generation. To hand it back to the Agent, explicitly reject.

## Rebuild (clears all deliverables and history; skills preserved)

Every project card has a `♻ Rebuild` button (`POST /api/projects/:id/rebuild`). It **rolls the project back to its starting point**; what is cleared and what is kept are hard rules (see `rebuildProject()` in `harness.mjs` + `clearWorkspace()` in `exec.mjs`):

- **Cleared**: all stage deliverables (`stage.artifacts`), stage status / rounds / review feedback (back to `pending`, `attempts=0`), WBS (`wbs.epics=[]`), architecture rules (`arch=null`), all modules (including source / test records, `modules=[]`), event stream (`events=[]`), and **generated artifacts** under `workspace/<id>/` (`docs/`, `src/`, `db/`, `srv/`, `.build/` … — all top-level workspace entries except `inputs/`).
- **Kept**: skill library (`skills[]`, both hand-written and imported from presets), uploaded input materials (`workspace/<id>/inputs/`), tech stack `tech`, project name / brief, entry mode, and per-stage model config (`models`).
- **Accounting**: after clearing, a single `kind='rebuild'` event records how much was cleared (deliverables / modules / source·test files / run records / workspace entries) and how much was kept (N skills, M input files) — so after rebuild **the event stream contains exactly this one entry**.
- **In-flight tasks**: a project currently executing without `force` returns 409 (same rule as project deletion; UI confirms force again); after a forced rebuild, **the old round's results are not committed** (`runStage` / `runModule` checks "am I still in this round" after every `await` — stage `attempts` reset to zero, module no longer in `modules[]`, both return immediately), so deliverables/files/events won't come back.
- Skill preservation is for the **project skill library**; the `skills/*.md` preset files live in the repo and are unaffected.

Verification: unit test "Rebuild: clear all deliverables and history… skills and input materials kept" (with 409 and "late-arriving results don't land" assertions), offline e2e `[7]` (HTTP-layer accounting and on-disk clearing), UI check `[8.11]` (button present + confirmation text + after click stages return to not-started, skills still there).

## Task tree (Development tab): status colors + auto-expand & indicator while running

In "WBS / Development → Task tree" each row is a `.tnode` (grid `18px / 92px / 1fr / auto`: caret · **ordinal column (first column, widened to 92px)** · name · right status area). The status **comes from the module the task belongs to** (the platform doesn't track task-level progress; a module running means this Epic's task is executing):

- Colors: pending/un-scheduled = gray, **running = `--run` (blue)**, awaiting review = `--warn` (amber), approved = `--ok` (green), rejected/failed = `--fail` (red); in addition to the right-side status pill, the row's left edge has a same-color 2px bar (selected row still uses the emphasis bar, no conflict). Epic rows show a status pill + task count; task sub-rows show a same-color small dot + the file path on disk.
- **Currently executing**: that Epic **auto-expands** (if the user has manually collapsed it, respect that: `S.epicOpen[id] ?? (st === 'running')`), and shows a breathing indicator — reusing `.pulse` (`@keyframes pulse`, auto-paused under `prefers-reduced-motion`); the sub-row dot has the same animation.
- A color legend sits at the bottom of the card (running / pending / awaiting review / approved / failed), with wording from `MSTS`, switching with the language.
- Verification: UI check `[8.10]` section (actually run a module: reject → execute → assert auto-expand + `animationName === 'pulse'` + blue dot `rgb(79,157,255)` + sub-row same animation → after run, indicator gone, status → "awaiting review"), screenshot `out/55-tree-running.png`.

## Project info is editable after creation

- UI: click "✎ Edit" on the project card → the **right column switches from "New Project" to "Edit Project"** (not a modal, not an embedded form in the card), with the same items as New Project: project name / brief / software type / tech stack (with that type's suggestion dropdown) / workflow / execution mode / input materials (multi-select, uploaded together on save). Save takes effect immediately, cancel discards (right column reverts to "New Project"); SSE refresh during form focus only updates the footer and won't replace in-progress input (`PEDIT` tracks state, no re-render loss).
- **Software type and workflow are also editable**: changing them **reorders stages by the new workflow** — stages that match (same id) keep their state and deliverables, new ones are added as `pending`, removed ones have their records deleted (`mergeStages()`, removed stage names listed in the event; files already on disk in `workspace/` are kept), and architecture rules (layer list) are invalidated and recomputed. **Refuses to change while a stage is running** (409 "wait for the current step to finish"), to avoid modifying the stage table mid-execution.
- API: `PUT /api/projects/:id` — name / brief / tech stack / entry mode (only pass what you want to change) + software type `type` / workflow `workflow` (just sending `type` follows that type's default workflow); empty name ⇒ 400; over-length truncated by limit (name 80 / tech 200 / brief 20000 chars); unchanged values **don't write events** (idempotent). Add input materials via `POST /api/projects/:id/inputs` (`{files:[{name,content}]}`, same name overwrites, binary/empty files skipped and recorded in the event).
- Every real change writes one event: "Project info edited (software type, workflow)… type x → y, workflow a → b · reordered to 'Lean delivery' (5 stages: keep 5 existing stages, drop UI/UX design, deployment)", with both old and new names in the event stream on rename.
- Renaming doesn't move `workspace/<projectId>/` (the directory uses the project id, not the name).
- Verification: unit test "Edit changes software type / workflow: reorder stages by the new workflow…" (keep/add/remove, 409 while running, idempotent, `addInputs`) + e2e `[2f]` `[2g]` (HTTP round-trip + read-back consistency + reorder + input material write + 400) + UI check `[8.24]` (right column switches to form / items and labels match new project / type and workflow selectable / actually persisted / cancel doesn't persist) and `[8.26]` (**changing type in Edit really reorders stages**), screenshot `out/60-proj-edit.png`.

## Project card fixed structure (buttons always at the bottom)

A project card has five fixed sections from top to bottom; modify cards against this layout:

1. **Card header**: execution mode + workflow badge side by side. Execution mode uses an **icon-on-top, text-on-bottom** block (`modeBlock(p)` + `MODE_ICO`: human approval = human figure, AI auto-approval = robot head, reusing the linear SVG `ICO()`, 20px, acc/run colors, `title` gives the full name); workflow badge (`wfChip`) is 11.5px and **wraps allowed**, so long workflow names are no longer crammed into a single line or truncated.
2. Project name (`pname`, one-line ellipsis + `title` for the full brief)
3. Progress bar
4. Stats row (type · project id · stages/modules/unit tests · current stage · number of input materials)
5. **Button row** (`.card-acts`): `✎ Edit` / `♻ Rebuild` / `✕ Delete` side by side, `margin-top:auto` pinned to the card bottom — equal-height cards align their bottoms (UI check via `getBoundingClientRect` asserts each card is within 15px of the bottom, no buttons in the card header).

The two long notes in the form (**Workflow**: general explanation + the current workflow's stage sequence; **Execution mode**: what each of the two modes means) live in the `.hint.big` line **below the dropdown** (12.5px, same size as body, wraps), not inside `<option>` — the native dropdown doesn't wrap, it just truncates.

## New project can upload input materials (multi-select)

- The entry form can **multi-select** text files (`.md/.txt/.json/.yaml/.yml/.csv/.mjs/.js/.ts/.html/.css/.sql/…`); or you can POST these files along with `name/tech/brief/mode` directly to `POST /api/projects`.
- Constraints: each file ≤256KB, max 10 files; empty content and binary (NUL) files are **skipped and the reason is written into the event stream**, never silently dropped.
- Storage: actually written to `workspace/<projectID>/inputs/<file name>` (basename normalized, path traversal rejected; CJK and extensions preserved).
- Usage: content is fed into prompts (requirements/architecture/WBS: each file excerpt 1.8K chars, total 6K cap, to avoid blowing up context) and recorded in `project.inputs` (with 4K excerpt + byte count).
- UI: project card shows "N input materials"; overview page header lists file names; files themselves are readable in "Deliverables → Workspace Files".
- Real-model end-to-end test: upload the business rules "Late fee 0.50 per book per day / deposit 100" → the requirements deliverable actually includes that rule (asserts `0.50|30%|deposit|5 books`).

## Source code module (left tree / right preview+edit, height-adaptive)

The sidebar "Source Code" (shortcut `5`, after "Deliverables") is a **dedicated module for browsing produced code**: collapsible directory tree on the left, preview/edit on the right.

- **Only lists produced code**: `isSource()` (`public/tree.mjs`, pure function) only recognizes code extensions, excluding `docs/` stage documents, `inputs/` materials, and dotfiles like `.DS_Store`. Your workspace often has 50 files, half of which are documents — "Deliverables → Workspace Files" is the **disk truth** (lists all), while "Source Code" is the **deliverable view** (only code).
- **With ownership info**: after selecting a file, the right panel metadata shows: owning module / architecture layer / code location / module status / that module's unit test `PASS/FAIL/exit_code` / test file path. This is the "final output" key — see the code and whether its tests passed together.
- **Right panel editable**: modules that are not yet approved can be edited and saved (after saving, that module's real unit tests are auto-rerun); approved modules show "Approved · Locked" read-only.
- Both views share the same rendering (`codeBrowser()` + `codeGrid()`), so subdirectory folding, indentation, file size, and lock rules are fully consistent.
- Small fixes: workspace list filters dotfiles (Finder's `.DS_Store` is no longer a node); defaults to opening the **first source file** rather than the last in the list.

### Height-adaptive (wide-screen column self-scroll / narrow-screen page scroll)

- Wide screen (>1120px): `.app` fixed at `100vh` → `.page` is a flex child → `.grid.g-tree` takes the remaining height (340px floor), each card has `display:flex` column layout, **card body `overflow:auto`** — directory tree and source area each have their own scrollbar; the page itself doesn't scroll. Card header and footer don't participate in scrolling (`flex:0 0 auto`).
- Source preview's `max-height` is all removed (originally `<pre>` was locked at 68vh): height is set by the card, `overflow` is set by CSS — change once, both views benefit.
- Narrow screen (≤1120px): three columns collapse to one, **height no longer tied to the window** (otherwise three cards are crammed), each column limited to `58vh` and self-scrolls, and the whole page scrolls.
- Verification (`tools/ui_tree.mjs` `[5]`/`[6]`): short window 1440×520 asserts "document does not scroll (520≤520) + card bottom 482≤520 + two columns `overflow:auto` + directory tree 738>305 emits scrollbar + source area 526>265 emits scrollbar"; narrow window 900×700 asserts "document does not scroll + page area self-scrolls 1409>658 + single column + no horizontal overflow + card min 336px". Screenshots `out/21-code-fit-short.png`, `out/22-code-fit-narrow.png`.
- **Scrollbar must be visible**: `overflow:auto` on macOS uses overlay scrollbars — hidden when not scrolling, the user can't tell "there's more below". `public/app.css` draws always-visible thin scrollbars uniformly: `::-webkit-scrollbar` (Chromium/Safari, 10px, `--line-2` thumb, hover → `--accent`) + `scrollbar-width/color` (Firefox, yielding to `@supports selector(::-webkit-scrollbar)` so Chromium doesn't fall back to overlay); both columns add `scrollbar-gutter: stable` to avoid jitter. UI check `[7]` asserts "two columns `offsetWidth - clientWidth ≥ 8` (scrollbar actually takes space = visible) + adding the scrollbar doesn't introduce horizontal overflow", screenshot `out/21-code-fit-short.png`.
- **Overview, Workflow & Gates, Development, Project pages also fill the window** (`g-fill`): the rule `.grid:is(.g-tree, .g-fill)` is used by "Project page (project list + new form)", "Overview (stage pipeline + activity stream)", "Workflow & Gates (stage detail + stage deliverables)", "Development tab (module dev + module detail)", "Task tree" — the grid takes the page's remaining height, each card self-scrolls via `overflow:auto`, the page itself doesn't scroll; activity stream shows the latest **60** entries (was 14, the card was taller and not filled). **Development stage is an exception**: when the Workflow page selects "Development", the module-dev block must follow the two cards, so the upper grid is not `g-fill` (whole page scrolls), and the module-dev block brings its own `g-fill` to take the remaining height. On narrow screens everything collapses to a single column, each column `max-height:58vh` and self-scrolls, and the whole page scrolls again; the single-card fill grid (task tree) also fills normally on narrow (`g-fill:has(> .card:only-child)`). Verification: UI checks `[8.8]`~`[8.11]` (overview / workflow / dev + task tree / project page), each with 1000 and 1400 height levels + narrow-screen assertion set; screenshots `out/29-overview-fill.png`, `out/30-dev-fill.png`, `out/32-projects-fill.png`, `out/33-wbs-tree-fill.png`.
- Tall screens should grow with the window (`[7.5]`): the left column card body has a `tablewrap` class, and `.tablewrap` has `max-height:460px` — no matter how tall the window, the directory tree caps at 460px, leaving a big blank inside the card. Adding `.grid.g-tree > .card > .body.tablewrap { max-height:none }` fixes it (source and deliverable pages share the skeleton). Tall window 1440×1200 asserts "tree height 983px (breaks 460) + card - card header - tree = blank ≤2px + card height tracks the window", screenshot `out/24-code-fit-tall.png`.

### Edit & save (tested chain)

The UI check really walks through "click ✎ Edit → modify content in the textarea → click Save", then asserts:

- The file read back from the API **contains** the change, and the disk file `workspace/<id>/<path>` does too (not just in-memory);
- After save, the **right preview immediately shows the new content** (there was a bug here: `refreshWorkspace` only refreshed the file list, preview stayed on the old text; fix is to call `openFile()` again to read back after save);
- The module's **real unit tests are auto-rerun**, and the record timestamp is refreshed (`node --test test/…`), with a popup "Saved and module unit tests re-run: PASS=6 FAIL=0 exit_code=0";
- The module is **not treated as approved** (still `awaiting_review`) — modified code must pass the gate again;
- **Approved modules are locked**: the UI no longer shows the edit button, shows "Module approved · locked", and bypassing the UI to `PUT` is also rejected with `409` by the server (`"Base utilities" is approved, content locked; to modify, please reject and redo`).

## Source file browser (left tree / right preview+edit)

"Deliverables → Workspace Files" is a **source code browser**: a collapsible **directory tree** on the left, preview and edit on the right.

- The tree is a pure-function product: `treeRows(paths, open)` in `public/tree.mjs` folds flat `paths` into a "row list" (directory rows carry `depth/count/open`), and the front-end just `map`s to HTML — so it can be asserted directly by `node --test` (`test/tree.test.mjs`, 4 cases: multi-level nesting / CJK order preserved, default expand and collapse, same-named directories each as their own node, empty and duplicate paths).
- Directory rows show recursive file count; click to fold/unfold (`S.wsOpen[dir] = false` means folded; default expanded). File rows show byte count; click to preview the **really-on-disk** content on the right.
- Right side: `.md` renders as text, code goes through `<pre>`; unapproved modules can click "✎ Edit" to modify source and save (after saving, that module's real unit tests are auto-rerun, see previous section); approved-locked is read-only.
- Trigger loading: switching to this tab fetches the file list; deep links (`?view=artifacts&arttab=files`) also auto-fetch (otherwise the left tree is empty).
- Verification: `node tools/ui_tree.mjs` (self-contained: self-starts isolated service + headless Chrome) asserts tree structure, zoom behavior, preview matches API byte-for-byte, edit state is usable, and asserts **no uncaught exception on the page** (a module load failure will blank the entire page; this rule catches it). Already merged into `run_all.sh`, screenshots `out/17-workspace-tree.png`, `out/18-workspace-edit.png`.

## Dynamic Visualization

- The server splits execution into paced steps, pushed to the UI via **SSE (`/api/stream`)**; stage pulses, progress, and event stream refresh in milliseconds.
- Views: **Project Entry / Overview / Workflow & Gates / WBS & Development / Deliverables / Source Code / Run Log / Skills**, shortcuts `1–8` (by **menu position**, not hard-coded: reordering the menu moves the shortcuts), `t` toggles theme, `d` toggles density.
- The "Deliverables" page can switch to **Workspace Files** to directly read the model-generated and on-disk code and unit tests.
- URL overrides (screenshots / sharing): `?view=flow&wbstab=dev&stage=wbs&project=<id>`.

## Project preview (running the workspace's site for real)

The platform itself acts as the preview server: `GET /p/<projectId>/…` → `workspace/<projectId>/…` (injects `<base href="/p/<id>/">` into `.html`, falls back to `index.html` when file not found; so deep links like `/p/<id>/course/xx` open correctly on refresh, and relative resources like `./app.mjs`, `./src/**` in the page still resolve).

- Prerequisite: the workspace needs a site shell `index.html` (the `website` type's deliverables only contain `src/**` modules and tests, the shell must be added — this repo's example `workspace/P-mv4potv1-sw14/index.html` + `app.mjs` assembles `content`-layer data into the `app` layer's `{courses, glossary, quizzes}` and hands it to `start()`).
- Mount prefix handled by the shell: `app.mjs` recognizes `/p/<id>` from `location.pathname`, and the rendered root path links get the prefix prepended (the `app` layer's `href="/course/xx"` would otherwise point to the platform root).
- Verification: `node tools/preview_check.mjs <projectId>` (self-starts headless Chrome/CDP, polls each page for "content mounted" then asserts: non-empty render / **no uncaught exceptions** / all root-path links carry the prefix, screenshots saved to `/tmp/preview-shots/`). Don't use `chrome --dump-dom` — it dumps before module scripts finish, randomly catching only the empty shell.

## API

```
GET    /api/state                                    All state + current model channel
GET    /api/stream                                   SSE real-time events
POST   /api/projects                                 Create project (initial entry)
GET    /api/projects/:id/workspace                   Real workspace file list
GET    /api/projects/:id/file?path=src/x.mjs         Read real file contents
PUT    /api/projects/:id/file                        Modify workspace file (code files auto re-run unit tests)
POST   /api/projects/:id/artifacts/:aid              Modify deliverable text (409 if approved)
DELETE /api/projects/:id                             Delete project (also deletes workspace; 409 if running)
POST   /api/projects/:id/models                      Define per-stage model (empty string = default deepseek)
POST   /api/projects/:id/skills                      Add skill {name, body, stage?} (empty stage = all stages)
PUT    /api/projects/:id/skills/:sid                 Modify skill (any of name/body/stage)
DELETE /api/projects/:id/skills/:sid                 Delete skill (404 if missing)
POST   /api/projects/:id/stages/:sid/{run|approve|reject}
POST   /api/projects/:id/modules/:mid/{run|approve|reject}
```

## Per-stage model (unconfigured = default DeepSeek)

Each stage can specify its own model; **unconfigured stages use the default** (`AI_PLATFORM_MODEL`, default `deepseek-v4-flash`):

- UI: "Workflow & Gates" → click a stage node → the "Called Model" dropdown in stage detail (default / `deepseek-v4-flash` / `deepseek-reasoner`). Changes take effect immediately, applied to the stage's **next** call (dropdown disabled while a stage is running).
- API: `POST /api/projects/:id/models`, body `{"models":{"wbs":"deepseek-reasoner"}}`; empty string removes that stage's setting (back to default); only the 8 stage ids in the pipeline are recognized, unknown ids and blank values ignored. New projects can also carry the `models` field directly.
- Scope: Requirements / UI-UX / Architecture / Integration test / Deployment / Operations → each deliverable in that stage; WBS → Epic/Task breakdown; Module development → all Dev Agents' code and unit test generation.
- Approved stages and completed modules' history is unaffected; the event stream carries a "Stage called model: X default deepseek-v4-flash → custom …", and each round's events also mark the model used in that round.

## Skill library (each stage can have its own skill docs)

The sidebar "Skills" = current project's skill docs: write engineering conventions (prohibitions / specs / acceptance criteria) as entries, **and they get attached to every subsequent model call**.

- **Scope**: `stage` empty = all stages; pick a stage = only that stage's calls include it (e.g., "test files must mirror to `test/<layer>/`" only appears during module development).
- **Injection point** (`skillsBrief(project, stageId)` in `agent.mjs`): each stage's deliverables (filtered by current stage), WBS breakdown (`wbs`), module code and tests (`development`); when no skills exist, no prompt fragment is generated.
- **Priority (platform-wide rule)**: **workspace-generated project skills > project skill library > platform defaults** — written in the prompt fragment, conflicts follow the higher-priority one (when conflicting with a stage's hard requirements, the stricter one wins). The preset skill library (`skills/<name>/SKILL.md`) is just templates and must be explicitly imported into a project to take effect.
- **Workspace-generated project skills (defined in the generated project itself)**: put skills in the **generated project's own workspace** `workspace/<projectid>/skills/<name>/SKILL.md` (same AI Agent Skills standard format, directory name = `name`, `metadata.stage` optional); the platform will **prioritize** them:
  - **Scan timing**: refreshed before every model call (stage execution, each module dev) — workspace skills **follow the disk, never persisted, never copied**, editing the file takes effect immediately; set changes are accounted for in the event stream ("This project has N workspace-generated skills… → takes priority over project skill library and platform presets").
  - **How "priority" works**: injection order is first + each entry is tagged "(This project's workspace-generated · priority)" + the fragment header states the three-level priority — the budget is truncated in order, so they will never be dropped first; `stage` filtering still applies (a `stage: deployment` skill only appears in deployment-stage calls).
  - No `skills/` in the workspace ⇒ all unchanged (no extra prompt fragment). **No** editing them in the UI (they are generated artifacts — modify via the source viewer/editor).
- **Limits**: skill name ≤60 chars, body ≤4000 chars, ≤60 skills per project; single injection capped at 18000 chars (≈6k tokens), entries are truncated in order and "N entries not injected" is noted in the fragment.
- **UI**: narrow left column (`minmax(300px,400px)`) listing each row: ordinal / **skill name and workflow node stacked in the same column** (`.nmcol`, node carries the workflow ordinal) / edit / delete; list **sorted by workflow ordinal** ("All Stages" first, then by `p.stages` order → skill ordinal); body not laid out in the list, kept in hover `title` and right-side form; right-side form + preset library take the rest of the width; form is draft-style (`SKDRAFT`), SSE refresh and re-render don't swallow in-progress input.
- **API**: `POST /api/projects/:id/skills` (`{name, body, stage?}`), `PUT …/skills/:sid`, `DELETE …/:sid`, ** `POST …/skills/delete` (`{ids:[…]}` batch delete, single event accounting, missing ids ignored)**; unknown stage id falls under "All Stages", empty name/body returns 400, missing returns 404.
- **Batch delete** (used to clean up after importing a bunch of presets): each row has a checkbox (state in `SKPICK`, SSE re-render doesn't lose it, missing ids auto-cleaned on delete/switch project) + card header "Select all / Clear all" and "✕ Delete selected (N)" — disabled when none selected, `confirm` before deletion.
- **Proof**: unit tests (CRUD / limits / stage filter / mock model server asserts **the request body really carries the skills**) + e2e `[2d]` (HTTP round-trip + validation) + UI check `[8.12]` (actually click button → really persist → really modify → really delete, including "draft still there after SSE re-render"), screenshot `out/34-skills.png`.

### Preset Skill Library (33 local in `skills/*.md` + 25 upstream in `vendor/agent-skills` = 58, by stage)

**Upstream skills (`vendor/agent-skills`, MIT, Addy Osmani's agent-skills)**: not the original text, only "executable three sections" extracted.

- **Why extract**: a single upstream `SKILL.md` averages 13.7KB (max 21KB), bigger than this platform's **single-injection budget** (`agent.SKILL_PROMPT_MAX = 18000` chars); and this platform makes "one-shot final draft" calls — the upstream's "commit per task / open browser devtools" steps can't run here — only the constraint sections apply.
- **What to extract**: 24 of 25 upstream skills have `## Verification` / `## Red Flags` / `## Common Rationalizations` (acceptance criteria, red flags, anti-rationalization table); cut to per-entry cap (800–1200 chars) by this priority; one without them (`using-agent-skills`) falls back to per-section truncation.
- **How it lands**:
  - `bash tools/vendor_agent_skills.sh` one-shot `git clone --depth 1` to `vendor/agent-skills/`, write the commit to `vendor/agent-skills/SOURCE` (use `--update` to refresh); **the platform is fully offline after that**.
  - `AGX_MAP` in `harness.mjs` (upstream skill → platform stage + cap, 25 rows, one-to-one) → `agxSlice()` extracts and truncates sections → `agxCatalog()` produces `{ id: 'agx-<upstream-name>', name: 'Upstream spec · <upstream-name>', stage, body: '(Excerpted from upstream addyosmani/agent-skills@<sha8>: <name> | full text …)' + slice }`, and joins `skillCatalog()`.
  - **What is imported is the slice text (a copy), not a reference**: deleting the vendor directory later doesn't affect already-imported skills; the body records which commit it came from, for traceability.
  - To change which sections/caps are extracted: only edit `AGX_SECTIONS` and `AGX_MAP`.
- **Type pack attachment** (`TYPES[].skills`): webapp +`agx-code-review-and-quality`/`agx-test-driven-development`; website +`agx-frontend-ui-engineering`/`agx-performance-optimization`; service +`agx-security-and-hardening`/`agx-observability-and-instrumentation`; cli +`agx-debugging-and-error-recovery`; data +`agx-incremental-implementation`/`agx-performance-optimization` (one-click import on Skills page "⬇ Type skill pack", `checkTypes()` validates the id really exists in the library).
- **Self-check**: unit test "Upstream skills (vendor/agent-skills): map matches, slice within budget, no vendor dependency after import" — map matches upstream 25 directories **one-to-one (no more, no less)**, each slice ≤ cap, has content, stage valid, name carries "Upstream spec ·" origin, can join the preset library, type pack ids all in the library, import is ≤1400 chars, and **a full type-pack import keeps single-injection ≤18000 for the development stage without upstream skills being dropped** (tested 14,664 chars / 8 entries).
- **Won't do** (YAGNI): upstream `commands/` (9 slash commands; the platform's stages + gates are the orchestrator), `evals/` (for host skill routing evaluation; the platform has its own `run_all`), `hooks/`, and the per-host adapter directories (`.claude/.codex/.gemini/…` only serve the host).
- Upgrade upstream: `bash tools/vendor_agent_skills.sh --update` → SHA changes; if the unit test reports "map doesn't match upstream directories", add/remove the corresponding `AGX_MAP` rows.


**Local skill standard format (AI Agent Skills / [agentskills.io](https://agentskills.io) spec, same as `vendor/agent-skills`)**: each skill is a directory `skills/<name>/SKILL.md` (directory name = `name` in frontmatter, lowercase-hyphen):

```yaml
---
name: dev-nodejs                                  # Standard field: must equal the directory name
description: Module-development conventions for Node.js. Used when the development stage generates module code under the Node profile; not for Java/Python profiles.
metadata:                                         # Platform extensions go here (spec-allowed landing point)
  stage: development                              # This platform: only inject in this stage ("" = all stages)
  tech: nodejs                                    # This platform: tech-stack tag (UI / type-pack filter)
  label: Module Development · Node.js Conventions    # This platform: UI display name
---
# Module Development · Node.js Conventions

## Overview          ← What this skill solves and why it must be followed
## When to Use       ← Applicable / not applicable (this platform injects 100%, so 2 lines only)
## Core Process      ← Real rules: facts, commands, `code snippets`, cross-skill references
## Common Rationalizations  ← Table: excuse | fact (prevents the model finding reasons to skip)
## Red Flags         ← Observable violation signals
## Verification      ← Checkboxes: exit conditions provable by evidence (`node --test`, gates, deliverables)
```

- The six sections are the **spec-recommended fixed order** (`SKILL_SECTIONS` in `harness.mjs`); unit tests verify them in order (directory name = name, only name/description/metadata at the top, description ≤1024 and "when to use" wording, anti-rationalizations as a table, verification as checkboxes, ≤500 lines).

- **Naming rule (spec hard requirement)**: directory name = `name` = **ASCII lowercase-hyphen** (e.g., `architecture-security-design`, `env-bootstrap`); Chinese display name goes in `metadata.label`, UI and prompts use the Chinese name — Chinese directory names will be rejected by upstream validators.
- **Description bilingual**: in Chinese write "what it does + use when …; not for …", end with an English `Use when …` (the spec's trigger wording, the only one upstream validators accept).
- **Self-check runs upstream's reference validator directly**: unit tests `createRequire` load `vendor/agent-skills/scripts/lib/skill-lint.js` (upstream's `scripts/validate-skills.js` calls it), demanding **0 errors / 0 warnings** for all 33 skills (including "cross-reference points to non-existent skill" warnings) — harder than writing our own assertions. `vendor/agent-skills/package.json` explicitly declares `{"type":"commonjs"}`: upstream repo has no `package.json`; this project is `type: module`; without the declaration, CJS under `scripts/` would be parsed as ESM and `require` would get an empty object.
- **Platform extensions only go in `metadata`** (`stage` / `tech` / `label`): top-level keys are reserved by the spec; `skillCatalog()` only reads these three, the rest of the body is injected whole.
- This platform **doesn't do on-demand loading** (skills are injected into the prompt unconditionally), so keep the body tight: Overview/When to Use 1–3 lines each, focus on Core Process and the three-judgment sections — single-injection budget 18000 chars (`agent.SKILL_PROMPT_MAX`, ≈6k tokens, enough for the 8–10 entries a type brings).
- Add a skill: create `skills/<id>/SKILL.md` following the six sections, **no code change needed** (`skillCatalog()` scans the directory); to attach it to a type pack, add the id to `TYPES[].skills` (`checkTypes()` validates it really exists in the library).
- UI usage: right "Preset Library → Import selected scope" one-click into the project (re-import auto-skips, over-cap auto-skips with explanation, can be modified/deleted); dropdown has two groups — **by scope** (all / per-stage general / per-stage) and **by skill** (option text = `stage-ordinal_stage-name_skill-name`, e.g., `01_Requirements_Requirement IDs and Acceptance`; no-stage shows as `All Stages_Environment Bootstrap`); selecting one imports just that one.

| Stage | Skills |
|---|---|
| All stages | `security-baseline` · `env-bootstrap` (self-install if no environment) |
| Requirements | `requirements-ids-and-acceptance` · `requirements-nonfunctional-metrics` · `requirements-interview-and-conflict` |
| UI/UX | `ux-information-architecture` · `ux-usability-checklist` · `ux-accessibility-and-copy` |
| Architecture | `architecture-layering-contracts` · `architecture-data-consistency` · `architecture-security-design` |
| WBS | `wbs-module-granularity` · `wbs-estimate-and-dependencies` |
| Development | `development-general-conventions` (includes **naming rule: business semantics first, no WBS serial in file name**) · `development-review-checklist` · `dev-code-layout` (code directory and naming details: no per-module subdirectory) · 7 stack-specific entries: `dev-nodejs` · `dev-java-springboot` · `dev-java-struts` · `dev-sap-cap-rap` · `dev-python` · `dev-static-site` · `dev-react-vite` |
| Integration testing | `testing-coverage-matrix` · `testing-case-design` · `testing-perf-and-security` |
| Deployment | `deployment-release-and-rollback` · `deployment-config-and-secrets` · `deployment-pipeline-and-canary` |
| Operations | `operations-monitoring-runbook` · `operations-incident-response` · `operations-backup-and-restore` · `operations-cost-and-capacity` |

Highlights per file (a few representatives):

- `dev-java-springboot`: controller/service/repository/domain layering, DTO and entity separation, constructor injection, transactions only in public service methods, `@ControllerAdvice` + error code enum, `BigDecimal` / `java.time`, slice tests.
- `dev-java-struts`: stateless Actions, `PreparedStatement`, transactions in Service, PRG, OGNL escaping, Struts2 CVE version policy.
- `dev-sap-cap-rap`: CDS modeling (managed/unmanaged, monetary semantics), service projection with `@restrict`, handlers do orchestration only, draft timing, RAP behavior definition + EML, dual-stack consistency.
- `dev-python`: layering and type annotations, forbidden mutable default arguments, exception hierarchy, `Decimal`/tz-aware, pytest parametrize, logging.
- `development-general-conventions`: business semantics first in naming, **no WBS serial in file name** (`M1`/`E2`/`T3` are platform-internal tracking ids, never in deliverables).
- `dev-code-layout`: source goes directly under the layer directory, **don't create a per-module folder**, use business names (`OrderService.java` / `order-service.mjs` / `order_service.py`), same-layer flat layout, no duplicates; the platform detects rule deviations.
- `dev-static-site` (static site): executable form = template pure function + content data → HTML string (executor has no npm/bundler, CSS and build tools are documented); focus is **escape = security**, the routing table is the only source of truth, deliverables are assertable (title/description/canonical/alt/heading levels).
- `dev-react-vite` (React + Vite static site): the platform has no npm/Vite, doesn't recognize JSX (`node --check` will treat it as a syntax error) → views use `h(type, props, ...children)` element objects (compatible with `React.createElement`, can actually run and assert), JSX components / `vite.config` / `public/` / build hosting go into documentation; reducer + routing table + element objects are the test target, `base` subpath, `VITE_` variables and secret restrictions go into deployment docs.
- `env-bootstrap` (all stages): self-install and configure when there's no environment (probe → install → re-probe → only fail when installation fails; failures must be actionable); "self-install" means the runtime, dependencies in deliverables still follow the architecture spec.
- `architecture-security-design`: authentication and authorization are separate, each interface labels roles and data scopes, input boundaries, secret management, audit logs, dependency vulnerability response.
- `operations-incident-response`: P0/P1/P2 tiers with time limits, stop-loss → locate → fix → verify, timeline records, 48h post-mortem with improvement items and owners.

> Note: the platform determines the **language profile** from the project's tech stack and actually runs the corresponding toolchain — `Node.js` → zero-dependency ESM + `node --test`; `Java/Spring Boot/Struts2` → `javac`+`java` (JDK standard library only, no Maven repo); `Python` → `python3` + standard library `unittest`; `SAP CAP (+Java)` → Java as above + real CDS files (`db/schema.cds`, `srv/*.cds`, structural validation; only with `@sap/cds-dk` does it actually `cds compile`). Framework-specific writing (Spring annotations / Struts2 Actions / CAP Handlers / Django views) is in the architecture, deployment, and migration docs — the boundary is stated at the top of each stack spec file.
> Prompt budget: the skill fragment for a single injection is capped at 18000 chars (≈6k tokens); entries beyond the cap are truncated and "N entries not injected" is noted in the fragment — never silently dropped.

## Architecture stage defines the code structure (layer-based organization)

The architecture stage not only writes docs — it also **defines the source directory structure** that WBS and code generation follow:

- **If the tech stack has an input, use it; if not, let the model pick** — write that choice into ARC-01's structured declaration, which the platform parses into `project.arch.stack` and passes as fact to downstream stages (WBS prompt, code prompt both use it).
- The fixed-format json block in ARC-01's body is the only contract:

  ```
  {"stack":"Node.js ESM + node:test (zero third-party deps)","layers":[{"dir":"core","responsibility":"…"},{"dir":"service","responsibility":"…"}]}
  ```

  If parsing fails or layer names are illegal → fall back to platform default `core / domain / service / api` and **mark "rules from platform default" in the event stream** — the pipeline isn't blocked.
- **One Epic = one module = a set of business-named files (no per-module directories, no WBS serials in file names)**: WBS gives each Epic its own `layer` (must be from the declared list, illegal value falls back by order), the module directory is the layer directory `src/<layer>` (Java `src/main/java/<layer>`); **don't create "module-named folders", and file names don't carry `M1`/`E2`/`T3` serials** — the name is decided by "what the module does" (`OrderService.java` = public class name / `order-service.mjs` / `order_service.py`), tests mirror source by business name under `test/<layer>/order-service.test.mjs` (`src/test/java/<layer>/OrderServiceTest.java`). Same-layer name collisions: pick a more specific business name; if there's a real collision the platform reports "name collision with other module in same layer, will overwrite each other" in the event stream.
- **On-disk placement validation**: after writing, check each file is in `mod.dir/` (that one layer), file name is business-semantic (extra subdirectory or names starting with `M1`/`m1_` WBS serials are deviations), events are emitted for deviations; the module deliverable header fixed writes **Architecture layer** / **Code location** / **Test location**, with the real delivered files and line counts listed below — "deliverable records code location" is therefore assertable.
- UI: the "WBS / Development" page header shows the rules (tech stack + layers + source); module details show architecture layer / code location / test location.

## UI Adaptation

- Layout adapts to screen width: ≥1560 three columns full width; ≤1360 starts narrowing KPIs and multi-columns; ≤1120 multi-columns collapse to a single column, left rail keeps only the mark block, module table hides secondary columns; ≤820 KPIs in a single column.
- The project brief in the card **wraps by width** (max 3 lines, full content in `title`), no longer cut in half by a fixed height.
- Projects can be deleted directly on the card (native confirmation; also deletes `workspace/<projectID>/`; 409 if running).

## Directory

```
ai-platform/
├── server.mjs         Zero-dependency HTTP: static + REST + SSE
├── harness.mjs        Delivery state machine: stages / gates / WBS / modules / unit-test rules / persistence
├── agent.mjs          Real-model channel (OpenAI-compatible, default DeepSeek) + prompt and output validation
├── exec.mjs           Real execution layer: workspace writes + per-language-profile real runs (node --test / javac+java / python3 unittest) + CDS structural validation
├── sim.mjs            Offline template channel (only when AI_PLATFORM_PROVIDER=sim)
├── skills/*.md        Preset skill library (one per stage + stack-specific for development), front matter: name/stage/tech
├── setup/             Install/config: install.sh (check/install/configure/verify/start/status/stop) + README.md
├── public/            index.html · app.css · app.js
├── workspace/<projectId>/  Real code and unit tests generated by the model (deletable)
├── data/projects.json   Runtime state (deletable)
├── test/harness.test.mjs State machine and real-execution unit tests (node --test)
├── tools/e2e.mjs      Offline end-to-end (actually starts the service + runs code, sim channel)
├── tools/e2e_live.mjs Real-model end-to-end (requires Key)
├── tools/run_all.sh   Acceptance entry point
└── tools/shot.mjs     Pure Node CDP screenshots (requires self-started Chrome debug port)
```

## Verification

```bash
bash tools/run_all.sh            # Offline: 27 unit tests + 64 HTTP end-to-end + 65 UI checks, FAIL=0
bash tools/run_all.sh --live     # Add real-model end-to-end (requires Key + network)
```

Requires Node ≥ 20 (the screenshot script uses built-in `WebSocket`, needs ≥ 22).
