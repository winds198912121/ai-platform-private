---
name: bmad-architecture
description: BMAD-style Architecture — produce the architecture document that downstream stages (Development, Testing, Deployment) implement against. Lock the stack, layers, integration points, non-functional choices. Do NOT apply to single-script tools or trivial changes.
metadata:
  stage: architecture
  tech: ""
  label: BMAD · Architecture Document
---

# BMAD · Architecture Document

## Overview
The architecture locks the decisions every later stage honors: tech stack, layer conventions, data model shape, API contracts, non-functional choices (perf / security / availability), and integration boundaries. After this stage, changes to architecture cost real money.

## When to Use
- Apply: any project building >1 module, anything with non-trivial data or external integrations.
- Do NOT apply: single-script tool, one-page static page, throwaway demo.

## Core Process
1. **Tech stack** — runtime, framework, database, queue, cache, deploy target; justify each choice in 1 line.
2. **Layer / module convention** — what goes where; a `src/<layer>/<business>.ext` rule with one example per layer.
3. **Data model** — entities, relationships, ownership; one diagram or one JSON example per entity.
4. **API contracts** — request / response shape per endpoint; auth model; idempotency rules.
5. **Integration boundaries** — what is external (third-party API, queue), what is internal; failure mode for each external.
7. **Risks & trade-offs** — top 3, each with mitigation or "we accept this risk".
8. **Source folder layout** — `src/<layer>/` rule (already enforced by `development-general-conventions`).

## Common Rationalizations
| Excuse | Fact |
|---|---|
| "We'll figure out the stack as we go" | Stack churn mid-project kills velocity; lock it down. |
| "API contracts can be defined per module" | Cross-module inconsistency breaks the system; define at arch stage. |
| "Architecture is for senior engineers only" | Architecture is for everyone who'll touch the project; write it down. |

## Red Flags
- Stack choice with no justification — "we like it" isn't enough.
- No layer rule — code will go everywhere.
- External integration without failure mode — outages will surprise.
- Non-functional requirements missing — perf / security / availability all "TBD".

## Verification
- [ ] Stack + justification per choice.
- [ ] Layer rule + one example per layer.
- [ ] Data model has entities + relationships.
- [ ] API contracts defined for every public endpoint.
- [ ] External dependencies each have a failure mode.
- [ ] Non-functional requirements quantified (latency target, uptime target).