/**
 * Pure SDKMessage → Dexter AgentEvent translation.
 *
 * Kept separate from AgentSdkAgent so the EXHAUSTIVE switch over the SDKMessage
 * union can be unit-tested with synthetic messages, with no SDK subprocess.
 *
 * Contract: every message maps to zero or more AgentEvents. An UNKNOWN top-level
 * `type` degrades to a single `thinking` diagnostic (never dropped silently). The
 * translator never yields a `done` for non-terminal frames — the caller owns turn
 * termination and spinner-close so it can guarantee a `done` even if the stream
 * ends abruptly.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, TokenUsage } from './types.js';

export const DEXTER_MCP_PREFIX = 'mcp__dexter__';

export interface TranslateContext {
  /** Model id, used for error-message wording. */
  model: string;
  /** Max turns, used for max-turns error wording. */
  maxTurns: number;
  /** Records tool_use names seen (for the "no built-ins" audit). */
  onToolSeen?: (name: string) => void;
  /** Receives the final answer text when a success/terminal result arrives. */
  onFinalAnswer?: (text: string) => void;
  /** Receives usage when a result message arrives. */
  onUsage?: (usage: TokenUsage | undefined) => void;
  /** Signals a terminal result was translated (caller stops emitting its own done). */
  onTerminal?: () => void;
}

/** Strip the mcp__dexter__ namespace for display. */
export function displayToolName(name: string): string {
  return name.startsWith(DEXTER_MCP_PREFIX) ? name.slice(DEXTER_MCP_PREFIX.length) : name;
}

function describeAssistantError(kind: string, model: string): string {
  switch (kind) {
    case 'model_not_found':
      return `Model '${model}' was not found. Try a supported model (claude-fable-5, claude-opus-4-8, claude-sonnet-4-6).`;
    case 'rate_limit':
      return 'Rate limit reached. Wait and retry, or check your Claude plan limits.';
    case 'authentication_failed':
      return 'Authentication failed. Ensure you are logged in to Claude Code, or that your credentials are valid.';
    case 'oauth_org_not_allowed':
      return 'Your organization is not allowed to use the Agent SDK with this login. See Anthropic help.';
    case 'billing_error':
      return 'A billing error occurred on the resolved credential path.';
    case 'overloaded':
      return 'The service is temporarily overloaded. Retry shortly.';
    case 'max_output_tokens':
      return 'The response hit the maximum output length.';
    default:
      return `Assistant error: ${kind}`;
  }
}

function describeResultError(subtype: string, errors: string[], maxTurns: number): string {
  const detail = errors.length ? ` (${errors.join('; ')})` : '';
  switch (subtype) {
    case 'error_max_turns':
      return `Reached the maximum number of turns (${maxTurns}). The task did not complete in the allotted steps.${detail}`;
    case 'error_max_budget_usd':
      return `Stopped: reached the configured cost budget.${detail}`;
    case 'error_max_structured_output_retries':
      return `Stopped: could not produce valid structured output.${detail}`;
    case 'error_during_execution':
    default:
      return `Error during execution${detail || '.'}`;
  }
}

function extractUsage(message: unknown): TokenUsage | undefined {
  const usage = (message as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const input = Number(usage.input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
  const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
  const total = input + output + cacheRead + cacheCreate;
  if (total === 0) return undefined;
  return { inputTokens: input + cacheRead + cacheCreate, outputTokens: output, totalTokens: total };
}

/**
 * Translate one SDKMessage into AgentEvents (excluding the terminal `done`, which
 * the caller emits so it can guarantee one even on abrupt stream end — except for
 * `result`, where the answer text is captured via onFinalAnswer/onTerminal).
 */
export function translateSdkMessage(message: SDKMessage, ctx: TranslateContext): AgentEvent[] {
  const events: AgentEvent[] = [];

  switch (message.type) {
    case 'assistant': {
      const errKind = (message as { error?: string }).error;
      if (errKind) {
        events.push({ type: 'thinking', message: describeAssistantError(errKind, ctx.model) });
      }
      const content = ((message as { message?: { content?: unknown[] } }).message?.content ?? []) as Array<
        Record<string, unknown>
      >;
      let text = '';
      const hasToolUse = content.some((b) => b.type === 'tool_use');
      for (const block of content) {
        const t = block.type as string | undefined;
        if (t === 'text' && typeof block.text === 'string') {
          text += block.text;
        } else if (t === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          events.push({ type: 'thinking', message: block.thinking.trim() });
        } else if (t === 'tool_use') {
          const name = String(block.name ?? 'tool');
          ctx.onToolSeen?.(name);
          events.push({
            type: 'tool_start',
            tool: displayToolName(name),
            args: (block.input as Record<string, unknown> | undefined) ?? {},
            toolCallId: String(block.id ?? ''),
          });
        }
      }
      if (text.trim()) {
        ctx.onFinalAnswer?.(text);
        if (hasToolUse) events.push({ type: 'thinking', message: text.trim() });
      }
      return events;
    }

    case 'result': {
      const usage = extractUsage(message);
      ctx.onUsage?.(usage);
      const subtype = (message as { subtype?: string }).subtype ?? '';
      if (subtype === 'success') {
        ctx.onFinalAnswer?.((message as { result?: string }).result ?? '');
      } else {
        const errors = (message as { errors?: string[] }).errors ?? [];
        ctx.onFinalAnswer?.(describeResultError(subtype, errors, ctx.maxTurns));
      }
      ctx.onTerminal?.();
      return events;
    }

    case 'system': {
      const subtype = (message as { subtype?: string }).subtype;
      switch (subtype) {
        case 'init':
          return events;
        case 'permission_denied': {
          const toolName = (message as { tool_name?: string }).tool_name ?? 'tool';
          const reason = (message as { message?: string }).message;
          events.push({
            type: 'thinking',
            message: `Blocked tool '${displayToolName(toolName)}'${reason ? `: ${reason}` : ''}`,
          });
          return events;
        }
        case 'api_retry': {
          const attempt = (message as { attempt?: number }).attempt;
          const max = (message as { max_retries?: number }).max_retries;
          const err = (message as { error?: string }).error;
          events.push({
            type: 'thinking',
            message: `Retrying API call (attempt ${attempt ?? '?'}/${max ?? '?'})${err ? ` after ${err}` : ''}…`,
          });
          return events;
        }
        case 'model_refusal_fallback':
        case 'model_refusal_no_fallback': {
          const content = (message as { content?: string }).content;
          events.push({ type: 'thinking', message: content ? `Model refusal: ${content}` : 'Model refused the request.' });
          return events;
        }
        case 'compact_boundary':
          events.push({ type: 'thinking', message: 'Context compacted.' });
          return events;
        default:
          return events;
      }
    }

    case 'tool_progress': {
      const name = (message as { tool_name?: string }).tool_name ?? 'tool';
      const id = (message as { tool_use_id?: string }).tool_use_id;
      const secs = (message as { elapsed_time_seconds?: number }).elapsed_time_seconds;
      events.push({
        type: 'tool_progress',
        tool: displayToolName(name),
        message: secs !== undefined ? `Working… ${Math.round(secs)}s` : 'Working…',
        toolCallId: id,
      });
      return events;
    }

    case 'auth_status': {
      const authing = (message as { isAuthenticating?: boolean }).isAuthenticating;
      const err = (message as { error?: string }).error;
      if (err) events.push({ type: 'thinking', message: `Authentication issue: ${err}` });
      else if (authing) events.push({ type: 'thinking', message: 'Authenticating…' });
      return events;
    }

    case 'rate_limit_event': {
      const info = (message as { rate_limit_info?: { status?: string } }).rate_limit_info;
      const status = info?.status;
      if (status && status !== 'allowed' && status !== 'allowed_warning') {
        events.push({ type: 'thinking', message: `Rate limit status: ${status}` });
      }
      return events;
    }

    case 'user':
    case 'stream_event':
    case 'tool_use_summary':
    case 'prompt_suggestion':
      // No Dexter UI equivalent — intentionally emit nothing.
      return events;

    default:
      // Exhaustiveness guard: unknown/future top-level type degrades to a
      // diagnostic thinking line and is never silently dropped.
      events.push({
        type: 'thinking',
        message: `[sdk] unhandled message type: ${String((message as { type?: string }).type)}`,
      });
      return events;
  }
}
