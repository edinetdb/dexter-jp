# Repository Guidelines

- Repo: https://github.com/edinetdb/dexter-jp
- Dexter JP is a CLI-based AI agent for deep financial research on Japanese listed companies, built with TypeScript, Ink (React for CLI), and LangChain. Powered by EDINET DB API.

## Project Structure

- Source code: `src/`
  - Agent core: `src/agent/` (agent loop, prompts, scratchpad, token counting, types)
  - CLI interface: `src/cli.ts` (Ink/React), entry point: `src/index.tsx`
  - Components: `src/components/` (Ink UI components)
  - Model/LLM: `src/model/llm.ts` (multi-provider LLM abstraction)
  - Tools: `src/tools/` (financial search, web search, browser, skill tool)
  - Finance tools: `src/tools/finance/` (financials, text-blocks, earnings, shareholders, key-ratios, screening)
  - Search tools: `src/tools/search/` (Exa preferred, Tavily fallback)
  - Browser: `src/tools/browser/` (Playwright-based web scraping)
  - Skills: `src/skills/` (SKILL.md-based extensible workflows, e.g. DCF valuation)
  - Utils: `src/utils/` (env, config, caching, token estimation, markdown tables)
  - Evals: `src/evals/` (LangSmith evaluation runner with Ink UI), `src/evals/judge/` (judge-layer benchmark)
  - Judge layer: `src/judge/` (typed questions answered with probabilities; `jev` / `llm` / `replay` backends)
  - `/check`: `src/check/` (assembly, panel, record) and `src/check/core/` (pure claim/paragraph/numeric helpers)
  - `/watch`: `src/watch/` (+ `src/tools/finance/events.ts` for the disclosure feed)
  - Guards: `src/guard/` (input guard, output linter) — see "Guards" below
  - Egress ledger: `src/config/egress.ts` (single source for the README table and the startup screen)
  - Bundled disclosure data: `src/data/` (schema + build gate) and `src/data/materials/`
  - Deep links: `src/links/deeplink.ts` (URL construction only)
- Config: `.dexter/settings.json` (persisted model/provider selection)
- Environment: `.env` (API keys; see `env.example`)

## Build, Test, and Development Commands

- Runtime: Bun (primary). Use `bun` for all commands.
- Install deps: `DEXTER_SKIP_BROWSER=1 bun install` (skips the ~130MB Chromium download; drop the flag when you need the `browser` tool)
- Run: `bun run start` or `bun run src/index.tsx`
- Dev (watch mode): `bun run dev`
- Type-check: `bun run typecheck`
- Tests: `bun test`
- Demo (no keys, no network): `bun run demo`
- Bundled-data gate: `bun run check:data`
- Judge benchmark: `bun run bench:judge`
- Evals: `bun run src/evals/run.ts` (full) or `bun run src/evals/run.ts --sample 10` (sampled)

## Coding Style & Conventions

- Language: TypeScript (ESM, strict mode). JSX via React (Ink for CLI rendering).
- Prefer strict typing; avoid `any`.
- Keep files concise; extract helpers rather than duplicating code.
- Add brief comments for tricky or non-obvious logic.
- Do not add logging unless explicitly asked.
- Do not create README or documentation files unless explicitly asked.

## LLM Providers

- Supported: OpenAI (default), Anthropic, Google, xAI (Grok), OpenRouter, Ollama (local).
- Default model: `gpt-5.6-sol` (`DEFAULT_MODEL` in `src/model/llm.ts`). Provider detection is prefix-based (`claude-` -> Anthropic, `gemini-` -> Google, etc.).
- Fast models for lightweight tasks: see `FAST_MODELS` map in `src/model/llm.ts`.
- Users switch providers/models via `/model` command in the CLI.

## Tools

- `get_financials`: meta-tool for all financial data queries (financials, metrics, earnings, analysis). Routes to sub-tools internally.
- `read_filings`: reads text from annual securities reports (有価証券報告書) and shareholder data.
- `company_screener`: screens ~3,800 Japanese listed companies by 100+ financial metrics.
- `web_search`: general web search (Exa if `EXASEARCH_API_KEY` set, else Tavily if `TAVILY_API_KEY` set).
- `browser`: Playwright-based web scraping for reading pages the agent discovers.
- `skill`: invokes SKILL.md-defined workflows (e.g. DCF valuation).
- Tool registry: `src/tools/registry.ts`. Tools are conditionally included based on env vars.

## Guards (v1.1.0-jp)

- `/check` refuses to run unless the judge layer is `jev` or `replay` (`src/check/preflight.ts`).
  Measured on a held-out set never used for tuning: the deterministic layer alone lets 12/30
  advice-seeking inputs through, the judge vote alone 1/30, both together 0/30 — and the LLM
  stand-in as the vote lets 8/30 through. Shipping that would contradict the README.
- Input guard = deterministic vocabulary + structural intent patterns, OR the judge's vote.
  A judge vote can never *lift* a deterministic refusal.
- Output linter scans **only strings we generated**. Verbatim disclosure text is carried as
  `{kind:'quote'}` and never scanned — annual reports legitimately contain 割高 / 下値 / 配分.
- Secret paths (`.env`, `.dexter/credentials/`, `.dexter/checks/`) are denied for every tool that
  takes a path argument, not just `bash`.

## Financial Data Source

- **EDINET DB API** (edinetdb.jp): Structured financial data from ~3,800 Japanese listed companies
- Data sourced from EDINET annual securities reports (有価証券報告書) and TDNet earnings disclosures (決算短信)
- Coverage: up to 6 fiscal years, 100+ screening metrics, full report text, AI analysis
- Note: Stock price data is NOT available from EDINET DB (complement with J-Quants or other providers)

## Skills

- Skills live as `SKILL.md` files with YAML frontmatter (`name`, `description`) and markdown body (instructions).
- Built-in skills: `src/skills/dcf/SKILL.md` (adapted for Japanese market: JGB rates, JPY, TSE PBR context)
  and `src/skills/x-research/`.
- `src/skills/write-memo/` was **removed in v1.1.0-jp**: its description offered a long/short equity
  recommendation memo, which contradicts what `/check` and `/watch` state they do not output.
  `src/guard/no-advice-surface.test.ts` fails if it comes back.
- Discovery: `src/skills/registry.ts` scans for SKILL.md files at startup.

## Environment Variables

- LLM keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`
- Ollama: `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- Finance: `EDINETDB_API_KEY`
- Judge layer: `TYPESAFE_API_KEY` — **`/check` does not run without it** (see "Guards")
- Install/replay: `DEXTER_SKIP_BROWSER`, `DEXTER_JUDGE_REPLAY`
- Search: `EXASEARCH_API_KEY` (preferred), `TAVILY_API_KEY` (fallback)
- Tracing: `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`, `LANGSMITH_PROJECT`, `LANGSMITH_TRACING`
- Never commit `.env` files or real API keys.

## Version & Release

- Version format: SemVer `MAJOR.MINOR.PATCH` with a `-jp` suffix (e.g. `1.0.5-jp`). Tag prefix: `v`.
- Release script: `bash scripts/release.sh [version]` (defaults to bumping the patch segment).
- Release flow: bump version in `package.json`, create git tag, push tag, create GitHub release via `gh`.
- Do not push or publish without user confirmation.

## Testing

- Framework: Bun's built-in test runner (primary), Jest config exists for legacy compatibility.
- Tests colocated as `*.test.ts`.
- Run `bun test` before pushing when you touch logic.

## Security

- API keys stored in `.env` (gitignored). Users can also enter keys interactively via the CLI.
- Config stored in `.dexter/settings.json` (gitignored).
- Never commit or expose real API keys, tokens, or credentials.
