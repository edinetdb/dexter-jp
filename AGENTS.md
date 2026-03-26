# Repository Guidelines

- Repo: https://github.com/edinetdb/dexter-jp
- Dexter JP is a CLI-based AI agent for deep financial research on Japanese listed companies, built with TypeScript, Ink (React for CLI), and LangChain. Powered by EDINET DB API.

## Project Structure

- Source code: `src/`
  - Agent core: `src/agent/` (agent loop, prompts, scratchpad, token counting, types)
  - CLI interface: `src/cli.tsx` (Ink/React), entry point: `src/index.tsx`
  - Components: `src/components/` (Ink UI components)
  - Hooks: `src/hooks/` (React hooks for agent runner, model selection, input history)
  - Model/LLM: `src/model/llm.ts` (multi-provider LLM abstraction)
  - Tools: `src/tools/` (financial search, web search, browser, skill tool)
  - Finance tools: `src/tools/finance/` (financials, text-blocks, earnings, shareholders, key-ratios, screening)
  - Search tools: `src/tools/search/` (Exa preferred, Tavily fallback)
  - Browser: `src/tools/browser/` (Playwright-based web scraping)
  - Skills: `src/skills/` (SKILL.md-based extensible workflows, e.g. DCF valuation)
  - Utils: `src/utils/` (env, config, caching, token estimation, markdown tables)
  - Evals: `src/evals/` (LangSmith evaluation runner with Ink UI)
- Config: `.dexter/settings.json` (persisted model/provider selection)
- Environment: `.env` (API keys; see `env.example`)

## Build, Test, and Development Commands

- Runtime: Bun (primary). Use `bun` for all commands.
- Install deps: `bun install`
- Run: `bun run start` or `bun run src/index.tsx`
- Dev (watch mode): `bun run dev`
- Type-check: `bun run typecheck`
- Tests: `bun test`
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
- Default model: `gpt-5.4`. Provider detection is prefix-based (`claude-` -> Anthropic, `gemini-` -> Google, etc.).
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

## Financial Data Source

- **EDINET DB API** (edinetdb.jp): Structured financial data from ~3,800 Japanese listed companies
- Data sourced from EDINET annual securities reports (有価証券報告書) and TDNet earnings disclosures (決算短信)
- Coverage: up to 6 fiscal years, 100+ screening metrics, full report text, AI analysis
- Note: Stock price data is NOT available from EDINET DB (complement with J-Quants or other providers)

## Skills

- Skills live as `SKILL.md` files with YAML frontmatter (`name`, `description`) and markdown body (instructions).
- Built-in skills: `src/skills/dcf/SKILL.md` (adapted for Japanese market: JGB rates, JPY, TSE PBR context).
- Discovery: `src/skills/registry.ts` scans for SKILL.md files at startup.

## Environment Variables

- LLM keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`
- Ollama: `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- Finance: `EDINETDB_API_KEY`
- Search: `EXASEARCH_API_KEY` (preferred), `TAVILY_API_KEY` (fallback)
- Tracing: `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`, `LANGSMITH_PROJECT`, `LANGSMITH_TRACING`
- Never commit `.env` files or real API keys.

## Version & Release

- Version format: SemVer.
- Do not push or publish without user confirmation.

## Testing

- Framework: Bun's built-in test runner (primary), Jest config exists for legacy compatibility.
- Tests colocated as `*.test.ts`.
- Run `bun test` before pushing when you touch logic.

## Security

- API keys stored in `.env` (gitignored). Users can also enter keys interactively via the CLI.
- Config stored in `.dexter/settings.json` (gitignored).
- Never commit or expose real API keys, tokens, or credentials.
