# Platform Guide

[Project overview](../README.md) · [Setup and configuration](../setup/README.md)

This guide explains workflow options, execution rules, generated files, skills, and the API. Start with the project overview for installation and architecture diagrams.

## Create a project

Enter a name and brief, choose a software type and technology stack, and select a workflow and execution mode. You can also attach input files and configure models for individual stages.

| Software type | Default workflow | Default source layers |
|---|---|---|
| Web app | `full` | `core / domain / service / api / ui` |
| Website | `website` | `core / content / ui / app` |
| Back-end service | `service` | `core / domain / api / repo` |
| Command-line tool | `lean` | `core / cli / io` |
| Data project | `data` | `core / io / transform / report` |

The type supplies workflow defaults, stack suggestions, source layers, and a skill pack. You can override the workflow when creating the project. Import the type's skill pack from the **Skills** page to activate its rules. The project editor supports changes to its name, brief, technology description, and execution mode.

### Workflow presets

| ID | Stages |
|---|---|
| `full` | Requirements → UI/UX → Architecture → WBS → Development → Testing → Deployment → Operations |
| `lean` | Requirements → Architecture → WBS → Development → Testing |
| `prototype` | Requirements → UI/UX → WBS → Development |
| `change` | Requirements → WBS → Development → Testing → Deployment |
| `design` | Requirements → UI/UX → Architecture → WBS |
| `website` | Requirements → UI/UX → Architecture → WBS → Development → Testing → Deployment |
| `service` | Requirements → Architecture → WBS → Development → Testing → Deployment → Operations |
| `data` | Requirements → Architecture → WBS → Development → Testing → Deployment |

Workflows are defined in `harness.mjs`. Each is an ordered subset of the platform's stages. Any workflow containing development must also contain WBS, which defines the modules to build.

### Input materials

Attach up to 10 text files, with a maximum of 256 KB per file. Empty and binary files are skipped with an explanation in the activity log. Files are stored in `workspace/<projectId>/inputs/`; excerpts are included in planning prompts.

## Review and execution rules

- Stages run in order. A later stage cannot run until the previous stage is approved.
- In `human_gate` mode, completed stages and modules wait for review.
- A module cannot be approved without recorded unit tests, passing results, and a zero exit code.
- Rejection sends a reason category and comment back to the model for regeneration.
- In `auto` mode, the platform approves completed steps automatically; test requirements still apply.
- Development completes when every module has been approved.

These rules are enforced by the server. Invalid transitions return HTTP `409`.

Development uses three concurrent agent slots by default. Set `AI_PLATFORM_CONCURRENCY` to a value from `1` to `8`. In parallel mode, review order is flexible. With concurrency `1`, the previous module must be approved before the next module starts.

### Tests and deployment checks

Module tests run against generated files in the project's workspace. Results include pass/fail counts, exit code, elapsed time, and captured output. Missing runtimes and failed test execution are reported as failures.

Integration testing runs the workspace's test suites. The deployment stage adds syntax/build validation and release documentation. External hosting and infrastructure deployment follow the generated project's release instructions.

### Edit and rebuild

Use **Deliverables** to edit documents and **Source Code** to browse generated code with its owning module and test results. Saving module code reruns its unit tests. Approved content is locked; reject it before revising it.

**Rebuild** clears the project's generated outputs, workflow history, and review state while preserving its skills and input materials. Rebuilding or deleting a running project is blocked unless forced through the API.

## Language support

The executor infers a language profile from the architecture's declared stack, then the project's technology description. Unrecognized stacks default to Node.js.

| Profile | Execution | Generated paths |
|---|---|---|
| Node.js | `node --test` | `src/<layer>/*.mjs`, `test/<layer>/*.test.mjs` |
| Java | `javac`, then Java test classes | `src/main/java/<layer>/*.java`, `src/test/java/<layer>/*Test.java` |
| Python | `python3` with standard library `unittest` | `src/<layer>/*.py`, `test/<layer>/*.test.py` |
| SAP CAP Node.js | Node.js tests and CDS validation | Node.js paths plus `db/schema.cds` and `srv/*.cds` |
| SAP CAP Java | Java tests and CDS validation | Java paths plus `db/schema.cds` and `srv/*.cds` |

The built-in executor targets standard-library modules. Framework integration, package installation, bundling, and hosting are covered by generated architecture and release guidance. Built-in CDS checks validate structure only. For compilation, install the SAP CDS development kit and run `cds compile db/ srv/` in the generated workspace.

Java module tests compile that module's own files. Integration checks compile the full Java workspace, where class names must be unique.

## Models and skills

### Model configuration

Configure connections in **LLM Providers**. Presets include OpenAI, Claude, DeepSeek, and MiniMax. Enter the API key, enable and save the provider, then select a default. OpenAI-compatible providers use `/chat/completions`; Anthropic providers use `/v1/messages`. Settings are stored locally in `data/settings.json` and are excluded from Git.

Selection priority is the project's stage-specific provider/model, then an enabled saved default provider with a key, then the environment fallback. The environment fallback requires both a key and `AI_PLATFORM_BASE_URL`; see the [setup guide](../setup/README.md#provider-settings).

To override a stage's model, use the model selector in **Pipeline & Gates** or send:

```http
POST /api/projects/:id/models
Content-Type: application/json

{"models":{"wbs":"deepseek/deepseek-reasoner"}}
```

An empty model value removes that stage's override. A change applies to the next model call. Offline mode uses `sim.mjs` templates instead of calling the model endpoint.

The interface supports Japanese and English, with Japanese as the default. Preset skills and generated templates use Japanese or English. Model prompts request Japanese prose and allow English technical terms and code identifiers.

### Project skills

Skills provide engineering rules for model calls. Scope each rule to one stage, or leave its stage empty to apply it throughout the workflow.

Priority is **workspace skills > project skill library > platform defaults**. The preset catalog contains local skills and excerpts from the bundled upstream library; importing a preset creates an editable project copy.

| Source | Location | Behavior |
|---|---|---|
| Workspace skills | `workspace/<projectId>/skills/<name>/SKILL.md` | Refreshed from disk before model calls |
| Project skill library | Managed in the dashboard | Editable copies, scoped by stage |
| Local presets | `skills/<name>/SKILL.md` | Available to import into projects |
| Upstream presets | `vendor/agent-skills/` | Selected sections extracted into the catalog |

Use the Agent Skills format with `name` and `description` front matter. Platform fields belong in `metadata`: `stage`, `tech`, and `label`. Local presets use these sections: Overview, When to Use, Core Process, Common Rationalizations, Red Flags, and Verification.

Project-library entries are limited to 60 per project, with names up to 60 characters and bodies up to 4,000 characters. The combined skill prompt is capped at 18,000 characters. Entries exceeding the remaining budget are omitted, with their count reported in the prompt fragment.

Refresh bundled upstream skills with:

```bash
bash tools/vendor_agent_skills.sh --update
```

The `SOURCE` file records the imported commit. Existing project copies remain usable after the vendor directory changes.

## Workspace layout

```text
ai-platform/
├── server.mjs              HTTP server, REST API, live events, and previews
├── harness.mjs             Workflow state, review gates, modules, and persistence
├── agent.mjs               Model calls, prompts, and output validation
├── exec.mjs                File writes, toolchain discovery, and test execution
├── sim.mjs                 Offline template generation
├── public/                 Dashboard UI and translations
├── skills/                 Local skill presets
├── vendor/agent-skills/    Bundled upstream skills
├── setup/                  Installation and server-management commands
├── docs/                   Platform documentation
├── test/                   Platform unit tests
├── tools/                  Verification, migration, and screenshot scripts
├── data/projects.json      Runtime state
└── workspace/<projectId>/  Generated project files
    ├── inputs/             Uploaded materials
    ├── docs/               Stage deliverables
    ├── skills/             Optional project-specific skills
    ├── src/                Generated source code
    └── test/               Generated tests (Java uses src/test/java/)
```

The architecture deliverable `ARC-01` can declare the stack and source layers in a JSON block. Downstream WBS and code generation follow that declaration:

```json
{
  "stack": "Node.js ESM + node:test",
  "layers": [
    {"dir": "core", "responsibility": "Shared utilities"},
    {"dir": "service", "responsibility": "Business logic"}
  ]
}
```

Each WBS epic becomes a module assigned to a layer. Files use business names such as `order-service.mjs`, `OrderService.java`, or `order_service.py`. Module IDs are tracking identifiers and do not become file names or directories.

### Website previews

The server exposes workspace files at `/p/<projectId>/`. A preview needs an `index.html` shell and its assets in the workspace. The server injects a base URL and falls back to `index.html` for deep links. Application-generated root links must include the preview prefix.

## API reference

All routes below are handled by `server.mjs`. Request and response bodies use JSON, except the event stream and website previews.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/state` | State, workflows, types, model channel, and runtime settings |
| GET | `/api/stream` | Server-sent progress events |
| GET | `/api/settings` | Read provider settings with masked API keys |
| GET | `/api/settings/enabled-models` | List enabled provider/model choices with configured keys |
| PUT | `/api/settings/providers/:id` | Save provider configuration |
| POST | `/api/settings/providers/:id/test` | Test a configured provider connection |
| POST | `/api/settings/providers/:id/clear` | Clear a provider's key and disable it |
| POST | `/api/settings/default` | Select the default provider |
| POST | `/api/projects` | Create a project |
| GET / PUT / DELETE | `/api/projects/:id` | Read, update, or delete a project |
| POST | `/api/projects/:id/activate` | Select the active project |
| POST | `/api/projects/:id/rebuild` | Reset generated outputs and workflow progress |
| POST | `/api/projects/:id/inputs` | Add input materials |
| POST | `/api/projects/:id/models` | Set stage-model overrides |
| GET | `/api/projects/:id/workspace` | List workspace files |
| GET | `/api/projects/:id/file?path=src/example.mjs` | Read a workspace file |
| PUT | `/api/projects/:id/file` | Save a workspace file; rerun module tests for code changes |
| POST | `/api/projects/:id/artifacts/:aid` | Edit a deliverable |
| POST | `/api/projects/:id/stages/:sid/run` | Run a stage |
| POST | `/api/projects/:id/stages/:sid/approve` | Approve a stage |
| POST | `/api/projects/:id/stages/:sid/reject` | Reject a stage with feedback |
| POST | `/api/projects/:id/modules/:mid/run` | Generate and test a module |
| POST | `/api/projects/:id/modules/:mid/approve` | Approve a tested module |
| POST | `/api/projects/:id/modules/:mid/reject` | Reject a module with feedback |
| GET | `/api/projects/:id/summary` | Read the project summary |
| GET | `/api/skills/catalog` | List skill presets |
| POST | `/api/projects/:id/skills` | Add a project skill |
| POST | `/api/projects/:id/skills/import` | Import preset skills |
| PUT / DELETE | `/api/projects/:id/skills/:sid` | Update or delete a skill |
| POST | `/api/projects/:id/skills/delete` | Delete selected skills |

## Verification tools

| Command | Purpose |
|---|---|
| `npm test` | Platform unit tests |
| `node tools/e2e.mjs` | Offline HTTP and generated-code checks |
| `node tools/ui_tree.mjs` | Browser checks; requires Chrome and Node.js 22+ |
| `bash tools/run_all.sh` | Combined offline verification |
| `bash tools/run_all.sh --live` | Add model-backed end-to-end tests; requires an API key and network access |
| `node tools/preview_check.mjs <projectId>` | Check a generated site's preview |

Test counts depend on the current repository version. Check the actual exit codes and reports rather than a fixed count in the documentation.
