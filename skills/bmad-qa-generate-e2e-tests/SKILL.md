---
name: bmad-qa-generate-e2e-tests
description: BMAD-style end-to-end test generation — produce E2E test cases that exercise the full system across modules (not unit tests; use the module's own test). Run the full suite on the real workspace. Do NOT apply to single-module unit tests.
metadata:
  stage: testing
  tech: ""
  label: BMAD · E2E Test Generation
---

# BMAD · E2E Test Generation

## Overview
Generate end-to-end tests that exercise the system as a whole: happy-path user journeys plus critical cross-cutting scenarios (auth, error recovery, concurrency where relevant). Run them on the real workspace via exec.mjs. Unit tests belong to each module's own test, not here.

## When to Use
- Apply: Integration Testing stage (after all modules approved).
- Do NOT apply: per-module testing — that's the module's own test block (see bmad-build).

## Core Process
1. List the cross-cutting concerns: auth, error recovery, transaction boundaries, timeouts, idempotency.
2. Define 5–10 E2E scenarios that cover the happy path + each cross-cutting concern.
3. For each scenario:
   - Pre-conditions (state, fixtures)
   - Action (sequence of calls)
   - Expected outcome (specific assertion, not "should work")
   - Cleanup / isolation (so tests don't pollute each other)
4. Group tests by what they need: pure (no external), DB-backed, external-API-backed.
5. Run via `exec.runWorkspaceTests(root)` — read the real exit code; **FAIL=0 is the gate**.

## Common Rationalizations
| Excuse | Fact |
|---|---|
| "Unit tests cover everything" | Unit tests don't catch cross-module integration bugs; that's the point of E2E. |
| "E2E is too slow to write" | 5–10 well-targeted scenarios is enough; not 50. |
| "Just curl the running app" | Curl doesn't assert structure; tests do. |

## Red Flags
- E2E that only covers the happy path.
- Scenarios with no specific assertion ("the response should be good").
- Tests that depend on each other (one failing breaks the rest).
- Tests that mutate shared state without cleanup.

## Verification
- [ ] 5–10 scenarios covering happy path + cross-cutting concerns.
- [ ] Each scenario has pre-condition / action / expected outcome / cleanup.
- [ ] Tests grouped by isolation level (pure / DB / external).
- [ ] `exec.runWorkspaceTests` returns `PASS=0 FAIL=0` for the full suite.
- [ ] Re-runs after a deliberate bug give non-zero FAIL.