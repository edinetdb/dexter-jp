/**
 * Raw structured screener — the same EDINET DB `/screener` endpoint as
 * `company_screener`, but the caller supplies structured conditions directly
 * instead of a natural-language query that an internal LLM translates.
 *
 * Used by Claude Agent SDK mode, where the main model constructs the screening
 * conditions itself (no internal LLM re-call inside the tool).
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { formatToolResult } from '../types.js';
import { api } from './api.js';
import {
  AVAILABLE_METRICS,
  ScreenerConditionSchema,
  type ScreenerConditions,
} from './screen-companies.js';

export const RAW_SCREENER_DESCRIPTION = `
Screen Japanese listed companies by explicit financial criteria. Supply structured conditions directly (metric key + operator + threshold in display units). AND logic across conditions.

${AVAILABLE_METRICS}
`.trim();

export function createRawScreener(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'screen_companies',
    description: RAW_SCREENER_DESCRIPTION,
    schema: ScreenerConditionSchema,
    func: async (input: ScreenerConditions) => {
      try {
        const params: Record<string, string | number | undefined> = {
          conditions: JSON.stringify(input.conditions),
          limit: input.limit ?? 25,
        };
        if (input.industry) params.industry = input.industry;
        if (input.sort_by) params.sort = input.sort_by;

        const { data, url } = await api.get('/screener', params);
        return formatToolResult(data, [url]);
      } catch (error) {
        return formatToolResult(
          {
            error: 'Screener request failed',
            details: error instanceof Error ? error.message : String(error),
            conditions: input.conditions,
          },
          [],
        );
      }
    },
  });
}
