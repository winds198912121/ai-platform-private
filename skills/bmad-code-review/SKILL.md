---
name: bmad-code-review
description: BMAD-style code review — review a module against the brief, architecture, and platform conventions. Look for: missing tests, naming violations, hidden state, dead code, security smells, scope creep. Do NOT apply to system-wide audits (use the retro); this is per-module.
metadata:
  stage: development
  tech: ""
  label: BMAD · Code Review (per-module)
---

# BMAD · Code Review

## Overview
Per-module review against three contracts: (1) the Brief (does it serve the goal?), (2) the Architecture (does it respect stack, layers, deps?), (3) Platform conventions (naming, tests, no hidden state). Output: list of issues grouped by severity.

## When to Use
- Apply: when a module is `awaiting_review`. Before approving.
- Do NOT apply: full system audit (that's bmad-retrospective); pre-coding design (that's bmad-architecture).

## Core Process
1. Read the module files + test + the brief + the architecture.
2. Run through checks:
   - **Brief fit** — does each function trace back to a task? anything off-scope?
   - **Architecture fit** — stack matches, layer rule respected, no unregistered deps
   - **Platform conventions** — business semantic names (no WBS index), tests cover boundary + error
   - **Code smells** — long methods, hidden state, swallowed errors, IO not injected
   - **Security** — auth on sensitive ops, no secrets in code, no `eval`/shell injection
   - **Performance** — hot paths not O(n²) on likely sizes, no N+1
3. Group findings: Blocker / Major / Minor / Nit. Blocker = cannot approve.

## Common Rationalizations
| Excuse | Fact |
|---|---|
| "It works, ship it" | Without review, the next module inherits the smell. |
| "Tests are for QA, not review" | Review's job is to verify tests are correct, not to replace them. |
| "Naming is bikeshedding" | WBS-indexed names break grep, refactor tools, and onboarding. Not bikeshedding. |

## Red Flags
- Function with no test, or test only covers happy path.
- `M1`/`E2T1` in any file name.
- Hidden global state, `Date.now()` in a "pure" function.
- Auth on a destructive endpoint missing or stubbed.
- Try/catch with no handling.

## Verification
- [ ] Each finding cites the file + line / symbol.
- [ ] Severity assigned; Blocker findings must be fixed before approve.
- [ ] Brief/Architecture alignment explicit (or absence noted).
- [ ] Re-review after fixes verifies the original concern is closed.