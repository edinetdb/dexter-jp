# Repository Instructions

## Scope

- Dexter JP is a Japanese-equity research agent.
- Inspect and change only files relevant to the requested task; preserve unrelated working-tree changes.
- A nested `AGENTS.md` takes precedence within its directory scope.

## Runtime

- Use Bun for the main TypeScript application and its tests.
- `mcp/browser-fast/` has its own nested instructions and runtime. Do not impose Bun or TypeScript conventions on that Python subsystem.
- Set `DEXTER_SKIP_BROWSER=1` for installs that do not need Chromium. Offline checks include `bun run demo`, `bun run check:data`, and `bun run bench:judge`.

## Guards

- `/check` requires the `jev` or injected `replay` judge backend; do not replace its preflight with the LLM stand-in.
- Input refusals combine deterministic checks and the judge vote; a vote cannot lift a deterministic refusal.
- Output linting covers generated strings, not verbatim disclosure quotes.
- Deny secret paths (`.env`, `.dexter/credentials/`, `.dexter/checks/`) in every path-taking tool.
- The old investment-recommendation memo was removed upstream. The explicit-only `write-memo` Skill saves structured user-requested content without prescribing investment positions or promoting it to durable memory.
- Automatic memory flush remains removed; durable memory requires an explicit user request.

## Safety and authorization

- Never print, log, commit, or expose real credentials, API keys, Cookies, Authorization headers, OTPs, or payment/card data. Use placeholders in tests and documentation.
- Do not change billing or authentication paths unless the task explicitly requires it and targeted verification is available.
- Do not weaken production or financial-data integrity guards unless the task explicitly requires it.
- Do not push, publish, release, deploy, or perform other external side effects without explicit user authorization.
- Do not invoke live or paid APIs or evaluations merely to validate offline changes.

## Verification and completion

- Use proportional verification: changed TypeScript or shared interfaces require typecheck and affected tests; run broader tests for cross-cutting changes.
- Follow nested instructions for `mcp/browser-fast/` verification.
- Implement the requested scope, fix failures caused by it, and report checks plus genuine remaining blockers.

## Canonical references

- Setup and contribution workflow: `CONTRIBUTING.md`
- Provider and model defaults: `src/providers.ts` and `src/utils/model.ts`
- Runtime tool registry: `src/tools/registry.ts`
- Release versions use SemVer with a `-jp` suffix and `v` tag prefix; workflow: `scripts/release.sh`
