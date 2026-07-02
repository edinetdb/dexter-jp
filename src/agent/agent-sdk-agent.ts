/**
 * Claude Agent SDK mode agent.
 *
 * Presents the SAME `run(query): AsyncGenerator<AgentEvent>` interface as the
 * LangChain-based `Agent`, but delegates the entire loop to the Agent SDK's
 * `query()`. Dexter's ink UI and AgentRunnerController consume the yielded
 * AgentEvents without modification.
 *
 * Responsibilities:
 *   - Register Dexter's raw tools as an in-process MCP server (no internal LLM).
 *   - Deny all SDK built-in tools; allow only Dexter MCP tools + AskUserQuestion.
 *   - Hand the SDK an allowlisted env (never process.env whole) and fail loud on
 *     unexpected/ambiguous billing paths.
 *   - Convert the full SDKMessage union to AgentEvents via a pure, exhaustively-
 *     tested translator; unknown variants degrade to a diagnostic line and never
 *     wedge the UI spinner.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, PermissionResult, ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, DoneEvent, TokenUsage } from './types.js';
import { buildDexterMcpServer, DEXTER_MCP_SERVER_NAME } from './sdk-tool-adapter.js';
import { buildSdkAgentSystemPrompt } from './sdk-prompt.js';
import { buildSdkEnv, evaluateEnvGuard } from './sdk-env-guard.js';
import { translateSdkMessage, type TranslateContext } from './sdk-message-translate.js';

/** SDK built-in tools we explicitly deny (belt-and-suspenders; `tools: []` also removes them). */
export const SDK_BUILTIN_TOOLS_TO_DENY = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TodoWrite',
  'Skill',
  'KillShell',
  'BashOutput',
  'SlashCommand',
] as const;

/** The one SDK-native tool we DO allow: the model's ask-user question mechanism. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

const DEFAULT_MAX_TURNS = 40;

export interface AgentSdkAgentConfig {
  /** Model id (e.g. 'claude-fable-5'). */
  model: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Delivery channel (affects the system prompt tone; defaults to 'cli'). */
  channel?: string;
  /** Max agentic turns before the SDK stops. */
  maxTurns?: number;
  /** Client-side USD budget ceiling; SDK stops when its estimate reaches it. */
  maxBudgetUsd?: number;
  /** User has explicitly opted into a usage-based (metered) credential path. */
  allowMetered?: boolean;
  /**
   * Bridge for user questions surfaced by the SDK (MCP elicitation). Returns the
   * user's free-text answer, or null if cancelled. When omitted, questions are
   * auto-declined so the run does not hang.
   */
  requestUserInput?: (prompt: string) => Promise<string | null>;
}

export class AgentSdkAgent {
  private readonly config: AgentSdkAgentConfig;
  private readonly systemPrompt: string;
  private readonly mcp = buildDexterMcpServer();
  /** Tool names actually reported by the SDK as used, for the "no built-ins" check. */
  private readonly toolsSeen = new Set<string>();

  private constructor(config: AgentSdkAgentConfig, systemPrompt: string) {
    this.config = config;
    this.systemPrompt = systemPrompt;
  }

  static async create(config: AgentSdkAgentConfig): Promise<AgentSdkAgent> {
    const systemPrompt = await buildSdkAgentSystemPrompt(config.model, config.channel);
    return new AgentSdkAgent(config, systemPrompt);
  }

  /** Fully-qualified Dexter tool names + AskUserQuestion, for `allowedTools`. */
  private allowedTools(): string[] {
    return [`mcp__${DEXTER_MCP_SERVER_NAME}__*`, ASK_USER_QUESTION_TOOL];
  }

  /**
   * Permission handler: allow Dexter MCP tools + AskUserQuestion, deny everything
   * else (fail-safe). Invoked only when the permission flow falls through to a
   * prompt; `allowedTools` auto-approves the Dexter tools, so in practice this
   * blocks any built-in the model somehow attempts.
   */
  private canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    const isDexterTool = toolName.startsWith(`mcp__${DEXTER_MCP_SERVER_NAME}__`);
    const isAskUser = toolName === ASK_USER_QUESTION_TOOL;
    if (isDexterTool || isAskUser) {
      return { behavior: 'allow', updatedInput: input };
    }
    return {
      behavior: 'deny',
      message: `Tool '${toolName}' is not available in Claude Agent SDK mode (only Dexter data tools are permitted).`,
    };
  };

  /** MCP elicitation → user input bridge. */
  private onElicitation = async (
    request: ElicitationRequest,
  ): Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> }> => {
    const message = (request as { message?: string }).message ?? 'The assistant is requesting input.';
    if (!this.config.requestUserInput) {
      return { action: 'decline' };
    }
    const answer = await this.config.requestUserInput(message);
    if (answer === null) return { action: 'cancel' };
    return { action: 'accept', content: { response: answer } };
  };

  private buildOptions(): Options {
    return {
      model: this.config.model,
      systemPrompt: this.systemPrompt,
      // Do not read user/project/local .claude settings or CLAUDE.md.
      settingSources: [],
      // Remove ALL built-in tools from context (availability layer).
      tools: [],
      // Belt-and-suspenders deny (permission + availability layer).
      disallowedTools: [...SDK_BUILTIN_TOOLS_TO_DENY],
      // Auto-approve only Dexter tools + AskUserQuestion.
      allowedTools: this.allowedTools(),
      // Register the raw Dexter tools; use only these MCP servers.
      mcpServers: { [DEXTER_MCP_SERVER_NAME]: this.mcp.server },
      strictMcpConfig: true,
      // Fail-safe permission handler for anything that falls through.
      canUseTool: this.canUseTool,
      permissionMode: 'default',
      maxTurns: this.config.maxTurns ?? DEFAULT_MAX_TURNS,
      ...(this.config.maxBudgetUsd !== undefined ? { maxBudgetUsd: this.config.maxBudgetUsd } : {}),
      onElicitation: this.onElicitation,
      abortController: this.toAbortController(),
      // Allowlisted env — never forward process.env whole.
      env: buildSdkEnv({ allowMetered: this.config.allowMetered }),
    };
  }

  /** The SDK wants an AbortController; adapt an incoming AbortSignal to one. */
  private toAbortController(): AbortController | undefined {
    const signal = this.config.signal;
    if (!signal) return undefined;
    const controller = new AbortController();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
    return controller;
  }

  /**
   * Run the agent, yielding Dexter AgentEvents. Mirrors `Agent.run()`.
   */
  async *run(userQuery: string): AsyncGenerator<AgentEvent> {
    const startTime = Date.now();

    // Billing-path guard (fail-loud). Surface the resolved auth route, and stop
    // before running if a usage-based/ambiguous path is present and the user has
    // not opted in. The SDK itself manages credentials; this only prevents an
    // unintended metered run.
    const guard = evaluateEnvGuard({ allowMetered: this.config.allowMetered });
    yield { type: 'thinking', message: guard.summary };
    if (guard.requiresConfirmation) {
      const instructions = this.config.allowMetered
        ? guard.detail ?? guard.summary
        : `${guard.detail ?? guard.summary}\n\nTo proceed on this path, set DEXTER_AGENT_SDK_ALLOW_METERED=1 and retry.`;
      yield this.doneEvent(
        `Claude Agent SDK mode halted before running to avoid an unintended billing path.\n\n${instructions}`,
        startTime,
        undefined,
      );
      return;
    }

    let finalAnswer = '';
    let terminalSeen = false;
    let lastUsage: TokenUsage | undefined;

    const translateCtx: TranslateContext = {
      model: this.config.model,
      maxTurns: this.config.maxTurns ?? DEFAULT_MAX_TURNS,
      onToolSeen: (name) => this.toolsSeen.add(name),
      onFinalAnswer: (t) => { finalAnswer = t; },
      onUsage: (u) => { lastUsage = u; },
      onTerminal: () => { terminalSeen = true; },
    };

    try {
      for await (const message of query({ prompt: userQuery, options: this.buildOptions() })) {
        for (const event of translateSdkMessage(message, translateCtx)) {
          yield event;
        }
        // A `result` frame is terminal — emit the Dexter `done` right after so the
        // spinner closes exactly once, carrying the captured answer + usage.
        if (terminalSeen) {
          yield this.doneEvent(finalAnswer, startTime, lastUsage);
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && (error.name === 'AbortError' || /abort/i.test(message))) {
        // Interrupted — emit a terminal done so the spinner closes.
        yield this.doneEvent(finalAnswer, startTime, lastUsage);
        return;
      }
      // Any other throw (incl. auth/spawn failures) → terminal error done.
      yield this.doneEvent(`Error: ${message}`, startTime, lastUsage);
      return;
    }

    // Stream ended without a terminal result — still close the turn.
    yield this.doneEvent(finalAnswer, startTime, lastUsage);
  }

  /** Names of tools the SDK actually reported using (for the built-in-tools check). */
  get observedToolNames(): string[] {
    return [...this.toolsSeen];
  }

  private doneEvent(answer: string, startTime: number, usage: TokenUsage | undefined): DoneEvent {
    return {
      type: 'done',
      answer,
      toolCalls: [],
      iterations: 0,
      totalTime: Date.now() - startTime,
      tokenUsage: usage,
    };
  }
}
