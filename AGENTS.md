# Repository Instructions

## Scope

- Dexter JP is a Japanese-equity research agent.
- Inspect and change only files relevant to the requested task; preserve unrelated working-tree changes.
- A nested `AGENTS.md` takes precedence within its directory scope.

## Runtime

- Use Bun for the main TypeScript application and its tests.
- `mcp/browser-fast/` has its own nested instructions and runtime. Do not impose Bun or TypeScript conventions on that Python subsystem.

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
