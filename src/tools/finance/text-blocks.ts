import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { resolveEdinetCode } from './resolver.js';
import { formatToolResult } from '../types.js';

const TextBlocksInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "Securities code (e.g. '7203') or EDINET code (e.g. 'E02144'). Company names also work."
    ),
  fiscal_year: z
    .number()
    .optional()
    .describe(
      'Fiscal year (e.g. 2025). If omitted, returns the latest available year.'
    ),
});

export const getTextBlocks = new DynamicStructuredTool({
  name: 'get_text_blocks',
  description: `Retrieves full text from a company's annual securities report (有価証券報告書). Returns four sections:
- 事業の状況 (Business Overview): business description, products, markets
- 事業等のリスク (Business Risks): risk factors, regulatory risks, market risks
- 経営者による分析 (Management Analysis / MD&A): management's discussion and analysis of financial condition
- 経営方針 (Management Policies): strategy, challenges, outlook

Use this when analyzing business risks, management discussion, company strategy, or any qualitative information from securities reports. Equivalent to reading a 10-K annual report in the US.`,
  schema: TextBlocksInputSchema,
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const params: Record<string, string | number | undefined> = {};
    if (input.fiscal_year) {
      params.fiscal_year = input.fiscal_year;
    }
    // Annual report text is immutable once filed
    const { data, url } = await api.get(`/companies/${edinetCode}/text-blocks`, params, { cacheable: true });
    return formatToolResult(data, [url]);
  },
});
