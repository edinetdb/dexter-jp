# Dexter RC2 Candidate Baseline

## Status

| Field | Value |
|---|---|
| Status | RC2 candidate |
| Recorded date | 20260919 (Asia/Tokyo) |
| Package version | `1.0.5-jp` |
| Release candidate label | `v1.0.0-jp-rc2` |
| Branch | `rc/v1.0.0-jp-rc2-integration` |
| Integration base / expected parent | `188a146823b1a06f632bbcb4ab6236beb70e681b` |
| Verified `origin/main` | `188a146823b1a06f632bbcb4ab6236beb70e681b` after fetch |
| Previous RC1 commit | `299e6990dc3feeb126052479d35f5008c17dd560` |
| Previous RC1 tag | `v1.0.0-jp-rc1` |
| Commit SHA | Not assigned in pre-commit evidence; recorded after commit in the freeze report/tag |
| Freeze form | Manifest-bound staged snapshot |
| State at evidence capture | 123 staged paths: 73 added, 47 modified, 3 deleted; 0 unstaged paths |
| RC2 tag | Not created |
| Push / publish | Not performed |

This document describes the exact pre-commit RC2 candidate. It intentionally does not embed the commit's own SHA. The immutable commit SHA is assigned by Git after this evidence is committed and is recorded externally in the final freeze report and any later tag.

## Integration

The RC2 candidate is:

```text
origin/main 188a146823b1a06f632bbcb4ab6236beb70e681b
+
validated RC1 Phase 1-8 delta
+
2 integration compatibility regression-test paths
```

The integration preserves all 61 commits unique to the latest `origin/main` branch relative to the old Phase baseline. Twelve semantic conflicts were resolved while retaining both the current-main behavior and the Phase 1-8 contracts. All 121 RC1 manifest paths remain present in the integrated diff; the two additional compatibility paths are:

- `src/controllers/agent-runner.test.ts`
- `src/tools/bash/shell-runner.test.ts`

## Scope

The candidate establishes and revalidates:

- capability-filtered Skill discovery and explicit DCF/X/memo behavior contracts;
- deterministic DCF calculation through `calculate_dcf`;
- durable memory, conversation/runtime state, and scratchpad separation;
- compaction that remains transient conversation state;
- operation-based approval with exact normalized-operation fingerprints;
- Bash permission decisions bridged into exact-operation approval;
- structured, deterministic, create-only memo generation;
- memo and durable-memory isolation;
- offline behavioral evaluation;
- offline practical workflow acceptance;
- the browser-fast Python subsystem.

## Evidence Documents

- [Memory / runtime state / scratchpad boundaries](memory-privacy-boundaries.md)
- [Operation-based approval architecture](operation-approval-architecture.md)
- [Memo architecture](memo-architecture.md)
- [Offline cross-model behavioral evaluation](behavioral-evaluation.md)
- [Practical workflow acceptance](practical-acceptance.md)
- [Machine-readable RC2 baseline](release-candidate-baseline.json)
- [RC2 snapshot manifest](rc-snapshot-manifest.json)

## Snapshot Integrity

`docs/rc-snapshot-manifest.json` is rebuilt from the staged difference between `origin/main` and the integrated index. For each present path it records the SHA-256 of staged bytes and the raw working-tree SHA-256. Differences caused solely by Git EOL normalization are explicitly classified. Deleted paths record their `origin/main` blob identity and baseline SHA-256.

The manifest does not contain its own SHA-256. Its completed SHA-256 is recorded in the final freeze report to avoid self-reference.

## Verified Contracts

| Contract | Boundary | Evidence |
|---|---|---|
| Skill capability filtering | Disabled or unavailable Skills are excluded; memo additionally has a code-enforced explicit-intent gate | Unit/deterministic, offline behavioral, offline acceptance |
| DCF deterministic execution | `dcf-valuation` uses `calculate_dcf`; calculator code owns arithmetic and validates WACC above growth | Unit/deterministic, offline behavioral, offline acceptance |
| X explicit contract | Offline routing requires an explicit X/Twitter request and rejects generic, quoted, or negative intent | Offline behavioral and offline acceptance; live routing is not proven |
| Durable-memory boundary | `memory_update` → `DurableMemoryPersistence` → `MemoryStore` is the explicit write path | Unit/deterministic, offline behavioral, offline acceptance |
| Scratchpad privacy | Scratchpad and intermediate tool state are run-local and are not restored as durable memory | Unit/deterministic, offline behavioral, offline acceptance |
| Compaction safety | Sanitized conversation/tool evidence becomes compacted runtime state without calling a durable-memory writer | Unit/deterministic, offline behavioral, offline acceptance |
| Operation approval | Risk is derived from a normalized operation rather than only a tool name | Unit/deterministic, offline behavioral, offline acceptance |
| Exact-operation binding | SHA-256 fingerprints bind action, target, scope, and security-relevant arguments before invocation | Unit/deterministic, offline behavioral, offline acceptance |
| Bash integration | Exact commands are bound; allow-session reuse is query-scoped; policy deny fails closed | Unit/deterministic |
| Memo deterministic rendering | Strict document schema → pure renderer → normalized `memo.create` → approval → UTF-8 create-only write | Unit/deterministic, offline behavioral, offline acceptance |
| Memo/memory separation | Memo writes do not call durable-memory persistence and memory writes do not create memos | Unit/deterministic, offline behavioral, offline acceptance |

## Evidence Levels

### 1. UNIT / DETERMINISTIC — PASS

The targeted integration suite passes with 198 passed, 8 Windows platform skips, 0 failed, and 401 assertions across 10 files.

The full Bun suite passes with 491 passed, 8 skips, 0 failed, and 1,087 assertions across 41 files. It directly exercises Skill/tool registries, DCF arithmetic, memory and scratchpad boundaries, compaction sanitization, operation fingerprints, LangChain/SDK approval adapters, Bash command policy, memo rendering, and create-only persistence.

### 2. OFFLINE BEHAVIORAL — PASS

`bun run eval` passes in `offline-fixture` mode for 19 registered configuration shapes. The deterministic architecture baseline is 34/34 and critical failures are 0.

This does not invoke live models and does not prove real-provider routing, output quality, availability, or variance.

### 3. OFFLINE PRACTICAL ACCEPTANCE — PASS

`bun run acceptance` passes 30/30 scenarios, 38 turns, and 8 multi-turn workflows with 0 critical failures.

LLM orchestration is scripted/offline. X uses an observable stub; no X API is called.

### 4. LIVE VALIDATION — NOT YET VALIDATED

No live LLM, paid API, X API, real market API, browser external mutation, external publication, or remote destructive operation was executed.

## Current Validation Baseline

| Validation | Command | Result |
|---|---|---|
| TypeScript typecheck | `bun run typecheck` | PASS |
| Targeted integration tests | `bun test <10 targeted files>` | PASS — 198 passed, 8 skipped, 0 failed, 401 assertions |
| Full Bun suite | `bun test` | PASS — 491 passed, 8 skipped, 0 failed, 1,087 assertions across 41 files |
| Behavioral evaluation | `bun run eval` | PASS — 19 configurations, architecture 34/34, critical failures 0 |
| Practical acceptance | `bun run acceptance` | PASS — 30/30, 38 turns, 8 multi-turn, critical failures 0 |
| browser-fast lint | `ruff check --no-cache .` | PASS |
| browser-fast tests | `pytest -p no:cacheprovider -o addopts=''` | PASS — 61/61 |
| Working-tree patch integrity | `git diff --check` | PASS |
| Staged patch integrity | `git diff --cached --check` | PASS |

## Known Limitations

- Live model routing is not validated.
- Live X integration is not validated; practical acceptance uses an observable stub.
- X intent has no deterministic string gate; actual selection depends on live-model adherence to the Skill/prompt contract.
- Live compaction-model behavior is not validated; deterministic source sanitization and state boundaries are tested.
- Provider-specific real-model behavior, availability, retries, and output quality are not proven by offline fixtures.
- Eight POSIX shell-runner tests are skipped on Windows. Bash is not exposed by the production Windows registry; parser, rule-engine, and exact-approval tests still run.
- Memo overwrite, append, and update workflows are not implemented; memo persistence is intentionally create-only.
- Claude Agent SDK capabilities differ from the LangChain runtime.
- The RC label remains `v1.0.0-jp-rc2` as requested, while the preserved latest-main package version is `1.0.5-jp`.
- External browser mutations, publication, destructive remote operations, and paid/live data paths are not validated.

## Deferred

- optional live model smoke evaluation;
- memo overwrite / append / update workflow;
- dogfooding-derived regressions.

## Reproduction

From the repository root:

```text
bun run typecheck
bun test
bun run eval
bun run acceptance
git diff --check
git diff --cached --check
```

From `mcp/browser-fast/`, using the locked offline environment:

```text
python -m uv run --frozen --offline ruff check --no-cache .
python -m uv run --frozen --offline pytest -p no:cacheprovider -o addopts=''
```

Normal validation is offline. Do not supply credentials or enable live providers merely to reproduce this baseline.
