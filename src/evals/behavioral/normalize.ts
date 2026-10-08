import type {
  CanonicalFixtureEvent,
  EvalConfiguration,
  EvalEvent,
  RecordedFixture,
} from './types.js';

const SDK_TOOL_PREFIX = 'mcp__dexter__';

function sdkToolName(name: string): string {
  return name.startsWith(SDK_TOOL_PREFIX) ? name : `${SDK_TOOL_PREFIX}${name}`;
}

function localToolName(name: string): string {
  return name.startsWith(SDK_TOOL_PREFIX) ? name.slice(SDK_TOOL_PREFIX.length) : name;
}

/** Encode safe canonical observations into the two runtime-specific recorded shapes. */
export function encodeRecordedFixture(
  configuration: EvalConfiguration,
  events: readonly CanonicalFixtureEvent[],
): RecordedFixture {
  if (configuration.runtime === 'langchain') {
    return {
      runtime: 'langchain',
      frames: events.map((event) => {
        switch (event.type) {
          case 'tool_call':
            return {
              type: 'ai_message' as const,
              toolCalls: [{ id: event.id, name: event.name, args: event.args }],
            };
          case 'approval_requested':
            return { type: 'approval' as const, operation: event.operation };
          case 'tool_result':
            return {
              type: 'tool_message' as const,
              id: event.id,
              name: event.name,
              status: event.status,
              ...(event.output !== undefined ? { output: event.output } : {}),
            };
          case 'final_response':
            return { type: 'done' as const, answer: event.text };
        }
      }),
    };
  }

  return {
    runtime: 'claude-agent-sdk',
    frames: events.map((event) => {
      switch (event.type) {
        case 'tool_call':
          return {
            type: 'assistant' as const,
            content: [{
              type: 'tool_use' as const,
              id: event.id,
              name: sdkToolName(event.name),
              input: event.args,
            }],
          };
        case 'approval_requested':
          return { type: 'permission' as const, operation: event.operation };
        case 'tool_result':
          return {
            type: 'mcp_result' as const,
            id: event.id,
            name: sdkToolName(event.name),
            status: event.status,
            ...(event.output !== undefined ? { output: event.output } : {}),
          };
        case 'final_response':
          return { type: 'result' as const, result: event.text };
      }
    }),
  };
}

function appendToolCall(events: EvalEvent[], call: {
  id: string;
  name: string;
  args: Readonly<Record<string, unknown>>;
}): void {
  const name = localToolName(call.name);
  if (name === 'skill' && typeof call.args.skill === 'string') {
    events.push({ type: 'skill_discovered', name: call.args.skill });
  }
  events.push({ type: 'tool_call', id: call.id, name, args: call.args });
}

/** Normalize runtime-specific observable records before any assertion is made. */
export function normalizeRecordedFixture(fixture: RecordedFixture): EvalEvent[] {
  const events: EvalEvent[] = [];

  if (fixture.runtime === 'langchain') {
    for (const frame of fixture.frames) {
      switch (frame.type) {
        case 'ai_message':
          for (const call of frame.toolCalls) appendToolCall(events, call);
          break;
        case 'approval':
          events.push({ type: 'approval_requested', operation: frame.operation });
          break;
        case 'tool_message':
          events.push({
            type: 'tool_result',
            id: frame.id,
            name: frame.name,
            status: frame.status,
            ...(frame.output !== undefined ? { output: frame.output } : {}),
          });
          break;
        case 'done':
          events.push({ type: 'final_response', text: frame.answer });
          break;
      }
    }
    return events;
  }

  for (const frame of fixture.frames) {
    switch (frame.type) {
      case 'assistant':
        for (const block of frame.content) {
          appendToolCall(events, {
            id: block.id,
            name: localToolName(block.name),
            args: block.input,
          });
        }
        break;
      case 'permission':
        events.push({ type: 'approval_requested', operation: frame.operation });
        break;
      case 'mcp_result':
        events.push({
          type: 'tool_result',
          id: frame.id,
          name: localToolName(frame.name),
          status: frame.status,
          ...(frame.output !== undefined ? { output: frame.output } : {}),
        });
        break;
      case 'result':
        events.push({ type: 'final_response', text: frame.result });
        break;
    }
  }
  return events;
}