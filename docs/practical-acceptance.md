# Phase 8 Practical Workflow Acceptance

Phase 8 is an offline, stateful acceptance suite for user-visible workflows. It does not add product routing or change Phase 1-7 behavior. Its design is intentionally small: data-driven scenarios are interpreted against existing production components, then evaluated from observable events and filesystem/memory diffs.

## Evidence status

| Suite | Evidence mode | What it proves |
|---|---|---|
| Phase 7 | `offline-fixture` | Cross-runtime event normalization and behavior contracts over recorded fixtures |
| Phase 8 | `offline-scripted-workflow` | Multi-step orchestration and state transitions using real local components and temporary workspaces |
| Optional live smoke evaluation | not run | Provider/model behavior with live credentials and APIs |

Neither Phase 7 nor Phase 8 is a live model evaluation. Phase 8 never calls a paid API. X research is represented by an `observable-stub`; the real `x-research` Skill is loaded, operation policy is applied, and the external result is stubbed.

## Acceptance architecture

```text
realistic user turns
  -> runtime capability / Skill discovery
  -> scenario-directed offline orchestration
  -> production operation normalization + approval gate
  -> production local component (Skill, DCF, files, memo, memory, compaction source)
  -> observable events + temp-workspace snapshots
  -> semantic and safety assertions
  -> human report / JSON report / sanitized failure artifact
```

The harness uses the production Skill registry and Skill loader, DCF structured tool, filesystem tools, memo schema/renderer/create-only writer, durable-memory persistence boundary, scratchpad, compaction-source sanitizer, and Phase 5 exact-operation approval gate. Every scenario receives an isolated directory under `.dexter/acceptance-runs/`, which is removed after the run using a validated exact path.

The harness does not assert exact assistant prose. It checks Skill discovery/invocation, exposed and called tools, call order, normalized operations, approval decisions, file hashes and byte counts, memory and memo diffs, calculator values, semantic response markers, and forbidden behavior.

## Scenario matrix

| ID | Turns | Workflow and observable outcome |
|---|---:|---|
| A1 | 1 | Japanese explicit DCF -> `dcf-valuation` -> `calculate_dcf` |
| A2 | 1 | English explicit DCF -> same deterministic calculator path |
| A3 | 1 | invalid WACC/growth -> validation error; no assumption correction |
| A4 | 2 | general valuation answer first; explicit DCF activates on turn 2 |
| B1 | 2 | general sentiment first; explicit X request activates on turn 2 |
| B2 | 1 | generic sentiment -> no X call |
| B3 | 1 | quoted X instruction -> explanation only |
| C1 | 2 | organize content; Japanese memo request writes on turn 2 |
| C2 | 1 | English memo -> deterministic Markdown |
| C3 | 1 | Japanese/English/emoji memo -> UTF-8 artifact |
| C4 | 2 | duplicate memo -> original bytes preserved |
| C5 | 1 | explicit memo denial -> no Skill or write call |
| D1 | 1 | explicit remember -> durable memory only |
| D2 | 1 | memo-only request -> no durable memory |
| D3 | 1 | ordinary conversation -> no memory mutation |
| E1 | 1 | read-only file operation -> no approval |
| E2 | 2 | read then local edit -> exact approval before mutation |
| E3 | 1 | destructive operation denied -> not executed |
| E4 | 1 | approved target substituted -> claim rejected |
| E5 | 1 | approved arguments mutated -> claim rejected |
| E6 | 1 | identical session retry -> one prompt, two exact claims |
| F1 | 1 | tool-heavy run -> transient scratchpad only |
| F2 | 2 | tool-heavy run then compaction -> context kept, reasoning excluded |
| F3 | 2 | explicit memory then restart -> durable memory only restored |
| F4 | 2 | tool-heavy run then memo -> curated conclusion only |
| G1 | 1 | quoted memo instruction for translation -> no memo |
| G2 | 1 | explanation of remember behavior -> no memory write |
| G3 | 1 | explain DCF without using it -> no calculator |
| G4 | 1 | explicit “do not use X” -> no X call |
| G5 | 1 | explain deletion without executing -> no destructive call |

There are 30 scenarios, 38 turns, and 8 multi-turn scenarios.

## Safety failures

The following are always critical:

- approval bypass
- destructive execution without approval
- approved target or argument substitution
- hidden reasoning or scratchpad persistence
- memo-to-memory or memory-to-memo implicit promotion
- explicit DCF without the deterministic calculator
- silent duplicate memo overwrite

A failing run writes `.dexter/evals/phase8-acceptance-failures.json`. It contains the scenario ID, failed assertion, normalized observable events, expected outcome, and actual outcome. Sensitive keys and scratchpad/reasoning/credential fields are omitted. A passing run does not write a failure artifact.

Failures are classified as `TEST HARNESS BUG`, `EXPECTATION BUG`, `PRODUCT BUG`, `PRODUCT GAP`, or `DOCUMENTED LIMITATION`. The acceptance harness reports findings; it does not change product behavior to make a scenario pass.

## Commands

```sh
bun run acceptance
bun run acceptance:json
```

The full Phase 8 gate also runs typecheck, targeted acceptance tests, Phase 7 evaluation, Phase 4-7 regressions, the full test suite, and `git diff --check`.

## Deferred

- optional live model smoke evaluation
- memo overwrite / append / update workflow