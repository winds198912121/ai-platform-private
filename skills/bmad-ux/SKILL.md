---
name: bmad-ux
description: BMAD-style UX — produce a thin prototype spec (user journey, key screens, interaction patterns, accessibility, copy conventions) without burning design tokens on unused variants. Do NOT apply to non-UI services or pure data pipelines.
metadata:
  stage: ux
  tech: ""
  label: BMAD · UX Prototype Spec
---

# BMAD · UX Prototype Spec

## Overview
Spec the user journey and key screens as a thin prototype description — enough to lock the architecture and let downstream stages build without UI rework. No pixel-perfect design; no unused variants.

## When to Use
- Apply: web / mobile / desktop UI project; any surface users interact with.
- Do NOT apply: backend-only API, batch jobs, data pipelines, CLI tools.

## Core Process
1. **User journey** — happy path through 3–7 steps; mark the failure branches.
2. **Key screens** — one per step; describe layout, content, primary action, secondary actions.
3. **Interaction patterns** — how forms validate, how errors render, how loading states appear, how empty states look.
4. **Accessibility** — keyboard order, focus visible, color contrast, ARIA roles for custom widgets.
5. **Copy** — tone (formal / casual / playful), button verbs, error message style; don't write final copy, set the rules.

## Common Rationalizations
| Excuse | Fact |
|---|---|
| "We'll do design after dev starts" | Dev without UX rebuilds the layout 3 times. Spec first. |
| "Need to design every screen in detail" | Spec the journey; detail only the screens that change architecture. |
| "Skip accessibility, ship later" | Retrofitting accessibility breaks more than building it in. |

## Red Flags
- User journey has no failure branches — every flow fails eventually.
- Loading / error / empty states not covered — these ship as blank UI.
- Accessibility is "later" — generic; it must be in the spec.
- Copy style not specified — every screen will invent its own voice.

## Verification
- [ ] 3–7 step happy path with failure branches.
- [ ] Each step lists layout / primary action / secondary actions.
- [ ] Loading / error / empty patterns explicit.
- [ ] Keyboard order and ARIA roles covered for non-standard widgets.
- [ ] Copy tone and button-verb conventions specified.