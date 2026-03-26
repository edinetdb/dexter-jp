import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { resolveEdinetCode } from './resolver.js';
import { formatToolResult } from '../types.js';
import { getTextBlocks } from './text-blocks.js';
import { getShareholders } from './shareholders.js';

/**
 * Rich description for the read_filings tool.
 */
export const READ_FILINGS_DESCRIPTION = `
Intelligent meta-tool for reading Japanese securities report content. Takes a natural language query and retrieves the relevant text sections from annual securities reports (有価証券報告書).

## When to Use

- Reading annual securities reports (business overview, risk factors, management analysis, strategy)
- Analyzing business risks and challenges
- Understanding management's discussion and analysis (MD&A)
- Company strategy and outlook
- Ownership structure and major shareholders

## When NOT to Use

- Structured financial data (use get_financials)
- Financial metrics and ratios (use get_financials)
- Company screening (use company_screener)
- General web searches (use web_search)

## Usage Notes

- Call ONCE with the complete natural language query
- Handles ticker resolution automatically (7203 → Toyota)
- Returns full text sections from the most recent annual report
- Sections: 事業の状況 (Business), 事業等のリスク (Risks), 経営者による分析 (MD&A), 経営方針 (Strategy)
`.trim();

const ReadFilingsInputSchema = z.object({
  query: z.string().describe('Natural language query about securities report content to read'),
});

/**
 * Create a read_filings tool that retrieves text blocks from securities reports.
 * Simplified compared to the US version — EDINET reports have a fixed structure.
 */
export function createReadFilings(_model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'read_filings',
    description: `Intelligent tool for reading Japanese securities report content. Takes a natural language query and retrieves full text from annual reports (有価証券報告書). Use for:
- Business overview and description (事業の状況)
- Risk factors (事業等のリスク)
- Management analysis / MD&A (経営者による分析)
- Management policies and strategy (経営方針)
- Ownership structure (大量保有報告書)`,
    schema: ReadFilingsInputSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;

      // Extract ticker from query — simple heuristic
      const query = input.query;

      // Try to find a ticker pattern in the query (4-digit number or E+5digits or company name)
      const secCodeMatch = query.match(/\b(\d{4})\b/);
      const edinetCodeMatch = query.match(/\b(E\d{5})\b/);

      // Extract the ticker — fall back to passing the full query as a search term
      let ticker: string;
      if (edinetCodeMatch) {
        ticker = edinetCodeMatch[1];
      } else if (secCodeMatch) {
        ticker = secCodeMatch[1];
      } else {
        // Try to extract a meaningful company name from the query
        // Remove common query words and use what remains
        const cleaned = query
          .replace(/の?(リスク|事業|経営|分析|方針|戦略|有報|有価証券|報告書|テキスト|内容|について|教えて|見せて|読んで|取得)/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        ticker = cleaned || query;
      }

      onProgress?.(`Resolving ${ticker}...`);
      let edinetCode: string;
      try {
        edinetCode = await resolveEdinetCode(ticker);
      } catch {
        return formatToolResult(
          { error: `Could not find company for query: ${query}` },
          [],
        );
      }

      // Check if the query is about shareholders
      const isShareholderQuery = /株主|保有|所有|ownership|shareholder|holder/i.test(query);

      if (isShareholderQuery) {
        onProgress?.('Fetching shareholder data...');
        try {
          const result = await getShareholders.invoke({ ticker: edinetCode });
          const parsed = JSON.parse(typeof result === 'string' ? result : JSON.stringify(result));
          return formatToolResult(parsed.data, parsed.sourceUrls || []);
        } catch (error) {
          return formatToolResult(
            { error: 'Failed to fetch shareholder data', details: error instanceof Error ? error.message : String(error) },
            [],
          );
        }
      }

      // Default: fetch text blocks from annual report
      onProgress?.('Reading securities report...');
      try {
        const result = await getTextBlocks.invoke({ ticker: edinetCode });
        const parsed = JSON.parse(typeof result === 'string' ? result : JSON.stringify(result));
        return formatToolResult(parsed.data, parsed.sourceUrls || []);
      } catch (error) {
        return formatToolResult(
          { error: 'Failed to read securities report', details: error instanceof Error ? error.message : String(error) },
          [],
        );
      }
    },
  });
}
