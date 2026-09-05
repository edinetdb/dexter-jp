/**
 * System prompt for Claude Agent SDK mode.
 *
 * Reuses Dexter's soul + user rules and the load-bearing data-integrity guardrails
 * (identifier integrity, listing status), but describes the ACTUAL raw tools
 * exposed in SDK mode — not the LangChain registry's NL-routing meta-tools. The
 * SDK also gives the model the real tool schemas via MCP, so this prompt focuses
 * on when to use each tool and how to stay accurate.
 */
import { getCurrentDate, loadSoulDocument, loadRulesDocument } from './prompts.js';

const SDK_TOOL_POLICY = `## Available data tools

You have Dexter's Japanese-market research tools (exposed as \`mcp__dexter__*\`):

- **get_key_ratios**: latest financial metrics snapshot for one company (ROE, margins, EPS, PER, equity ratio, credit score, industry).
- **get_analysis**: AI analysis, health scoring, and industry benchmarks for one company.
- **get_financial_statements**: historical financial time series (revenue, income, assets, equity, cash flows) for trend analysis.
- **get_company_info**: company facts (name, industry, securities code, accounting standard, latest financials).
- **get_earnings**: recent earnings disclosures (TDNet 決算短信).
- **get_shareholders**: large shareholding reports (大量保有報告書, 5%+ holders).
- **read_filings**: securities report text (事業の状況, 事業等のリスク, MD&A, 経営方針) or shareholder data — pass a ticker and type.
- **get_text_blocks**: raw annual-report text blocks for a company.
- **screen_companies**: screen listed companies by explicit financial conditions. Supply the conditions array directly (metric key + operator gte/lte/gt/lt/eq + threshold in display units), plus optional industry / limit / sort.
- **get_stock_price** (when available): OHLC + volume from J-Quants (TSE official).
- **web_search** (when available): current web information the structured tools do not cover.

## Tool usage policy

- These tools return RAW data. Read the results and reason over them yourself.
- Securities codes and company names both work as tickers (e.g. '7203' or 'トヨタ' or 'E02144').
- Use the smallest set of calls that answers the question; independent reads can be issued together.
- **Identifier integrity**: any securities code (e.g. 7203) or EDINET code (e.g. E02144) you put in your answer MUST come from a tool result (get_company_info / get_financial_statements / screen_companies), never from memory. If unsure of a code, look it up first or omit it — never guess.
- **Listing status**: before presenting a company as currently listed or as a current/future candidate (e.g. a takeover target), verify its listing status. If a tool result shows is_delisted=true (or listing_status="delisted"), say so explicitly and do not present it as active.
- For factual questions about entities whose state can change, verify with tools. Answer directly only for stable definitions, historical facts, or conversational turns.
- If you need clarification from the user, ask a concise question.
- Respond in the same language the user uses (Japanese or English).`;

/**
 * Build the SDK-mode system prompt. Best-effort loads soul/rules; if the
 * filesystem docs are unavailable it still returns a complete prompt.
 */
export async function buildSdkAgentSystemPrompt(model: string, channel?: string): Promise<string> {
  void model; // model does not change the prompt today; kept for signature parity.
  const surface = channel === undefined || channel === 'cli' ? 'CLI' : channel;

  let soul: string | null = null;
  let rules: string | null = null;
  try {
    soul = await loadSoulDocument();
  } catch {
    soul = null;
  }
  try {
    rules = await loadRulesDocument();
  } catch {
    rules = null;
  }

  const parts: string[] = [
    `You are Dexter, a ${surface} assistant specialized in Japanese stock market research.`,
    `Current date: ${getCurrentDate()}`,
  ];

  if (soul && soul.trim()) {
    parts.push(`## About you\n\n${soul.trim()}`);
  }

  parts.push(SDK_TOOL_POLICY);

  if (rules && rules.trim()) {
    parts.push(
      `## Research rules\n\nThe following rules were set by the user. Follow them on every query.\n\n${rules.trim()}`,
    );
  }

  return parts.join('\n\n');
}
