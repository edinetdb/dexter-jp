/**
 * Context compaction module — LLM summarization.
 *
 * Instead of dropping old tool results (losing information permanently),
 * this module asks a fast LLM to summarize sanitized conversation state
 * and tool evidence. The summary replaces the raw results in
 * subsequent iteration prompts while preserving key information.
 */

import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { callLlm } from '../model/llm.js';
import { resolveProvider } from '../providers.js';
import type { TokenUsage } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stop attempting compaction after this many consecutive failures. */
export const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3;

/** Skip compaction when there are fewer tool results than this (clearing is fine). */
export const MIN_TOOL_RESULTS_FOR_COMPACTION = 3;

// ---------------------------------------------------------------------------
// Compaction prompt
// ---------------------------------------------------------------------------

const COMPACTION_SYSTEM_PROMPT = [
  'You compact transient conversation state for an agent runtime.',
  'Return only the requested structured summary.',
  'Do not include chain-of-thought, hidden reasoning, drafts, or an analysis transcript.',
  'Preserve evidence, conclusions, unresolved questions, and concrete next steps.',
].join('\n');

const BASE_COMPACT_PROMPT = [
  'Create a self-contained continuation summary of the research session below.',
  'The summary must preserve the context required to continue the current conversation.',
  '',
  'Include:',
  '1. Original query and user intent.',
  '2. Verified evidence and important numerical data from tool results.',
  '3. Final conclusions already reached.',
  '4. Errors or data gaps that still matter.',
  '5. Pending work and concrete next steps.',
  '',
  'Do not include private chain-of-thought, hidden reasoning, exploratory drafts, or failed hypotheses.',
  'Do not turn this summary into long-term memory. It remains transient conversation state.',
].join('\n');

export const compactionSummarySchema = z.object({
  summary: z.string().min(1).describe('Continuation context only; no hidden reasoning or analysis transcript.'),
}).strict();

export function parseCompactionSummaryPayload(payload: unknown): string {
  return compactionSummarySchema.parse(payload).summary.trim();
}

function extractVisibleText(message: BaseMessage): string {
  if (typeof message.content === 'string') {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .flatMap((part) => {
      if (!part || typeof part !== 'object') {
        return [];
      }
      const typed = part as { type?: string; text?: string };
      return typed.type === 'text' && typeof typed.text === 'string'
        ? [typed.text]
        : [];
    })
    .join('\n')
    .trim();
}

/**
 * Build compaction input from user-visible conversation state plus tool evidence.
 * System messages and text attached to tool-calling AI messages are excluded so
 * durable prompt context and intermediate model reasoning cannot enter summaries.
 */
export function buildCompactionSource(
  messages: BaseMessage[],
  toolResults: string,
): string {
  const sections: string[] = [];

  for (const message of messages) {
    if (message instanceof HumanMessage) {
      const text = extractVisibleText(message);
      if (text) {
        sections.push('User message:\n' + text);
      }
      continue;
    }

    if (message instanceof AIMessage && !(message.tool_calls?.length)) {
      const text = extractVisibleText(message);
      if (text) {
        sections.push('Assistant final answer:\n' + text);
      }
    }
  }

  const evidence = toolResults.trim();
  if (evidence) {
    sections.push('Tool evidence:\n' + evidence);
  }

  return sections.join('\n\n');
}

/**
 * Rebuild the trusted prompt after full compaction.
 * Active Skill instructions stay outside the generated summary and remain run-local.
 */
export function rebuildMessagesAfterCompaction(
  baseSystemPrompt: string,
  summary: string,
  query: string,
  activeSkillContracts: string,
): BaseMessage[] {
  const rebuiltSystem = activeSkillContracts.trim()
    ? new SystemMessage(`${baseSystemPrompt}

${activeSkillContracts.trim()}`)
    : new SystemMessage(baseSystemPrompt);

  return [
    rebuiltSystem,
    new HumanMessage(`${query}

${summary}`),
  ];
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildCompactionPrompt(conversationState: string): string {
  return [
    BASE_COMPACT_PROMPT,
    '',
    'Conversation state to compact:',
    conversationState,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Summary formatting
// ---------------------------------------------------------------------------

/**
 * Normalize the structured summary before it enters conversation state.
 */
export function formatCompactSummary(summary: string): string {
  return summary.trim();
}

/**
 * Build the message that frames the compaction summary for the LLM.
 */
export function buildCompactSummaryMessage(summary: string): string {
  const formatted = formatCompactSummary(summary);

  return [
    'This session is continuing from compacted conversation state.',
    'The summary contains only the evidence, conclusions, and pending work needed to continue.',
    '',
    formatted,
    '',
    'Continue working toward the original query without recapping the compaction event.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Core compaction function
// ---------------------------------------------------------------------------

export interface CompactContextParams {
  /** Main model name (used to resolve provider and fast model). */
  model: string;
  /** Sanitized user-visible conversation state and tool evidence. */
  conversationState: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface CompactResult {
  /** Formatted summary ready for injection into the iteration prompt. */
  summary: string;
  /** Token usage of the compaction LLM call. */
  usage?: TokenUsage;
}

/**
 * Summarize accumulated tool results into a structured summary using a fast LLM.
 * Throws on failure — caller is responsible for fallback to clearing.
 */
export async function compactContext(params: CompactContextParams): Promise<CompactResult> {
  const { model, conversationState, signal } = params;

  const provider = resolveProvider(model);
  const fastModel = provider.fastModel ?? model;
  const prompt = buildCompactionPrompt(conversationState);

  const result = await callLlm(prompt, {
    model: fastModel,
    systemPrompt: COMPACTION_SYSTEM_PROMPT,
    outputSchema: compactionSummarySchema,
    signal,
  });

  const compactedSummary = parseCompactionSummaryPayload(result.response);
  if (!compactedSummary) {
    throw new Error('Compaction returned an empty summary');
  }

  return {
    summary: buildCompactSummaryMessage(compactedSummary),
    usage: result.usage,
  };
}
