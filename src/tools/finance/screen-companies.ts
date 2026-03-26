import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { callLlm } from '../../model/llm.js';
import { formatToolResult } from '../types.js';
import { getCurrentDate } from '../../agent/prompts.js';
import { api } from './api.js';

/**
 * Rich description for the screen_companies tool.
 */
export const SCREEN_COMPANIES_DESCRIPTION = `
Screens for Japanese listed companies matching financial criteria. Takes a natural language query describing the screening criteria and returns matching companies with their metric values.

## When to Use

- Finding companies by financial criteria (e.g., "ROE 15%以上 and equity ratio above 50%")
- Screening for value, growth, dividend, or quality stocks
- Filtering by valuation ratios, profitability metrics, or growth rates
- Filtering by industry (e.g., "情報・通信業", "医薬品")
- Finding companies matching a specific investment thesis

## When NOT to Use

- Looking up a specific company's financials (use get_financials)
- Reading securities reports (use read_filings)
- General web searches (use web_search)

## Usage Notes

- Call ONCE with the complete natural language query describing your screening criteria
- The tool translates your criteria into exact API filters automatically
- Returns matching companies with the metric values used for screening
- Supports 100+ metrics including ROE, ROIC, operating margin, equity ratio, dividend yield, revenue CAGR, etc.
`.trim();

// Available metrics for the EDINET DB screener
const AVAILABLE_METRICS = `
Supported metrics (use exact keys):
- roe: Return on Equity (%)
- roic: Return on Invested Capital (%)
- roa: Return on Assets (%)
- operating-margin: Operating profit margin (%)
- net-margin: Net profit margin (%)
- equity-ratio: Equity to assets ratio (%)
- per: Price-to-Earnings Ratio
- pbr: Price-to-Book Ratio
- eps: Earnings Per Share (JPY)
- bps: Book Value Per Share (JPY)
- dividend-yield: Dividend yield (%)
- payout-ratio: Dividend payout ratio (%)
- revenue: Total revenue (millions of JPY)
- revenue-growth: Revenue YoY growth (%)
- ni-growth: Net income YoY growth (%)
- eps-growth: EPS YoY growth (%)
- revenue-cagr-3y: Revenue 3-year CAGR (%)
- oi-cagr-3y: Operating income 3-year CAGR (%)
- ni-cagr-3y: Net income 3-year CAGR (%)
- eps-cagr-3y: EPS 3-year CAGR (%)
- health-score: Financial health score (0-100)
- current-ratio: Current ratio
- de-ratio: Debt-to-Equity ratio
- free-cf: Free cash flow (millions of JPY)
- ebitda: EBITDA (millions of JPY)
- financial-leverage: Financial leverage ratio

Operators: gte (>=), lte (<=), gt (>), lt (<), eq (=)
Values use display units: ROE in %, revenue in millions of JPY.

Industries (Japanese, exact match):
情報・通信業, 卸売業, 電気機器, 輸送用機器, 医薬品, 銀行業, 小売業, サービス業, 化学, 機械, 建設業, 不動産業, 食料品, 鉄鋼, 証券・商品先物取引業, 保険業, etc.
`.trim();

const ScreenerConditionSchema = z.object({
  conditions: z.array(z.object({
    metric: z.string().describe('Metric key from the available metrics list'),
    operator: z.enum(['gte', 'lte', 'gt', 'lt', 'eq']).describe('Comparison operator'),
    value: z.number().describe('Threshold value in display units'),
  })).describe('Array of screening conditions to apply (AND logic)'),
  industry: z.string().optional().describe('Filter by industry (Japanese name, exact match)'),
  limit: z.number().default(25).describe('Maximum number of results (default: 25, max: 200)'),
  sort_by: z.string().optional().describe('Sort results by this metric key'),
});

type ScreenerConditions = z.infer<typeof ScreenerConditionSchema>;

function buildScreenerPrompt(): string {
  return `You are a Japanese stock screening assistant.
Current date: ${getCurrentDate()}

Given a user's natural language query about stock screening criteria, produce the structured screening conditions.

## Available Metrics

${AVAILABLE_METRICS}

## Guidelines

1. Map user criteria to exact metric keys from the list above
2. Choose the correct operator:
   - "以下", "below", "under", "less than" → lte
   - "以上", "above", "over", "greater than", "more than" → gte
   - "equal to", "exactly" → eq
3. Use reasonable defaults:
   - If the user says "高ROE" without a number, use gte 15
   - If the user says "高配当" without a number, use gte 3
   - If the user says "割安" consider PER lte 15 or PBR lte 1
4. Set limit to 25 unless the user specifies otherwise
5. For industry filters, use Japanese industry names (exact match)
6. If the user mentions sorting, set sort_by to the relevant metric

Return only the structured output fields.`;
}

const ScreenCompaniesInputSchema = z.object({
  query: z.string().describe('Natural language query describing company screening criteria'),
});

/**
 * Create a screen_companies tool configured with the specified model.
 */
export function createScreenCompanies(model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'company_screener',
    description: `Screens for Japanese listed companies matching financial criteria. Takes a natural language query and returns matching companies with metric values. Use for:
- Finding companies by valuation (PER, PBR)
- Screening by profitability (margins, ROE, ROA, ROIC)
- Filtering by growth rates (revenue, earnings, EPS growth)
- Dividend screening (yield, payout ratio)
- Filtering by industry (e.g., "情報・通信業", "医薬品")`,
    schema: ScreenCompaniesInputSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;

      // LLM structured output — translate natural language → screening conditions
      onProgress?.('Building screening criteria...');
      let conditions: ScreenerConditions;
      try {
        const { response } = await callLlm(input.query, {
          model,
          systemPrompt: buildScreenerPrompt(),
          outputSchema: ScreenerConditionSchema,
        });
        conditions = ScreenerConditionSchema.parse(response);
      } catch (error) {
        return formatToolResult(
          {
            error: 'Failed to parse screening criteria',
            details: error instanceof Error ? error.message : String(error),
          },
          [],
        );
      }

      // POST to screener API
      onProgress?.('Screening companies...');
      try {
        const body: Record<string, unknown> = {
          conditions: conditions.conditions,
          limit: conditions.limit,
        };
        if (conditions.industry) body.industry = conditions.industry;
        if (conditions.sort_by) body.sort_by = conditions.sort_by;

        const { data, url } = await api.post('/companies/screen', body);
        return formatToolResult(data, [url]);
      } catch (error) {
        return formatToolResult(
          {
            error: 'Screener request failed',
            details: error instanceof Error ? error.message : String(error),
            conditions: conditions.conditions,
          },
          [],
        );
      }
    },
  });
}
