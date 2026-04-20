import { StructuredToolInterface } from '@langchain/core/tools';
import { createGetFinancials, createReadFilings, createScreenCompanies, getStockPrice, isJQuantsAvailable, STOCK_PRICE_DESCRIPTION } from './finance/index.js';
import { exaSearch, perplexitySearch, tavilySearch, WEB_SEARCH_DESCRIPTION, xSearchTool, X_SEARCH_DESCRIPTION } from './search/index.js';
import { skillTool, SKILL_TOOL_DESCRIPTION } from './skill.js';
import { webFetchTool, WEB_FETCH_DESCRIPTION } from './fetch/web-fetch.js';
import { browserTool, BROWSER_DESCRIPTION } from './browser/browser.js';
import { readFileTool, READ_FILE_DESCRIPTION } from './filesystem/read-file.js';
import { writeFileTool, WRITE_FILE_DESCRIPTION } from './filesystem/write-file.js';
import { editFileTool, EDIT_FILE_DESCRIPTION } from './filesystem/edit-file.js';
import { GET_FINANCIALS_DESCRIPTION } from './finance/get-financials.js';
import { READ_FILINGS_DESCRIPTION } from './finance/read-filings.js';
import { SCREEN_COMPANIES_DESCRIPTION } from './finance/screen-companies.js';
import { heartbeatTool, HEARTBEAT_TOOL_DESCRIPTION } from './heartbeat/heartbeat-tool.js';
import { cronTool, CRON_TOOL_DESCRIPTION } from './cron/cron-tool.js';
import { memoryGetTool, MEMORY_GET_DESCRIPTION, memorySearchTool, MEMORY_SEARCH_DESCRIPTION, memoryUpdateTool, MEMORY_UPDATE_DESCRIPTION } from './memory/index.js';
import { discoverSkills } from '../skills/index.js';

/**
 * A registered tool with its rich description for system prompt injection.
 */
export interface RegisteredTool {
  /** Tool name (must match the tool's name property) */
  name: string;
  /** The actual tool instance */
  tool: StructuredToolInterface;
  /** Rich description for system prompt (includes when to use, when not to use, etc.) */
  description: string;
  /** 1-2 sentence description for token-optimized system prompts. */
  compactDescription: string;
  /** Whether this tool can safely execute concurrently with other concurrent-safe tools. */
  concurrencySafe: boolean;
}

/**
 * Get all registered tools with their descriptions.
 * Conditionally includes tools based on environment configuration.
 *
 * @param model - The model name (needed for tools that require model-specific configuration)
 * @returns Array of registered tools
 */
export function getToolRegistry(model: string): RegisteredTool[] {
  const isPublicGateway = process.env.DEXTER_PUBLIC_GATEWAY === '1';

  const tools: RegisteredTool[] = [
    {
      name: 'get_financials',
      tool: createGetFinancials(model),
      description: GET_FINANCIALS_DESCRIPTION,
      compactDescription: 'Japanese company financials, metrics, earnings, and AI analysis. Handles multi-company/multi-metric queries in one call.',
      concurrencySafe: true,
    },
    {
      name: 'read_filings',
      tool: createReadFilings(model),
      description: READ_FILINGS_DESCRIPTION,
      compactDescription: 'Japanese securities report text (事業の状況, リスク, MD&A) and shareholder data (大量保有報告書).',
      concurrencySafe: true,
    },
    {
      name: 'company_screener',
      tool: createScreenCompanies(model),
      description: SCREEN_COMPANIES_DESCRIPTION,
      compactDescription: 'Screen Japanese listed companies by financial criteria (PER, ROE, growth, margins, etc.).',
      concurrencySafe: true,
    },
    {
      name: 'web_fetch',
      tool: webFetchTool,
      description: WEB_FETCH_DESCRIPTION,
      compactDescription: 'Fetch and extract content from a URL as markdown. Use when you need full article text beyond headlines.',
      concurrencySafe: true,
    },
  ];

  // Tools excluded in public gateway mode (security + Gemini z.literal() incompatibility)
  if (!isPublicGateway) {
    tools.push(
      {
        name: 'browser',
        tool: browserTool,
        description: BROWSER_DESCRIPTION,
        compactDescription: 'JavaScript-rendered pages and interactive navigation. Actions: navigate, snapshot, act, read, close.',
        concurrencySafe: true,
      },
      {
        name: 'read_file',
        tool: readFileTool,
        description: READ_FILE_DESCRIPTION,
        compactDescription: 'Read a local file by path. Returns file content as text.',
        concurrencySafe: true,
      },
      {
        name: 'write_file',
        tool: writeFileTool,
        description: WRITE_FILE_DESCRIPTION,
        compactDescription: 'Create or overwrite a file. Requires user approval.',
        concurrencySafe: false,
      },
      {
        name: 'edit_file',
        tool: editFileTool,
        description: EDIT_FILE_DESCRIPTION,
        compactDescription: 'Edit a file by replacing text. Requires user approval.',
        concurrencySafe: false,
      },
      {
        name: 'heartbeat',
        tool: heartbeatTool,
        description: HEARTBEAT_TOOL_DESCRIPTION,
        compactDescription: 'View or update the periodic heartbeat checklist (.dexter/HEARTBEAT.md).',
        concurrencySafe: true,
      },
      {
        name: 'cron',
        tool: cronTool,
        description: CRON_TOOL_DESCRIPTION,
        compactDescription: 'Manage scheduled cron jobs (create, list, update, delete).',
        concurrencySafe: true,
      },
      {
        name: 'memory_search',
        tool: memorySearchTool,
        description: MEMORY_SEARCH_DESCRIPTION,
        compactDescription: 'Search persistent memory and past conversations for stored facts and preferences.',
        concurrencySafe: true,
      },
      {
        name: 'memory_get',
        tool: memoryGetTool,
        description: MEMORY_GET_DESCRIPTION,
        compactDescription: 'Read specific memory file sections by line range.',
        concurrencySafe: true,
      },
      {
        name: 'memory_update',
        tool: memoryUpdateTool,
        description: MEMORY_UPDATE_DESCRIPTION,
        compactDescription: 'Add, edit, or delete persistent memory entries.',
        concurrencySafe: false,
      },
    );
  }

  // Include stock price tool if J-Quants refresh token is configured
  if (isJQuantsAvailable()) {
    tools.push({
      name: 'get_stock_price',
      tool: getStockPrice,
      description: STOCK_PRICE_DESCRIPTION,
      compactDescription: 'Japanese stock price OHLC and volume from J-Quants (TSE official data).',
      concurrencySafe: true,
    });
  }

  // Include web_search if Exa, Perplexity, or Tavily API key is configured (Exa → Perplexity → Tavily)
  if (process.env.EXASEARCH_API_KEY) {
    tools.push({
      name: 'web_search',
      tool: exaSearch,
      description: WEB_SEARCH_DESCRIPTION,
      compactDescription: 'Search the web for current information. Returns titles, URLs, and highlights.',
      concurrencySafe: true,
    });
  } else if (process.env.PERPLEXITY_API_KEY) {
    tools.push({
      name: 'web_search',
      tool: perplexitySearch,
      description: WEB_SEARCH_DESCRIPTION,
      compactDescription: 'Search the web for current information. Returns an answer with citations.',
      concurrencySafe: true,
    });
  } else if (process.env.TAVILY_API_KEY) {
    tools.push({
      name: 'web_search',
      tool: tavilySearch,
      description: WEB_SEARCH_DESCRIPTION,
      compactDescription: 'Search the web for current information. Returns titles, URLs, and snippets.',
      concurrencySafe: true,
    });
  }

  // Include x_search if X Bearer Token is configured
  if (process.env.X_BEARER_TOKEN) {
    tools.push({
      name: 'x_search',
      tool: xSearchTool,
      description: X_SEARCH_DESCRIPTION,
      compactDescription: 'Search X/Twitter for tweets, profiles, and threads.',
      concurrencySafe: true,
    });
  }

  const availableSkills = discoverSkills();
  if (availableSkills.length > 0) {
    tools.push({
      name: 'skill',
      tool: skillTool,
      description: SKILL_TOOL_DESCRIPTION,
      compactDescription: 'Invoke a specialized skill workflow (e.g., DCF valuation).',
      concurrencySafe: false,
    });
  }

  return tools;
}

/**
 * Build a name → concurrencySafe map for the tool executor.
 */
export function getToolConcurrencyMap(model: string): Map<string, boolean> {
  return new Map(getToolRegistry(model).map(t => [t.name, t.concurrencySafe]));
}

/**
 * Get just the tool instances for binding to the LLM.
 */
export function getTools(model: string): StructuredToolInterface[] {
  return getToolRegistry(model).map((t) => t.tool);
}

/**
 * Build compact tool descriptions for token-optimized system prompts.
 * Uses 1-2 sentence descriptions instead of full multi-paragraph ones.
 * The LLM already has full tool schemas via bindTools().
 */
export function buildCompactToolDescriptions(model: string): string {
  return getToolRegistry(model)
    .map((t) => `- **${t.name}**: ${t.compactDescription}`)
    .join('\n');
}
