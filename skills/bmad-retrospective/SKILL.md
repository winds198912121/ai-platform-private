---
name: bmad-retrospective
description: BMAD-style retrospective — after Operations has run for a window, capture what worked, what didn't, what to change in the platform itself (workflow / skills / types / UI). Output: 3 action items with owners and verification. Do NOT apply to a single failed module — fix that module instead.
metadata:
  stage: operations
  tech: ""
  label: BMAD · Retrospective (platform-level)
---

# BMAD · Retrospective

## Overview
After Operations has run for a meaningful window (a sprint, a release, a quarter), step back and ask: what should the **platform itself** change? Workflow, skill library, type presets, UI affordances, defaults. Goal: feed improvements back into the platform, not just into one project.

## When to Use
- Apply: end of a release cycle, after a notable incident, after onboarding a new FDE.
- Do NOT apply: per-module debugging (that's runModule + code review); per-stage tuning (that's runStage).

## Core Process
1. **What worked** — list 3–5 things the platform did that made delivery faster / safer. Cite evidence (logs, gates).
2. **What hurt** — list 3–5 things that wasted time or caused rework. Cite evidence.
3. **What to change** — turn each hurt into an action with:
   - Owner (role, not name — FDE / PM / dev)
   - Verification (how do we know it's done)
   - Horizon (this sprint / next / backlog)
5. **Skip-list** — things raised but explicitly deferred, with reason (avoid re-raising next retro).
4. Feed changes back into:
   - `harness.mjs`: WORKFLOWS / TYPES / STAGES
   - `skills/<name>/SKILL.md`: missing rules
   - `public/i18n.mjs` + `app.js`: missing affordances
   - Runbook in workspace: what worked, what hurt

## Common Rationalizations
| Excuse | Fact |
|---|---|
| "We'll fix it next time" | Without an owner + verification, "next time" never comes. |
| "The platform is fine, it's the user" | If the user kept making the same mistake, the platform's affordance is wrong. |
| "We don't have time for retro" | Retro without action items = venting. With action items, it's a 1-hour investment for a quarter of less pain. |

## Red Flags
- "What worked" is empty — over-focus on pain hides what's working.
- Actions without owners — won't happen.
- "Skip" list without reasons — gets re-raised next retro.
- Changes go into the runbook but not into the platform — local fixes don't scale.

## Verification
- [ ] 3+ items each in "worked" and "hurt" with evidence.
- [ ] Each action item has owner + verification + horizon.
- [ ] At least one action targets the platform (workflow / skills / UI).
- [ ] Skip-list with reasons.
- [ ] Next retro opens by checking the previous retro's verification.