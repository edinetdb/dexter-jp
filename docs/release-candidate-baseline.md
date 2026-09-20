# Dexter RC3 Candidate Baseline

## Status

| Field | Value |
|---|---|
| Status | RC3 candidate |
| Recorded date | 20260920 (Asia/Tokyo) |
| Package version | `1.0.5-jp` |
| Release candidate label | `v1.0.5-jp-rc3` |
| Branch | `rc/v1.0.0-jp-rc2-integration` |
| Integration base | `188a146823b1a06f632bbcb4ab6236beb70e681b` |
| Verified `origin/main` | `188a146823b1a06f632bbcb4ab6236beb70e681b` after fetch |
| Parent / pre-evidence HEAD | `4bce551f1d81928b106ad7bd05f12eb6c65a8858` |
| Pre-freeze working tree | Clean |
| Freeze form | Manifest-bound source snapshot |
| RC3 tag | Not created |
| Push / publish | Not performed |

This document describes the pre-commit RC3 evidence snapshot. It does not embed the freeze commit's own SHA. Git assigns that SHA after these evidence files are committed; the final freeze report and any later annotated tag record it.

## Commit Chain

```text
origin/main 188a146823b1a06f632bbcb4ab6236beb70e681b
→ RC2 integrated baseline 931ddc5684f8b8168d16c48656edc0a29d145e6a
→ Astra compatibility Patch 1 / 2 b77942909fcc4198f9a466c6523e08e9f6d283f0
→ validated Astra runtime support 4bce551f1d81928b106ad7bd05f12eb6c65a8858
→ RC3 evidence freeze commit (assigned after commit)
```

The fetched `origin/main` is an ancestor of the pre-evidence HEAD. The remote branch can be fast-forwarded to the RC3 line; no rebase, reset, or force operation was used.

## Architecture Baseline

RC3 preserves the Phase 1–8 contracts established by RC2:

- capability-filtered Skill discovery and explicit DCF, X, and memo activation;
- deterministic DCF calculation;
- durable memory, conversation state, and scratchpad separation;
- compaction privacy and sanitization;
- operation-based approval with exact-operation binding;
- Bash permission integration;
- deterministic, create-only memo rendering and persistence;
- memo and durable-memory separation;
- offline behavioral evaluation and practical acceptance.

RC3 additionally contains:

- Astra Compatibility Patch 1: minimal worker contract propagation, end-to-end completion contract, active Skill recovery after full compaction, and progress-aware loop detection;
- Astra Compatibility Patch 2: required-input clarification policy and channel output flexibility;
- GPT-6 Astra formal runtime support: explicit `gpt-6-astra` registration, Responses API routing, reasoning/service-tier validation, Luna worker policy, offline Astra evaluation, and a bounded live smoke harness.

## Evidence Documents

- [Astra support and validation scope](astra-support.md)
- [Memory / runtime state / scratchpad boundaries](memory-privacy-boundaries.md)
- [Operation-based approval architecture](operation-approval-architecture.md)
- [Memo architecture](memo-architecture.md)
- [Offline cross-model behavioral evaluation](behavioral-evaluation.md)
- [Practical workflow acceptance](practical-acceptance.md)
- [Machine-readable RC3 baseline](release-candidate-baseline.json)
- [RC3 snapshot manifest](rc-snapshot-manifest.json)

## Snapshot Integrity

`docs/rc-snapshot-manifest.json` is rebuilt from the complete `origin/main` to RC3 source difference. Every present non-manifest path records a SHA-256 of Git-filtered snapshot bytes and raw working-tree bytes. Deleted paths record their `origin/main` blob and SHA-256. The manifest records its own path and status but omits its own hash and line counts to avoid self-reference.

The completed manifest SHA-256 is recorded in the final freeze report.

## Evidence Levels

### 1. DETERMINISTIC / UNIT — PASS

The full Bun suite passes with 535 passed, 8 Windows platform skips, 0 failed, and 1,216 assertions across 47 files. It covers the Phase 1–8 safety contracts, Patch 1/2 contracts, Astra runtime validation, offline Astra cases, and live-harness guards without a live call.

### 2. OFFLINE BEHAVIORAL — PASS

`bun run eval` passes in `offline-fixture` mode with architecture baseline 34/34 and 0 critical failures. Astra is included in the matrix and reports `ASTRA OFFLINE COMPATIBILITY: PASS`.

### 3. OFFLINE PRACTICAL ACCEPTANCE — PASS

`bun run acceptance` passes 30/30 scenarios, 38 turns, and 8 multi-turn workflows with 0 critical failures. LLM orchestration remains scripted/offline and X uses an observable stub.

### 4. ASTRA LIVE SMOKE — PASS (8/8)

The bounded live smoke used `gpt-6-astra`, medium reasoning, Standard processing, an 800-token maximum per case, a 30-second case timeout, and nonexecuting fixture tools. Eight of eight behavioral contracts passed with 0 critical failures.

Live-verified scope:

- multi-part completion structure;
- missing-required-input non-fabrication structure;
- explicit DCF routing;
- implicit valuation without DCF routing;
- explicit memo routing;
- memory/memo separation;
- explicit X routing;
- adversarial quoted, explained, and negated text remaining non-actionable.

Not fully live-validated:

- preservation of supplied DCF arguments through a real calculation;
- propagation of a real calculator result;
- real X API behavior;
- real memo filesystem mutation;
- real durable-memory mutation;
- long multi-turn continuation after compaction;
- detailed clarification prose;
- the OpenAI client's internal HTTP retry count.

The live smoke was not rerun for this freeze. RC3 uses the already completed 8/8 evidence.

## Current Validation Baseline

| Validation | Command | Result |
|---|---|---|
| TypeScript typecheck | `bun run typecheck` | PASS |
| Full Bun suite | `bun test` | PASS — 535 passed, 8 skipped, 0 failed, 1,216 assertions across 47 files |
| Behavioral evaluation | `bun run eval` | PASS — architecture 34/34, critical failures 0, Astra offline PASS |
| Practical acceptance | `bun run acceptance` | PASS — 30/30, 38 turns, 8 multi-turn, critical failures 0 |
| Astra live case listing | `bun run eval:astra-live -- --list` | PASS — exactly 8 cases; no live API call |
| Working-tree patch integrity | `git diff --check` | PASS |
| Staged patch integrity | `git diff --cached --check` | PASS before freeze commit |

## Secret and Artifact Audit

The RC3 evidence diff and complete `origin/main` snapshot difference contain no real API key, Authorization header, raw credential, private key, live request/response dump, runtime cache, or `.dexter` state. Environment-variable names, `.env.example`, and synthetic test fixtures are not credentials.

## Non-Blocking Finding

The live harness heuristic `clarificationLikely` can false-positive on ordinary explanatory use of the word `確認`. The adversarial live case still selected no tools and did not ask a clarification question. This is an observability limitation, not a model failure or RC3 blocker.

## Known Limitations

- The bounded smoke proves only the live behaviors listed above.
- Eight POSIX shell-runner tests are skipped on Windows; Bash is not exposed by the production Windows registry.
- Memo overwrite, append, and update workflows remain intentionally unsupported.
- Claude Agent SDK capabilities differ from the LangChain runtime.
- External publishing and destructive remote operations were not exercised.

## Deferred

- P3 RULES restructuring;
- S3 memo schema cleanup;
- U2 legacy memo cleanup;
- deeper Astra live end-to-end validation;
- clarification observability heuristic refinement.

## Reproduction

From the repository root:

```text
bun run typecheck
bun test
bun run eval
bun run acceptance
bun run eval:astra-live -- --list
git diff --check
git diff --cached --check
```

Normal reproduction is credential-free. Do not enable the live execution guard merely to reproduce this baseline.
