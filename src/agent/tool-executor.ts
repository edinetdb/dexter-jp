import { AIMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { StructuredToolInterface } from '@langchain/core/tools';
import { createProgressChannel } from '../utils/progress-channel.js';
import { all } from '../utils/concurrency.js';
import type {
  ToolApprovalEvent,
  ToolDeniedEvent,
  ToolEndEvent,
  ToolErrorEvent,
  ToolProgressEvent,
  ToolStartEvent,
} from './types.js';
import type { Question, UserAnswers } from '../tools/ask-user-question/types.js';
import { evaluatePermission } from '../permissions/engine.js';
import { addRule } from '../permissions/rules.js';
import {
  normalizeToolOperation,
  OperationApprovalGate,
  type RequestOperationApproval,
} from '../approval/operation-policy.js';
import type { RunContext } from './run-context.js';

type ToolExecutionEvent =
  | ToolStartEvent
  | ToolProgressEvent
  | ToolEndEvent
  | ToolErrorEvent
  | ToolApprovalEvent
  | ToolDeniedEvent;

const DEFAULT_MAX_CONCURRENCY = 10;

interface ToolCallBatch {
  concurrent: boolean;
  calls: ToolCall[];
}

/**
 * Executes tool calls with concurrent support for read-only tools.
 *
 * Consecutive concurrent-safe tool calls are batched and run in parallel
 * (up to maxConcurrency). Non-concurrent tools execute serially with
 * approval gates where required.
 */
export class AgentToolExecutor {
  private readonly approvalGate: OperationApprovalGate;
  private readonly queryApprovedBashOperations = new Set<string>();
  private readonly maxConcurrency: number;

  constructor(
    private readonly toolMap: Map<string, StructuredToolInterface>,
    private readonly concurrencyMap: Map<string, boolean>,
    private readonly signal?: AbortSignal,
    requestToolApproval?: RequestOperationApproval,
    sessionApprovedOperations?: Set<string>,
    maxConcurrency?: number,
    private readonly requestUserInput?: (request: {
      questions: Question[];
    }) => Promise<UserAnswers>,
  ) {
    this.approvalGate = new OperationApprovalGate(
      requestToolApproval,
      sessionApprovedOperations,
    );
    this.maxConcurrency = maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  }

  /**
   * Execute all tool calls from an AIMessage response.
   * Concurrent-safe tools run in parallel batches; others run serially.
   */
  async *executeAll(
    response: AIMessage,
    ctx: RunContext,
  ): AsyncGenerator<ToolExecutionEvent, void> {
    const batches = this.partitionToolCalls(response.tool_calls!, ctx);

    for (const batch of batches) {
      if (batch.concurrent && batch.calls.length > 1) {
        yield* this.executeBatchConcurrently(batch.calls, ctx);
      } else {
        for (const call of batch.calls) {
          yield* this.executeSingleWithId(call, ctx);
        }
      }
    }
  }

  /**
   * Partition tool_calls into batches of consecutive concurrent-safe calls
   * vs individual non-concurrent calls.
   */
  private partitionToolCalls(toolCalls: ToolCall[], ctx: RunContext): ToolCallBatch[] {
    const batches: ToolCallBatch[] = [];

    for (const call of toolCalls) {
      // Skill dedup — skip already-executed skills
      if (call.name === 'skill') {
        const skillName = (call.args as Record<string, unknown>).skill as string;
        if (ctx.scratchpad.hasExecutedSkill(skillName)) continue;
      }

      const operation = normalizeToolOperation(
        call.name,
        call.args as Record<string, unknown>,
      );
      const isSafe =
        operation.risk === 'read_only' &&
        (this.concurrencyMap.get(call.name) ?? false);
      const lastBatch = batches[batches.length - 1];

      if (isSafe && lastBatch?.concurrent) {
        lastBatch.calls.push(call);
      } else {
        batches.push({ concurrent: isSafe, calls: [call] });
      }
    }

    return batches;
  }

  /**
   * Execute a batch of concurrent-safe tools in parallel.
   */
  private async *executeBatchConcurrently(
    calls: ToolCall[],
    ctx: RunContext,
  ): AsyncGenerator<ToolExecutionEvent, void> {
    const generators = calls.map(call => this.executeSingleWithId(call, ctx));
    yield* all(generators, this.maxConcurrency);
  }

  /**
   * Execute a single tool call, emitting toolCallId on every event.
   */
  private async *executeSingleWithId(
    call: ToolCall,
    ctx: RunContext,
  ): AsyncGenerator<ToolExecutionEvent, void> {
    const toolName = call.name;
    const rawToolArgs = call.args as Record<string, unknown>;
    const toolCallId = call.id;

    const permission = toolName === 'bash'
      ? evaluatePermission({ tool: toolName, args: rawToolArgs })
      : undefined;
    const authorization = await this.approvalGate.authorize(
      toolName,
      rawToolArgs,
      {
        ...(permission ? { permission } : {}),
        ...(toolName === 'bash'
          ? { sessionApprovedOperations: this.queryApprovedBashOperations }
          : {}),
      },
    );
    const authorizedArgs = authorization.operation.arguments as Record<string, unknown>;

    if (authorization.prompted) {
      yield {
        type: 'tool_approval',
        tool: toolName,
        args: authorizedArgs,
        operation: authorization.operation,
        approved: authorization.decision ?? 'deny',
      };
    }
    if (
      authorization.allowed &&
      authorization.decision === 'allow-always' &&
      permission?.proposedRule
    ) {
      addRule('allow', permission.proposedRule);
    }
    if (!authorization.allowed) {
      yield {
        type: 'tool_denied',
        tool: toolName,
        args: authorizedArgs,
        operation: authorization.operation,
        toolCallId,
      };
      return;
    }

    let toolArgs = authorizedArgs;

    yield { type: 'tool_start', tool: toolName, args: toolArgs, toolCallId };

    const toolStartTime = Date.now();

    try {
      // Re-normalize after the approval UI and all pre-execution yields. This
      // catches browser target/state substitution immediately before invoke.
      const claimed = this.approvalGate.claim(toolName, toolArgs);
      toolArgs = claimed.arguments as Record<string, unknown>;

      const tool = this.toolMap.get(toolName);
      if (!tool) {
        throw new Error(`Tool '${toolName}' not found`);
      }

      const channel = createProgressChannel();
      const config = {
        metadata: {
          onProgress: channel.emit,
          ...(this.requestUserInput ? { onUserInput: this.requestUserInput } : {}),
        },
        ...(this.signal ? { signal: this.signal } : {}),
      };

      const toolPromise = tool.invoke(toolArgs, config).then(
        (raw) => { channel.close(); return raw; },
        (err) => { channel.close(); throw err; },
      );

      for await (const message of channel) {
        yield { type: 'tool_progress', tool: toolName, message, toolCallId } as ToolProgressEvent;
      }

      const rawResult = await toolPromise;
      const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
      const duration = Date.now() - toolStartTime;

      yield { type: 'tool_end', tool: toolName, args: toolArgs, result, duration, toolCallId };

      ctx.scratchpad.recordToolOutcome(toolName, toolArgs, result, false);
      ctx.scratchpad.addToolResult(toolName, toolArgs, result);
      if (toolName === 'skill') {
        const skillName = typeof toolArgs.skill === 'string' ? toolArgs.skill : '';
        ctx.scratchpad.recordActiveSkill(skillName, result);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      yield { type: 'tool_error', tool: toolName, error: errorMessage, toolCallId };

      const result = `Error: ${errorMessage}`;
      ctx.scratchpad.recordToolOutcome(toolName, toolArgs, result, true);
      ctx.scratchpad.addToolResult(toolName, toolArgs, result);
    }
  }
}
