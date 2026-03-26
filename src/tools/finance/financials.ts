import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { resolveEdinetCode } from './resolver.js';
import { formatToolResult } from '../types.js';

const FinancialsInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "Securities code (e.g. '7203' for Toyota) or EDINET code (e.g. 'E02144'). Company names also work (e.g. 'トヨタ', 'Sony')."
    ),
  period: z
    .enum(['annual', 'quarterly'])
    .default('annual')
    .describe(
      "Data period: 'annual' for yearly (default), 'quarterly' for quarterly data (available FY2014-2023)."
    ),
  years: z
    .number()
    .default(3)
    .describe(
      'Number of fiscal years to return (default: 3, max: 6). Returns most recent N years.'
    ),
});

export const getFinancials = new DynamicStructuredTool({
  name: 'get_financial_statements',
  description: `Retrieves comprehensive financial time series for a Japanese listed company. Returns up to 6 fiscal years of: revenue, operating income, net income, total assets, net assets, equity ratio, ROE, EPS, BPS, PER, dividends per share, operating/investing/financing cash flows, gross profit, SGA, depreciation, R&D expenses, current/noncurrent assets, inventories, capex, and more. This single endpoint provides income statement, balance sheet, and cash flow data combined.`,
  schema: FinancialsInputSchema,
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const params: Record<string, string | number> = {
      years: input.years,
      period: input.period,
    };
    const { data, url } = await api.get(`/companies/${edinetCode}/financials`, params);
    return formatToolResult(data.financials || data, [url]);
  },
});

const CompanyInfoInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "Securities code (e.g. '7203') or EDINET code (e.g. 'E02144'). Company names also work."
    ),
});

export const getCompanyInfo = new DynamicStructuredTool({
  name: 'get_company_info',
  description: `Retrieves company details including basic info (name, industry, securities code, accounting standard), latest fiscal year financials (revenue, operating income, net income, total assets, ROE, equity ratio, EPS, PER, BPS), and key ratios (ROIC, financial leverage, asset turnover, net/operating margin, D/E ratio, dividend yield). Also includes financial health score (0-100).`,
  schema: CompanyInfoInputSchema,
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const { data, url } = await api.get(`/companies/${edinetCode}`, {});
    return formatToolResult(data, [url]);
  },
});
