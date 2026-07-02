🇯🇵 [日本語版はこちら](README.md)

# Dexter JP — Autonomous Research Agent for Japanese Equities

> Ask a question. It plans the research, pulls data from multiple sources, validates its own work, and delivers a finished report.

A financial AI agent built for the Japanese stock market, powered by [EDINET DB](https://edinetdb.com) + [J-Quants](https://jpx-jquants.com/).
Forked from [virattt/dexter](https://github.com/virattt/dexter) (US equities) and rebuilt from the ground up for Japan.

![Dexter JP Demo](docs/demo.png)

## Not Just Another Financial Tool

Most financial tools stop at "here's a screener" or "here's the data." Dexter JP goes further.

**Ask: "Analyze Sony vs Nintendo as investment targets and give me a recommendation"** and it will:

1. Build a plan — decide which metrics matter (profitability, growth, balance sheet strength, risk) on its own
2. Call multiple tools autonomously — pull financial statements, annual report risk factors, and earnings summaries for both companies in parallel
3. Self-validate mid-process — check whether the numbers and narrative are consistent, and whether it has enough data
4. Deliver a report — output a structured analysis with comparison tables and a clear conclusion

One question, zero human intervention. This is not single-tool data retrieval. It is multi-source, autonomous analysis.

## Setup

### Requirements

- [Bun](https://bun.sh/)
- An LLM API key (at least one of the options below)
- An [EDINET DB](https://edinetdb.com) API key

### Environment Variables

Set these in your `.env` file:

```bash
# === Required ===

# LLM (at least one; you can set multiple and switch between them in the CLI)
OPENAI_API_KEY=sk-...          # OpenAI (default)
ANTHROPIC_API_KEY=sk-ant-...   # Claude
GOOGLE_API_KEY=...             # Gemini
XAI_API_KEY=...                # Grok
OPENROUTER_API_KEY=...         # OpenRouter (access to multiple models)

# Japanese equity data
EDINETDB_API_KEY=edb_...       # Get yours at edinetdb.com (free tier available)

# === Optional ===

# Stock prices (enables the get_stock_price tool)
JQUANTS_API_KEY=...            # Free, no expiration — jpx-jquants.com

# Web search (enables the web_search tool; priority: Exa > Perplexity > Tavily)
EXASEARCH_API_KEY=...
PERPLEXITY_API_KEY=...
TAVILY_API_KEY=...

# X/Twitter search
X_BEARER_TOKEN=...

# Local LLM
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

### Install & Run

```bash
git clone https://github.com/edinetdb/dexter-jp.git
cd dexter-jp
bun install
cp env.example .env  # Edit this file and add your API keys
bun run start
```

## Usage Examples

### Autonomous Analysis (Where the Agent Shines)

Throw a complex question at Dexter and it will plan, gather data across multiple sources, and produce a report:

```
Comprehensive analysis of Toyota's competitiveness. Cover financials, risk factors from the annual report, and latest earnings — compile everything into a report.

Sony vs Nintendo: which is the better investment? Compare financial health, profitability, growth, and risk, then give a verdict.

Find undervalued stocks with high ROE and high dividends, then deep-dive into the top 3 on balance sheet strength and business risk.

Run a DCF valuation on Keyence. Is the current stock price overvalued or undervalued?
```

### Simple Queries Work Too

```
Show me Toyota's financial trends over the last 5 years.

Screen for companies with ROE above 15% and equity ratio above 50%.

Pull the risk factors section from Nintendo's annual securities report.

Find high-dividend stocks yielding above 4%.
```

### Works in English

```
Analyze Toyota's competitiveness. Cover financials, risk factors from the annual report, and latest earnings.

Compare Sony vs Nintendo as investment targets with a final recommendation.
```

## Architecture

```
User's question
    |
Agent loop (LangChain)
    | Plan -> Select tools -> Execute -> Validate -> Repeat
    |
+-------------------------------------------+
|  get_financials (meta-tool)               |
|    -> get_financial_statements            |
|    -> get_company_info                    |
|    -> get_key_ratios                      |
|    -> get_analysis                        |
|    -> get_earnings                        |
+-------------------------------------------+
|  read_filings                             |
|    -> text-blocks (annual report text)    |
|    -> shareholders (large shareholdings)  |
+-------------------------------------------+
|  company_screener (100+ metrics)          |
+-------------------------------------------+
|  get_stock_price (J-Quants V2)            |
+-------------------------------------------+
|  web_search / browser / skills            |
+-------------------------------------------+
    |
Structured report output
```

### How the Meta-Tool Works

`get_financials` is not a simple API wrapper. It is a **routing agent** with its own internal LLM:

1. Receives a natural language query from the user
2. Its internal LLM decides which sub-tools to invoke
3. Runs multiple sub-tools in parallel
4. Consolidates results and returns them

"Compare Sony and Toyota's profit margins" triggers four API calls behind the scenes, automatically.

### Skills System

Complex multi-step workflows are defined in `SKILL.md` files. Ships with a built-in DCF valuation skill:
- WACC calculation based on Japanese government bond yields
- Awareness of TSE's PBR-below-1x governance push
- All analysis in JPY

### Research Rules (`.dexter/RULES.md`)

Define your investment style and analysis preferences in Markdown. The rules are automatically loaded into the system prompt and guide Dexter's research behavior.

```bash
mkdir -p .dexter
cp RULES.md.example .dexter/RULES.md
# Edit to match your preferences
```

Use `/rules` in the CLI to verify your current rules are active.

Examples:
- Always compare against 5 sector peers
- Report financials in JPY millions
- Screen using value criteria (ROE > 10%, PBR < 1.5)

### Context Compaction

During long research sessions with heavy data retrieval, a fast LLM automatically compresses accumulated tool results into a structured summary. Unlike simple clearing, key numbers and conclusions are preserved — keeping analysis coherent across the full session.

### Memory

Persists across sessions. Dexter remembers your investment thesis, portfolio information, and past analyses.

### Supported LLMs

Switch models on the fly with the `/model` command:

- OpenAI (GPT-4o, GPT-4o-mini, etc.)
- Anthropic (Claude)
- Google (Gemini)
- xAI (Grok)
- OpenRouter
- Ollama (local LLMs)
- Claude Agent SDK (see below)

### Claude Agent SDK mode

A run mode powered by `@anthropic-ai/claude-agent-sdk`. The agent loop is delegated to the SDK, and **authentication is resolved by the SDK** — Dexter implements no auth flow of its own.

- Pick the **Claude Agent SDK** provider via `/model`, choose a model (claude-fable-5 / claude-opus-4-8 / claude-sonnet-4-6), and go. No API key entry is requested.
- The SDK resolves credentials. It works with your **Claude Code login**, `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` — the SDK decides which, based on your environment.
- Whether the Agent SDK can be used on a Claude plan (Pro/Max), and under what terms, is described in Anthropic's help ([Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540)). Terms may change.
- Use it with your own personal credentials only; do not offer it as a multi-user service.
- **Billing-path check**: if a usage-based credential (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, …) is present in the environment, the mode reports what it detected at startup and stops before running so it does not proceed on an unintended billing path (fail-loud). To proceed on that path, set `DEXTER_AGENT_SDK_ALLOW_METERED=1` and retry.
- To cap cost, set `DEXTER_AGENT_SDK_MAX_BUDGET_USD` (USD); the SDK stops when its estimate reaches it.
- In this mode Dexter's finance/data tools return raw data for the main model to interpret (no internal LLM re-call inside tools). SDK built-in tools (Bash / Write / WebSearch, etc.) are not used.

> Note: availability and pricing of this mode depend on Anthropic's terms and may change. This does not claim the mode is "free" or "no extra cost"; the startup line shows which credential path is actually in use.

### Messaging Integrations

Use Dexter beyond the CLI — connect it to Slack, Discord, or LINE. Start with `bun run gateway`:

| Channel | Protocol | Public URL Required? | Environment Variables |
|---------|----------|---------------------|----------------------|
| **Slack** | Socket Mode (WebSocket) | No | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` |
| **Discord** | Gateway (WebSocket) | No | `DISCORD_BOT_TOKEN` |
| **LINE** | Webhook (HTTP) | Yes | `LINE_CHANNEL_SECRET` + `LINE_CHANNEL_ACCESS_TOKEN` |
| WhatsApp | Baileys (WebSocket) | No | QR code login |

Only channels with configured environment variables will start. Multiple channels can run simultaneously.

#### Slack Bot Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) -> **Create New App** -> From scratch
2. **Socket Mode** -> Enable -> Generate an App-Level Token (starts with `xapp-`)
3. **OAuth & Permissions** -> Add Bot Token Scopes:
   - `chat:write`, `im:history`, `im:read`, `app_mentions:read`
4. **Event Subscriptions** -> Enable Events -> Subscribe to bot events:
   - `message.im` (DM), `app_mention` (mentions)
5. **App Home** -> Turn on Messages Tab -> Check "Allow users to send Slash commands and messages from the messages tab"
6. **Install to Workspace** -> Copy the Bot Token (starts with `xoxb-`)
7. Add to `.env`:
   ```bash
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```

In channels, Dexter replies in threads. In DMs, it replies directly.

#### Discord Bot Setup

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) -> **New Application**
2. **Bot** -> Reset Token -> Copy the Bot Token
3. **Bot** -> Privileged Gateway Intents -> Enable **Message Content Intent**
4. **OAuth2** -> URL Generator:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`, `Send Messages in Threads`
5. Open the generated URL in your browser and invite the bot to your server
6. Add to `.env`:
   ```bash
   DISCORD_BOT_TOKEN=MTQ4...
   ```

In servers, mention `@BotName` to get a threaded reply. In DMs, it replies directly.

#### LINE Bot Setup

LINE uses webhooks (not WebSocket), so you need a publicly accessible URL — unlike Slack/Discord.

1. Create a **LINE Official Account** at [LINE Official Account Manager](https://manager.line.biz/)
   - As of 2026, you cannot create Messaging API channels directly from the LINE Developers Console
2. In LINE Official Account Manager → **Settings** → **Messaging API** → **Enable Messaging API**
   - Select an existing provider
3. In [LINE Developers Console](https://developers.line.biz/console/) → your channel → **Messaging API** tab:
   - **Channel access token (long-lived)** → Issue
   - **Webhook URL** → `https://{your-domain}/webhook/line`
   - **Use webhook** → ON
   - **Webhook redelivery** → OFF (prevents duplicate processing)
4. In LINE Official Account Manager → **Settings** → **Response settings**:
   - **Auto-reply messages** → OFF
   - **Greeting messages** → OFF
5. Get the Channel Secret from the **Basic settings** tab
6. Add to `.env`:
   ```bash
   LINE_CHANNEL_SECRET=your-channel-secret
   LINE_CHANNEL_ACCESS_TOKEN=your-channel-access-token
   WEBHOOK_PORT=3000  # default
   ```

For the public webhook URL:
- **Local testing**: `ngrok http 3000` → use the generated URL + `/webhook/line`
- **Production**: Deploy to any service that supports long-lived processes (not serverless):
  - [Railway](https://railway.app/) — just add a `Dockerfile`. Free tier available. Easiest option
  - [Fly.io](https://fly.io/) — `fly launch` and done. Free tier available
  - [Render](https://render.com/) — run as a Background Worker. Free tier available
  - Google Cloud Run (min-instances=1)
  - Any VPS
  - **Vercel / Netlify won't work** (serverless — can't maintain long-lived processes)

#### Start the Gateway

```bash
bun run gateway    # All configured channels start simultaneously
```

## Data Sources

| Source | Coverage | Required? |
|--------|----------|-----------|
| [EDINET DB](https://edinetdb.com) | Financial statements, annual report text, screening, AI analysis (~3,800 companies) | Required |
| [J-Quants](https://jpx-jquants.com/) | Stock price OHLC (official TSE data) | Optional |
| Web search | Exa / Perplexity / Tavily | Optional |

## Differences from the Original (US Version)

| | Original (US) | JP Version |
|---|---|---|
| Data source | Financial Datasets API | EDINET DB API |
| Market | US equities | Japanese equities (~3,800 companies) |
| Filings | SEC 10-K/10-Q/8-K | Annual Securities Reports (EDINET) |
| Earnings | 8-K earnings | TDNet Earnings Summaries |
| Shareholder data | SEC Form 4 (insider transactions) | Large Shareholding Reports (5%+ holdings) |
| Stock prices | Financial Datasets | J-Quants V2 (official TSE feed) |
| Screening | GICS sectors | 33 TSE industries, 100+ metrics |
| DCF | US Treasury rates (~4%) | JGB yields (~1%) |
| Language | English | Japanese + English |

## License

MIT

## Credits

- Original [Dexter](https://github.com/virattt/dexter) by [@virattt](https://github.com/virattt)
- Financial data: [EDINET DB](https://edinetdb.com)
- Stock prices: [J-Quants](https://jpx-jquants.com/)
