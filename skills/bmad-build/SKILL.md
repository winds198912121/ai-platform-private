---
name: bmad-build
description: BMAD-style code build — produce source files + unit tests for a single module in one JSON pass. Each module must include both files and a test block; the test is run for real by exec.mjs. Do NOT apply to multi-module refactors or to configuration-only changes.
metadata:
  stage: development
  tech: ""
  label: BMAD · Module Build (code + tests, single pass)
---

# BMAD · Module Build

## Overview
For each module the WBS (or DevFlow auto-WBS) gives you, produce source files + unit tests in a single JSON pass. One pass = one module = one artifact with files[] and test{}.

## When to Use
- Apply: each module in `p.modules` when running the Development stage.
- Do NOT apply: cross-module refactors (handle those as a separate spec), config-only changes (no module).

## Core Process
1. Read the module spec: id, name, goal, layer, dir, test_path_planned, tasks[], skills.
2. Read the project's tech stack from `project.arch.stack` and pick the language profile.
3. Output **only JSON** with:
   - `summary` — one sentence about what the module does
   - `files[]` — source files with `path` (under the layer dir, business-named, no WBS index) and `content`
   - `test` — `{ path, content }` for the unit test, in the right place, named after the business entity
4. Follow the platform rules:
   - **Zero third-party deps** unless registered in the architecture doc
   - Business-semantic names: `OrderService.java` / `order-service.mjs` / `order_service.py` — no `M1`/`E2T1`
   - Tests cover normal + boundary + error branches with specific assertions
   - Functions are pure (no `Date.now()` / `Math.random()` / global state — pass them in)

## Common Rationalizations
| Excuse | Fact |
|---|---|
| "Skip the test, just ship the code" | Without tests, the gate refuses to approve the module. |
| "Use a popular third-party lib" | If it's not in the architecture, exec.mjs will fail to load it. |
| "File name = `M1OrderService.java` for clarity" | WBS index is internal; goes into the event log, not the deliverable. |

## Red Flags
- Module's `test` field missing or empty.
- Files placed outside the layer directory.
- File names include WBS index (`M1…`, `E2T1…`).
- Imports / requires that aren't in the architecture's stack.
- Tests cover only the happy path.

## Verification
- [ ] JSON parseable, has `files[]` (≥1) and `test.content`.
- [ ] All paths under the module's layer dir + test path.
- [ ] Names are business-semantic; no WBS indices.
- [ ] Stack matches architecture; no unregistered deps.
- [ ] Tests assert specific values, not just truthiness.
- [ ] `exec.mjs` real-runs the test and gets `FAIL=0`.