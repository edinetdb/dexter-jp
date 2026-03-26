import { DynamicStructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { AIMessage, ToolCall } from '@langchain/core/messages';
import { z } from 'zod';
import { callLlm } from '../../model/llm.js';
import { formatToolResult } from '../types.js';
import { getCurrentDate } from '../../agent/prompts.js';

/**
 * Rich description for the get_financials tool.
 */
export const GET_FINANCIALS_DESCRIPTION = `
Intelligent meta-tool for retrieving Japanese company financial data. Takes a natural language query and automatically routes to appropriate financial data sources.

## When to Use

- Company facts (name, industry, securities code, accounting standard)
- Company financials (revenue, operating income, net income, total assets, equity, cash flows)
- Financial metrics and key ratios (ROE, ROIC, operating margin, EPS, PER, dividend yield)
- Historical financial time series and trend analysis
- AI-powered company analysis and health scoring
- Earnings disclosures (TDNet 決算短信)
- Multi-company comparisons

## When NOT to Use

- Reading securities report text content (use read_filings instead)
- Stock screening by criteria (use company_screener)
- Shareholder ownership data (use get_shareholders)
- General web searches (use web_search)

## Usage Notes

- Call ONCE with the complete natural language query - the tool handles complexity internally
- Handles ticker resolution automatically (7203 → Toyota, トヨタ → E02144)
- Returns structured JSON data with source URLs for verification
- Securities codes (4-digit numbers like 7203) and company names (トヨタ, Sony) both work
`.trim();

/** Format snake_case tool name to Title Case for progress messages */
function formatSubToolName(name: string): string {
  return name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Import all finance tools directly
import { getFinancials, getCompanyInfo } from './financials.js';
import { getKeyRatios, getAnalysis } from './key-ratios.js';
import { getEarnings } from './earnings.js';

// All finance tools available for routing
const FINANCE_TOOLS: StructuredToolInterface[] = [
  getFinancials,
  getCompanyInfo,
  getKeyRatios,
  getAnalysis,
  getEarnings,
];

const FINANCE_TOOL_MAP = new Map(FINANCE_TOOLS.map(t => [t.name, t]));

function buildRouterPrompt(): string {
  return `You are a Japanese financial data routing assistant.
Current date: ${getCurrentDate()}

Given a user's natural language query about financial data for Japanese listed companies, call the appropriate financial tool(s).

## Guidelines

1. **Ticker Resolution**: The tools handle ticker resolution automatically. Pass through whatever the user provides:
   - Securities codes: "7203", "6758", "7974"
   - Company names: "トヨタ", "Sony", "任天堂"
   - EDINET codes: "E02144"

2. **Tool Selection**:
   - For latest financial metrics snapshot (key ratios, ROE, margins, EPS) → get_key_ratios
   - For AI analysis, health score, industry benchmarks → get_analysis
   - For historical financial time series (revenue trends, multi-year data) → get_financial_statements
   - For company basic info (industry, accounting standard, latest financials) → get_company_info
   - For recent earnings disclosures (TDNet 決算短信) → get_earnings

3. **Efficiency**:
   - Prefer specific tools over general ones when possible
   - For point-in-time / latest data → get_key_ratios or get_company_info
   - For trend analysis → get_financial_statements with appropriate years
   - For comparisons between companies, call the same tool for each ticker
   - Always use the smallest data window that answers the question

Call the appropriate tool(s) now.`;
}

const GetFinancialsInputSchema = z.object({
  query: z.string().describe('Natural language query about financial data for Japanese companies'),
});

/**
 * Create a get_financials tool configured with the specified model.
 */
export function createGetFinancials(model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'get_financials',
    description: `Intelligent meta-tool for retrieving Japanese company financial data. Takes a natural language query and automatically routes to appropriate financial data tools. Use for:
- Company financials (revenue, operating income, net income, cash flows)
- Financial metrics and key ratios (ROE, ROIC, margins, EPS, PER, dividend yield)
- Historical trends and time series analysis
- AI analysis and financial health scoring
- Earnings disclosures (TDNet 決算短信)`,
    schema: GetFinancialsInputSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;

      onProgress?.('Fetching...');
      const { response } = await callLlm(input.query, {
        model,
        systemPrompt: buildRouterPrompt(),
        tools: FINANCE_TOOLS,
      });
      const aiMessage = response as AIMessage;

      const toolCalls = aiMessage.tool_calls as ToolCall[];
      if (!toolCalls || toolCalls.length === 0) {
        return formatToolResult({ error: 'No tools selected for query' }, []);
      }

      const toolNames = [...new Set(toolCalls.map(tc => formatSubToolName(tc.name)))];
      onProgress?.(`Fetching from ${toolNames.join(', ')}...`);
      const results = await Promise.all(
        toolCalls.map(async (tc) => {
          try {
            const tool = FINANCE_TOOL_MAP.get(tc.name);
            if (!tool) {
              throw new Error(`Tool '${tc.name}' not found`);
            }
            const rawResult = await tool.invoke(tc.args);
            const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
            const parsed = JSON.parse(result);
            return {
              tool: tc.name,
              args: tc.args,
              data: parsed.data,
              sourceUrls: parsed.sourceUrls || [],
              error: null,
            };
          } catch (error) {
            return {
              tool: tc.name,
              args: tc.args,
              data: null,
              sourceUrls: [],
              error: error instanceof Error ? error.message : String(error),
            };
          }
        })
      );

      const successfulResults = results.filter((r) => r.error === null);
      const failedResults = results.filter((r) => r.error !== null);
      const allUrls = results.flatMap((r) => r.sourceUrls);

      const combinedData: Record<string, unknown> = {};
      for (const result of successfulResults) {
        const ticker = (result.args as Record<string, unknown>).ticker as string | undefined;
        const key = ticker ? `${result.tool}_${ticker}` : result.tool;
        combinedData[key] = result.data;
      }

      if (failedResults.length > 0) {
        combinedData._errors = failedResults.map((r) => ({
          tool: r.tool,
          args: r.args,
          error: r.error,
        }));
      }

      return formatToolResult(combinedData, allUrls);
    },
  });
}
