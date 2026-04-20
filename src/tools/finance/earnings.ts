import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { resolveEdinetCode } from './resolver.js';
import { formatToolResult } from '../types.js';
import { TTL_24H } from './utils.js';

const EarningsInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "Securities code (e.g. '7203') or EDINET code (e.g. 'E02144'). Company names also work."
    ),
  limit: z
    .number()
    .optional()
    .describe('Number of earnings disclosures to return (default: 8, max: 30).'),
});

export const getEarnings = new DynamicStructuredTool({
  name: 'get_earnings',
  description: `Fetches recent TDNet earnings disclosures (決算短信) for a company. Returns quarterly/annual results including: disclosure date, revenue, operating income, net income, EPS, and YoY change rates. Full-year results also include balance sheet and cash flow data. May include full-year forecasts. TDNet data covers the last ~30 days of disclosures. Useful for tracking when companies disclosed results and earnings surprises.`,
  schema: EarningsInputSchema,
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const params: Record<string, string | number> = {
      limit: input.limit ?? 8,
    };
    const { data: response, url } = await api.get(
      `/companies/${edinetCode}/earnings`,
      params,
      { cacheable: true, ttlMs: TTL_24H },
    );
    // API returns {data: {count, earnings: [...], edinet_code}}
    const earningsData = response.data as Record<string, unknown> | undefined;
    return formatToolResult(earningsData?.earnings || response.data || response, [url]);
  },
});
