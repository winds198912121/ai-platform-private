---
name: bmad-brief
description: BMAD-style Product Brief — produce a single dense document capturing goals, users, scope (in/out), success metrics, constraints, and risks. The brief is the contract for the next stage (UX / Architecture) and must be reviewable in 2 minutes.
metadata:
  stage: requirements
  tech: ""
  label: BMAD · Product Brief
---

# BMAD · Product Brief

## Overview
The Brief is a dense, reviewable summary of what we're building and why. After this stage, the brief is the contract every later stage honors (UX aligns to it, Architecture decomposes it, WBS estimates against it).

## When to Use
- Apply: start of any project, after Brainstorming converges. Every project needs one.
- Do NOT apply: throwaway scripts, internal tools with no users, single-bug fix.

## Core Process
1. **Goal** — one sentence: what outcome this delivers.
2. **Users** — primary / secondary / out-of-scope, each in 1 line.
3. **Scope (in / out)** — bullet lists, terse; "in" is what we'll build, "out" is what we won't.
4. **Success metrics** — 2–4 measurable things: latency, conversion, error rate, NPS, etc.
5. **Constraints** — budget / deadline / tech-stack / regulatory / integration dependencies.
6. **Risks** — top 3, each with a mitigation or a "we'll discover later" flag.
7. **Open questions** — anything blocking, with owner.

## Common Rationalizations
| Excuse | Fact |
|---|---|
| "Brief is just internal; doesn't need rigor" | If the brief is sloppy, every later stage compounds the slack. |
| "We can fill in scope as we go" | Scope creep is the top killer of delivery timelines. Write it down now. |
| "Constraints are obvious" | "Obvious" constraints surprise people every time; write them. |

## Red Flags
- Goal is vague ("improve experience") — needs a measurable outcome.
- No "out of scope" — everything will be requested eventually.
- Success metrics are proxy metrics only ("engagement", "good feedback") — needs measurement.
- Risks all "we'll see" — needs at least one mitigation per risk.

## Verification
- [ ] Reviewable in ≤2 minutes.
- [ ] Goal / users / in / out / metrics / constraints / risks / open-questions all present.
- [ ] "Out of scope" explicitly listed.
- [ ] Success metrics are measurable, not aspirations.
- [ ] Open questions have owners.