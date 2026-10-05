/**
 * Rich description for the web_search tool.
 * Used in the system prompt to guide the LLM on when and how to use this tool.
 */
export const WEB_SEARCH_DESCRIPTION = `
Search the web for current information on any topic. Returns relevant search results with URLs and content snippets.

## When to Use

- Current stock prices for equities (EDINET DB does not provide price data; use web search or J-Quants)
- Factual questions about entities (companies, people, organizations) where status can change
- Current events, breaking news, recent developments
- Technology updates, product announcements, industry trends
- Verifying claims about real-world state (public/private, active/defunct, current leadership)
- Research on topics outside of structured financial data

## When NOT to Use

- Structured financial data (company financials, securities reports, key ratios - use get_financials instead)
- Pure conceptual/definitional questions ("What is a DCF?")

## Usage Notes

- Provide specific, well-formed search queries for best results
- Returns up to 5 results with URLs and content snippets
- Use for supplementary research when get_financials doesn't cover the topic
`.trim();

export { tavilySearch } from './tavily.js';
export { exaSearch } from './exa.js';
export { perplexitySearch } from './perplexity.js';
export { langSearch } from './langsearch.js';
export { youSearch } from './you.js';
export { xSearchTool, X_SEARCH_DESCRIPTION } from './x-search.js';
export { createWebSearchTool, type WebSearchProvider } from './web-search.js';

import type { StructuredToolInterface } from '@langchain/core/tools';
import { createWebSearchTool as buildWebSearch, type WebSearchProvider } from './web-search.js';
import { exaSearch as exaSearchTool } from './exa.js';
import { perplexitySearch as perplexitySearchTool } from './perplexity.js';
import { tavilySearch as tavilySearchTool } from './tavily.js';
import { langSearch as langSearchTool } from './langsearch.js';

/**
 * Build a raw web_search tool for Claude Agent SDK mode from whichever provider
 * keys are set. Returns null when no provider is configured. Unlike the registry
 * version, this does not consult user settings for a preferred provider order —
 * SDK mode keeps configuration minimal. The returned tool performs no internal
 * LLM call; it aggregates raw provider results.
 */
export function buildWebSearchToolForSdk(): StructuredToolInterface | null {
  const providers: WebSearchProvider[] = [];
  if (process.env.EXASEARCH_API_KEY) providers.push({ id: 'exa', name: 'Exa', tool: exaSearchTool });
  if (process.env.PERPLEXITY_API_KEY) providers.push({ id: 'perplexity', name: 'Perplexity', tool: perplexitySearchTool });
  if (process.env.TAVILY_API_KEY) providers.push({ id: 'tavily', name: 'Tavily', tool: tavilySearchTool });
  if (process.env.LANGSEARCH_API_KEY) providers.push({ id: 'langsearch', name: 'LangSearch', tool: langSearchTool });
  if (providers.length === 0) return null;
  return buildWebSearch(providers);
}
