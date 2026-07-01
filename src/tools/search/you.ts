import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult, parseSearchResults } from '../types.js';
import { logger } from '@/utils';

const YOU_API_BASE = 'https://api.you.com/v1';

interface YouSearchResponse {
  results?: Array<{ url: string; title?: string; snippet?: string }>;
  agent_results?: Array<{ url: string; title?: string; snippet?: string }>;
}

function parseYouSearchResponse(response: unknown): { parsed: unknown; urls: string[] } {
  const parsed = response as YouSearchResponse;
  let urls: string[] = [];

  // You.com returns results in agent_results or results field
  const results = parsed?.agent_results ?? parsed?.results ?? [];
  if (Array.isArray(results)) {
    urls = results
      .map((r) => r.url)
      .filter((url): url is string => Boolean(url));
  }

  return { parsed: response, urls };
}

export const youSearch = new DynamicStructuredTool({
  name: 'web_search',
  description:
    'Search the web for current information on any topic. Returns relevant search results with URLs and content snippets.',
  schema: z.object({
    query: z.string().describe('The search query to look up on the web'),
  }),
  func: async (input) => {
    try {
      const apiKey = process.env.YOUCOM_API_KEY;
      if (!apiKey) {
        throw new Error('YOUCOM_API_KEY is not set');
      }

      const url = new URL(`${YOU_API_BASE}/agents/search`);
      url.searchParams.set('input', input.query);
      url.searchParams.set('num_results', '5');

      const response = await fetch(url.toString(), {
        headers: {
          'X-Api-Key': apiKey,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`You.com API error: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      const { parsed, urls } = parseYouSearchResponse(result);
      return formatToolResult(parsed, urls);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[You.com API] error: ${message}`);
      throw new Error(`[You.com API] ${message}`);
    }
  },
});
