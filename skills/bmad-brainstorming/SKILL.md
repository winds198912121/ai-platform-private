---
name: bmad-brainstorming
description: BMAD-style brainstorming for the Requirements stage — generate divergent options (3–5 alternatives), converge to the strongest, surface hidden assumptions, capture rationale. Use when the brief is vague, requirements conflict, or scope is ambiguous. Do not apply to well-defined bug fixes or single-feature specs.
metadata:
  stage: requirements
  tech: ""
  label: BMAD · Brainstorming (diverge → converge)
---

# BMAD · Brainstorming

## Overview
Brainstorming precedes Brief: divergent thinking first (3–5 candidate approaches with trade-offs), then converge to the strongest path with captured assumptions. Goal is to surface hidden ambiguity before locking the brief.

## When to Use
- Apply: brief is vague, requirements seem to conflict, scope unclear, multiple stakeholders disagree on priority.
- Do NOT apply: well-defined bug fix, single feature with a clear spec, refactor with defined behavior.

## Core Process
1. List 3–5 distinct solution approaches; name each and give one-sentence essence.
2. For each, list 2–3 trade-offs (cost / complexity / time / risk / reversibility).
3. Surface hidden assumptions: "this assumes the user has X / the system must integrate with Y / the data exists in Z".
4. Pick the strongest approach (or hybrid) — explain why in 1–2 sentences.
5. Re-emit as a tightened 5–8 sentence narrative ready for the Brief.

## Common Rationalizations
| Excuse | Fact |
|---|---|
| "Just pick the obvious one" | The "obvious" path usually encodes an unstated assumption that bites later. |
| "We don't have time to brainstorm" | 10 minutes of diverging saves hours of rebuilding a wrong pick. |
| "Brainstorming needs a meeting" | Solo divergent thinking + 1 reviewer is enough; async notes count. |

## Red Flags
- Only 1 option listed — no real divergence.
- No trade-offs acknowledged — pretending one option is perfect.
- Assumptions not separated — buried inside the chosen approach.
- No rationale for the pick — feels arbitrary.

## Verification
- [ ] 3+ distinct options listed before converging.
- [ ] Each option has ≥1 explicit trade-off.
- [ ] Assumptions called out separately, not embedded in the choice.
- [ ] Pick is justified; hybrid is OK if explained.
- [ ] Result is tight enough to feed into Brief without rewriting.