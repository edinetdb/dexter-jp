import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { resolveEdinetCode } from './resolver.js';
import { formatToolResult } from '../types.js';

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
    'Fetches the latest financial metrics snapshot for a Japanese company, including key ratios (ROIC, financial leverage, asset turnover, net/operating margin, D/E ratio, dividend yield), latest financials (revenue, operating income, net income, ROE, equity ratio, EPS, PER, BPS), and financial health score (0-100).',
  schema: KeyRatiosInputSchema,
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const { data, url } = await api.get(`/companies/${edinetCode}`, {});
    // Extract key ratios and latest financials from the company endpoint
    const company = data as Record<string, unknown>;
    const snapshot: Record<string, unknown> = {};
    if (company.keyRatios) snapshot.keyRatios = company.keyRatios;
    if (company.latestFinancials) snapshot.latestFinancials = company.latestFinancials;
    if (company.healthScore !== undefined) snapshot.healthScore = company.healthScore;
    if (company.name) snapshot.name = company.name;
    if (company.industry) snapshot.industry = company.industry;
    if (company.secCode) snapshot.secCode = company.secCode;
    if (company.accountingStandard) snapshot.accountingStandard = company.accountingStandard;
    return formatToolResult(snapshot, [url]);
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
    'Fetches AI-powered analysis of a Japanese company including: financial health score (0-100), key financial metrics summary, industry benchmark comparison, and AI-generated company summary. Based on up to 6 years of financial data from annual securities reports.',
  schema: AnalysisInputSchema,
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const { data, url } = await api.get(`/companies/${edinetCode}/analysis`, {});
    return formatToolResult(data, [url]);
  },
});
