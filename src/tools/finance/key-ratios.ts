import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { resolveEdinetCode } from './resolver.js';
import { formatToolResult } from '../types.js';
import { TTL_1H, TTL_6H } from './utils.js';

const KeyRatiosInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "Securities code (e.g. '7203') or EDINET code (e.g. 'E02144'). Company names also work."
    ),
});

export const getKeyRatios = new DynamicStructuredTool({
  name: 'get_key_ratios',
  description:
    'Fetches the latest financial metrics snapshot for a Japanese company, including latest financials (revenue, operating income, net income, ROE, equity ratio, EPS, PER, BPS), credit score (0-100), and company info (industry, accounting standard).',
  schema: KeyRatiosInputSchema,
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const { data: response, url } = await api.get(
      `/companies/${edinetCode}`,
      {},
      { cacheable: true, ttlMs: TTL_1H },
    );
    // API returns {data: {name, industry, latest_financials, credit_score, ...}, meta: {...}}
    return formatToolResult(response.data || response, [url]);
  },
});

const AnalysisInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "Securities code (e.g. '7203') or EDINET code (e.g. 'E02144'). Company names also work."
    ),
});

export const getAnalysis = new DynamicStructuredTool({
  name: 'get_analysis',
  description:
    'Fetches AI-powered analysis of a Japanese company including: financial health score, AI-generated company summary, and score history. Based on up to 6 years of financial data from annual securities reports.',
  schema: AnalysisInputSchema,
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const { data: response, url } = await api.get(
      `/companies/${edinetCode}/analysis`,
      {},
      { cacheable: true, ttlMs: TTL_6H },
    );
    return formatToolResult(response.data || response, [url]);
  },
});
