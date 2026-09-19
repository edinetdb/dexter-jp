/**
 * Subagent type registry.
 *
 * A "subagent" is a fresh, isolated agent loop that the main (leader) agent can
 * delegate a focused sub-task to. Each type below is a small config bundle: a
 * worker system prompt, a tool allow-list, and an iteration budget. The leader
 * picks a type via the `spawn_subagent` tool; the subagent runs to completion
 * and returns a single answer.
 */

import { buildWorkerSystemPrompt } from '../../agent/execution-contracts.js';

/** Configuration for one subagent type. */
export interface SubagentTypeConfig {
  /** Help text shown to the leader so it knows when to pick this type. */
  whenToUse: string;
  /** Self-contained worker system prompt for the subagent. */
  systemPrompt: string;
  /** Allow-list of tool names (must match registry names) the subagent may use. */
  tools: string[];
  /** Maximum agent loop iterations for the subagent. */
  maxIterations: number;
}

/**
 * Tools a subagent may never receive. The delegate tool is listed here so a
 * subagent can never spawn its own subagents — delegation is one level deep.
 */
export const SUBAGENT_DISALLOWED_TOOLS = new Set<string>(['spawn_subagent', 'ask_user_question', 'bash']);

/**
 * Read-only tools available to a general-purpose subagent. Deliberately excludes
 * write/edit/memory-mutation tools: subagents run in parallel and must not race
 * on approval prompts or side effects.
 */
// Tool names match the Dexter JP registry (EDINET DB / J-Quants), not upstream US tools.
const READ_ONLY_TOOLS = [
  'get_financials',
  'get_stock_price',
  'read_filings',
  'company_screener',
  'web_search',
  'x_search',
  'web_fetch',
  'read_file',
  'memory_search',
  'memory_get',
];

export const SUBAGENT_TYPES: Record<string, SubagentTypeConfig> = {
  'general-purpose': {
    whenToUse: 'Multi-step research or analysis on one focused sub-task.',
    systemPrompt: buildWorkerSystemPrompt(
      'You are a general-purpose research worker. Use available tools to gather and analyze what the task requires, then report the findings.',
    ),
    tools: READ_ONLY_TOOLS,
    maxIterations: 8,
  },
  research: {
    whenToUse: 'Gather and synthesize external information on a single topic.',
    systemPrompt: buildWorkerSystemPrompt(
      'You are a research worker. Gather information from the web, news, and filings, cross-check sources, and return a clear, sourced summary.',
    ),
    tools: ['web_search', 'x_search', 'web_fetch', 'read_filings', 'get_stock_price'],
    maxIterations: 8,
  },
  analysis: {
    whenToUse: 'Quantitative financial analysis on specific companies.',
    systemPrompt: buildWorkerSystemPrompt(
      'You are a financial analysis worker. Gather relevant financials, metrics, and market data, then return a focused quantitative analysis supported by evidence.',
    ),
    tools: ['get_financials', 'get_stock_price', 'company_screener', 'read_filings'],
    maxIterations: 8,
  },
};

export const DEFAULT_SUBAGENT_TYPE = 'general-purpose';

/** The subagent types the leader may choose from. */
export const SUBAGENT_TYPE_NAMES = Object.keys(SUBAGENT_TYPES) as [string, ...string[]];

/** Detect explicit X/Twitter research intent without treating a bare variable "x" as intent. */
export function hasExplicitXResearchIntent(task: string): boolean {
  return /\b(?:twitter|tweets?)\b/i.test(task)
    || /(?:^|[\s、。「」『』【】])X(?:上|で|の|を|から|について|検索|調査|投稿|ポスト|ツイート)/i.test(task)
    || /\bX\b\s+(?:posts?|search|research|reactions?|sentiment|social)/i.test(task)
    || /(?:search|research)\s+(?:on\s+)?\bX\b/i.test(task)
    || /X\s*\/\s*Twitter/i.test(task);
}

/** Resolve a type's tool allow-list with safety and task-intent boundaries applied. */
export function resolveSubagentTools(typeKey: string, task = ''): string[] {
  const cfg = SUBAGENT_TYPES[typeKey] ?? SUBAGENT_TYPES[DEFAULT_SUBAGENT_TYPE];
  const allowX = hasExplicitXResearchIntent(task);
  return cfg.tools.filter(t =>
    !SUBAGENT_DISALLOWED_TOOLS.has(t) && (t !== 'x_search' || allowX),
  );
}
