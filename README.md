# Dexter JP 🇯🇵

AI agent for deep financial research on Japanese listed companies. Powered by [EDINET DB](https://edinetdb.jp).

Forked from [virattt/dexter](https://github.com/virattt/dexter) — adapted from US markets (Financial Datasets API) to Japanese markets (EDINET DB API).

## What it does

Dexter JP is a CLI-based AI agent that can:

- **Analyze financials** — Revenue, operating income, net income, cash flows, balance sheet items for ~3,800 Japanese listed companies (up to 6 years of history)
- **Read securities reports** — Full text of 有価証券報告書 (annual securities reports): business overview, risk factors, management analysis, strategy
- **Screen companies** — Filter by 100+ metrics: ROE, ROIC, operating margin, dividend yield, revenue CAGR, PER, PBR, equity ratio, and more
- **Track earnings** — TDNet 決算短信 (earnings disclosures) with YoY change rates and forecasts
- **Analyze ownership** — 大量保有報告書 (large shareholding reports) showing 5%+ holders
- **Run valuations** — Built-in DCF skill adapted for Japanese market (JGB rates, JPY, TSE PBR context)
- **Search the web** — General research via Exa, Perplexity, or Tavily

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) runtime
- An LLM API key (OpenAI, Anthropic, Google, etc.)
- An [EDINET DB API key](https://edinetdb.jp) (free tier available)

### Setup

```bash
git clone https://github.com/edinetdb/dexter-jp.git
cd dexter-jp
bun install
cp env.example .env
```

Edit `.env` and add your API keys:

```
ANTHROPIC_API_KEY=your-key    # or OPENAI_API_KEY, GOOGLE_API_KEY, etc.
EDINETDB_API_KEY=your-key     # Get at edinetdb.jp
```

### Run

```bash
bun run start
```

## Example queries

```
トヨタの直近5年の財務推移を見せて

ソニーのROEと営業利益率の推移は？

ROE15%以上、自己資本比率50%以上の企業をスクリーニングして

任天堂の有報のリスク要因を読んで

7203のDCFバリュエーションをして

配当利回り4%以上の高配当銘柄を探して
```

English works too:

```
Show me Toyota's financials for the last 5 years

Screen for companies with ROE > 15% and equity ratio > 50%

What are the risk factors in Nintendo's annual report?
```

## Data Source

All financial data comes from [EDINET DB](https://edinetdb.jp) — structured data extracted from annual securities reports (有価証券報告書) filed with EDINET and earnings disclosures (決算短信) from TDNet.

**Note:** Stock price data is not available from EDINET DB. For price data, complement with [J-Quants](https://jpx-jquants.com/) or other providers.

## Architecture

Dexter JP uses the same architecture as the original Dexter:

- **Agent loop** with iterative tool calling (LangChain)
- **Meta-tools** (`get_financials`, `read_filings`, `company_screener`) that use an inner LLM call to route to the right sub-tool
- **Skills** (SKILL.md) for complex multi-step workflows (DCF valuation)
- **Memory** for persistent context across sessions
- **Multi-provider LLM** support (OpenAI, Anthropic, Google, xAI, Ollama)

### Key differences from original Dexter

| Feature | Original (US) | JP Version |
|---------|--------------|------------|
| Data source | Financial Datasets API | EDINET DB API |
| Markets | US equities | Japanese equities (~3,800 companies) |
| Filings | SEC 10-K/10-Q/8-K | 有価証券報告書 (EDINET) |
| Earnings | 8-K earnings | TDNet 決算短信 |
| Insider data | SEC Form 4 | 大量保有報告書 |
| Screening | GICS sectors | 33 Japanese industries, 100+ metrics |
| Stock prices | Yes | No (use J-Quants etc.) |
| Crypto | Yes | No |
| DCF WACC | US rates (~4% risk-free) | Japanese rates (~1% risk-free) |
| Language | English | Japanese + English |

## License

MIT (same as original Dexter)

## Credits

- Original [Dexter](https://github.com/virattt/dexter) by [@virattt](https://github.com/virattt)
- Financial data by [EDINET DB](https://edinetdb.jp)
