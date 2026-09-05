import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { translateSdkMessage, displayToolName, type TranslateContext } from './sdk-message-translate.js';
import type { AgentEvent } from './types.js';

class Recorder {
  readonly seenTools: string[] = [];
  readonly finalAnswers: string[] = [];
  terminals = 0;
  readonly ctx: TranslateContext;
  constructor(overrides: Partial<TranslateContext> = {}) {
    this.ctx = {
      model: 'claude-fable-5',
      maxTurns: 40,
      onToolSeen: (n) => this.seenTools.push(n),
      onFinalAnswer: (t) => this.finalAnswers.push(t),
      onTerminal: () => { this.terminals += 1; },
      ...overrides,
    };
  }
}

function ctx(overrides: Partial<TranslateContext> = {}): Recorder {
  return new Recorder(overrides);
}

// Helper to cast a synthetic object to SDKMessage for the pure translator.
const msg = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage;

describe('translateSdkMessage — assistant', () => {
  test('text-only assistant sets final answer, no thinking', () => {
    const c = ctx();
    const events = translateSdkMessage(
      msg({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }),
      c.ctx,
    );
    expect(events).toHaveLength(0);
    expect(c.finalAnswers).toContain('Hello');
  });

  test('tool_use emits tool_start and records tool seen', () => {
    const c = ctx();
    const events = translateSdkMessage(
      msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool_use', id: 'tu1', name: 'mcp__dexter__get_key_ratios', input: { ticker: '7203' } },
          ],
        },
      }),
      c.ctx,
    );
    const starts = events.filter((e) => e.type === 'tool_start');
    expect(starts).toHaveLength(1);
    const start = starts[0] as Extract<AgentEvent, { type: 'tool_start' }>;
    expect(start.tool).toBe('get_key_ratios'); // namespace stripped
    expect(start.toolCallId).toBe('tu1');
    expect(start.args).toEqual({ ticker: '7203' });
    expect(c.seenTools).toContain('mcp__dexter__get_key_ratios');
    // Accompanying text becomes a thinking line when tools are also present.
    expect(events.some((e) => e.type === 'thinking')).toBe(true);
  });

  test('assistant error surfaces a thinking line', () => {
    const c = ctx();
    const events = translateSdkMessage(
      msg({ type: 'assistant', error: 'model_not_found', message: { content: [] } }),
      c.ctx,
    );
    const thinking = events.find((e) => e.type === 'thinking') as Extract<AgentEvent, { type: 'thinking' }>;
    expect(thinking).toBeDefined();
    expect(thinking.message).toContain("claude-fable-5");
  });

  test('thinking block is surfaced', () => {
    const c = ctx();
    const events = translateSdkMessage(
      msg({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'reasoning…' }] } }),
      c.ctx,
    );
    expect(events).toEqual([{ type: 'thinking', message: 'reasoning…' }]);
  });
});

describe('translateSdkMessage — result (terminal)', () => {
  test('success result captures answer, marks terminal, extracts usage', () => {
    const c = ctx();
    const events = translateSdkMessage(
      msg({
        type: 'result',
        subtype: 'success',
        result: 'The answer is 42.',
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
      c.ctx,
    );
    expect(events).toHaveLength(0); // translator does not emit `done` itself
    expect(c.finalAnswers).toContain('The answer is 42.');
    expect(c.terminals).toBe(1);
  });

  test.each([
    ['error_max_turns', 'maximum number of turns'],
    ['error_max_budget_usd', 'cost budget'],
    ['error_during_execution', 'Error during execution'],
  ])('error result %s produces a descriptive answer + terminal', (subtype, needle) => {
    const c = ctx();
    translateSdkMessage(msg({ type: 'result', subtype, errors: [] }), c.ctx);
    expect(c.terminals).toBe(1);
    expect(c.finalAnswers.join(' ')).toContain(needle);
  });

  test('usage callback receives tokens including cache', () => {
    let usage: unknown;
    const c = ctx({ onUsage: (u) => { usage = u; } });
    translateSdkMessage(
      msg({
        type: 'result',
        subtype: 'success',
        result: 'x',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
      }),
      c.ctx,
    );
    expect(usage).toEqual({ inputTokens: 13, outputTokens: 5, totalTokens: 18 });
  });
});

describe('translateSdkMessage — system subtypes', () => {
  test('init emits nothing', () => {
    const c = ctx();
    expect(translateSdkMessage(msg({ type: 'system', subtype: 'init' }), c.ctx)).toHaveLength(0);
  });

  test('permission_denied surfaces a blocked line', () => {
    const c = ctx();
    const events = translateSdkMessage(
      msg({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'nope' }),
      c.ctx,
    );
    const t = events[0] as Extract<AgentEvent, { type: 'thinking' }>;
    expect(t.type).toBe('thinking');
    expect(t.message).toContain('Blocked tool');
    expect(t.message).toContain('Bash');
  });

  test('api_retry surfaces a retry line', () => {
    const c = ctx();
    const events = translateSdkMessage(
      msg({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, error: 'overloaded' }),
      c.ctx,
    );
    expect((events[0] as { message: string }).message).toContain('Retrying');
  });

  test('unknown system subtype emits nothing (quiet)', () => {
    const c = ctx();
    expect(translateSdkMessage(msg({ type: 'system', subtype: 'zzz_future' }), c.ctx)).toHaveLength(0);
  });
});

describe('translateSdkMessage — other top-level types', () => {
  test('tool_progress maps to tool_progress event', () => {
    const c = ctx();
    const events = translateSdkMessage(
      msg({ type: 'tool_progress', tool_name: 'mcp__dexter__get_earnings', tool_use_id: 'x', elapsed_time_seconds: 3.4 }),
      c.ctx,
    );
    const p = events[0] as Extract<AgentEvent, { type: 'tool_progress' }>;
    expect(p.type).toBe('tool_progress');
    expect(p.tool).toBe('get_earnings');
    expect(p.toolCallId).toBe('x');
  });

  test('auth_status error surfaces a line; healthy auth_status is quiet', () => {
    const c = ctx();
    expect(translateSdkMessage(msg({ type: 'auth_status', isAuthenticating: false }), c.ctx)).toHaveLength(0);
    const withErr = translateSdkMessage(msg({ type: 'auth_status', error: 'bad token' }), c.ctx);
    expect(withErr).toHaveLength(1);
  });

  test('rate_limit_event only surfaces degraded status', () => {
    const c = ctx();
    expect(
      translateSdkMessage(msg({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), c.ctx),
    ).toHaveLength(0);
    expect(
      translateSdkMessage(msg({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }), c.ctx),
    ).toHaveLength(1);
  });

  test.each(['user', 'stream_event', 'tool_use_summary', 'prompt_suggestion'])(
    'informational type %s emits nothing',
    (type) => {
      const c = ctx();
      expect(translateSdkMessage(msg({ type }), c.ctx)).toHaveLength(0);
    },
  );

  test('UNKNOWN top-level type degrades to a diagnostic thinking line (never dropped)', () => {
    const c = ctx();
    const events = translateSdkMessage(msg({ type: 'some_future_frame_v9' }), c.ctx);
    expect(events).toHaveLength(1);
    const t = events[0] as Extract<AgentEvent, { type: 'thinking' }>;
    expect(t.type).toBe('thinking');
    expect(t.message).toContain('unhandled message type');
    expect(t.message).toContain('some_future_frame_v9');
  });
});

describe('displayToolName', () => {
  test('strips the mcp__dexter__ prefix', () => {
    expect(displayToolName('mcp__dexter__get_key_ratios')).toBe('get_key_ratios');
    expect(displayToolName('AskUserQuestion')).toBe('AskUserQuestion');
  });
});
