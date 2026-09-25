import { describe, expect, test } from 'bun:test';
import { AIMessage } from '@langchain/core/messages';
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { createRunContext } from './run-context.js';
import { AgentToolExecutor } from './tool-executor.js';
import { writeMemoInputSchema } from '../memo/document.js';

function responseFor(
  name: string,
  args: Record<string, unknown>,
  id = 'call-1',
): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ id, name, args, type: 'tool_call' }],
  });
}

async function collectEvents(
  executor: AgentToolExecutor,
  name: string,
  args: Record<string, unknown>,
): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const event of executor.executeAll(
    responseFor(name, args),
    createRunContext('test'),
  )) {
    events.push(event as unknown as { type: string; [key: string]: unknown });
  }
  return events;
}

function executorFor(
  tool: StructuredToolInterface,
  requestApproval?: ConstructorParameters<typeof AgentToolExecutor>[3],
  sessionApprovals = new Set<string>(),
): AgentToolExecutor {
  return new AgentToolExecutor(
    new Map([[tool.name, tool]]),
    new Map([[tool.name, false]]),
    undefined,
    requestApproval,
    sessionApprovals,
  );
}

describe('AgentToolExecutor operation approval enforcement', () => {
  test('rejected operation is not executed', async () => {
    let executions = 0;
    const tool = new DynamicStructuredTool({
      name: 'edit_file',
      description: 'fake edit',
      schema: z.object({
        path: z.string(),
        old_text: z.string(),
        new_text: z.string(),
      }),
      func: async () => {
        executions++;
        return 'executed';
      },
    });
    const executor = executorFor(tool, async () => 'deny');

    const events = await collectEvents(executor, 'edit_file', {
      path: 'a.md',
      old_text: 'old',
      new_text: 'new',
    });

    expect(executions).toBe(0);
    expect(events.some((event) => event.type === 'tool_denied')).toBe(true);
    expect(events.some((event) => event.type === 'tool_start')).toBe(false);
  });

  test('target substitution after approval does not affect execution', async () => {
    let executedPath = '';
    const rawArgs = {
      path: 'a.md',
      old_text: 'old',
      new_text: 'new',
    };
    const tool = new DynamicStructuredTool({
      name: 'edit_file',
      description: 'fake edit',
      schema: z.object({
        path: z.string(),
        old_text: z.string(),
        new_text: z.string(),
      }),
      func: async (input) => {
        executedPath = input.path;
        return 'executed';
      },
    });
    const executor = executorFor(tool, async (request) => {
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.args)).toBe(true);
      rawArgs.path = 'b.md';
      return 'allow-once';
    });

    await collectEvents(executor, 'edit_file', rawArgs);

    expect(executedPath).toEndWith('a.md');
    expect(executedPath).not.toEndWith('b.md');
  });

  test('approved update cannot be mutated into delete before invocation', async () => {
    let executedAction = '';
    const rawArgs: {
      action: 'edit' | 'delete';
      file: string;
      old_text: string;
      new_text?: string;
    } = {
      action: 'edit',
      file: 'long_term',
      old_text: 'old',
      new_text: 'new',
    };
    const tool = new DynamicStructuredTool({
      name: 'memory_update',
      description: 'fake memory update',
      schema: z.object({
        action: z.enum(['edit', 'delete']),
        file: z.string(),
        old_text: z.string(),
        new_text: z.string().optional(),
      }),
      func: async (input) => {
        executedAction = input.action;
        return 'executed';
      },
    });
    const executor = executorFor(tool, async () => {
      rawArgs.action = 'delete';
      delete rawArgs.new_text;
      return 'allow-once';
    });

    await collectEvents(executor, 'memory_update', rawArgs);

    expect(executedAction).toBe('edit');
  });

  test('memo execution receives the exact canonical document and runtime-owned date', async () => {
    let executed: Record<string, unknown> | undefined;
    const rawArgs = {
      created: '1999-01-01',
      document: { title: '承認済みメモ', summary: '確定本文' },
    };
    const tool = new DynamicStructuredTool({
      name: 'write_memo',
      description: 'fake memo write',
      schema: writeMemoInputSchema,
      func: async (input) => {
        executed = input as Record<string, unknown>;
        return 'executed';
      },
    });
    const executor = executorFor(tool, async (request) => {
      expect(request.operation.kind).toBe('memo.create');
      rawArgs.document.title = '差し替えタイトル';
      rawArgs.document.summary = '差し替え本文';
      return 'allow-once';
    });

    await collectEvents(executor, 'write_memo', rawArgs);

    expect(executed?.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(executed?.created).not.toBe('1999-01-01');
    expect(executed?.document).toEqual({ title: '承認済みメモ', summary: '確定本文' });
    expect(executed).not.toHaveProperty('path');
  });

  test('read operation cannot escalate through argument mutation', async () => {
    let executedAction = '';
    const rawArgs: { action: 'view' | 'update'; content?: string } = {
      action: 'view',
    };
    const tool = new DynamicStructuredTool({
      name: 'heartbeat',
      description: 'fake heartbeat',
      schema: z.object({
        action: z.enum(['view', 'update']),
        content: z.string().optional(),
      }),
      func: async (input) => {
        executedAction = input.action;
        return 'executed';
      },
    });
    const executor = executorFor(tool);
    const generator = executor.executeAll(
      responseFor('heartbeat', rawArgs),
      createRunContext('test'),
    );

    const firstEvent = generator.next();
    rawArgs.action = 'update';
    rawArgs.content = '- changed';
    await firstEvent;
    for await (const _event of generator) {
      // Drain the execution.
    }

    expect(executedAction).toBe('view');
  });
});
