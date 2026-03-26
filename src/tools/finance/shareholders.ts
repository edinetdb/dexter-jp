import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { resolveEdinetCode } from './resolver.js';
import { formatToolResult } from '../types.js';

const ShareholdersInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "Securities code (e.g. '7203') or EDINET code (e.g. 'E02144'). Company names also work."
    ),
});

export const getShareholders = new DynamicStructuredTool({
  name: 'get_shareholders',
  description: `Retrieves large shareholding reports (大量保有報告書) for a company. Shows who holds significant stakes (5%+). Each entry includes: holder name, holding ratio (%), shares held, purpose of holding, and filing date. Data sourced from EDINET large shareholding reports. Use to analyze ownership structure, institutional holdings, and activist investors.`,
  schema: ShareholdersInputSchema,
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const { data, url } = await api.get(`/companies/${edinetCode}/shareholders`, {});
    return formatToolResult(data.shareholders || data, [url]);
  },
});
