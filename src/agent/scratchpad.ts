/**
 * Record of a tool call for external consumers (e.g., DoneEvent)
 */
export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export interface ScratchpadEntry {
  type: 'init' | 'tool_result' | 'thinking';
  timestamp: string;
  // For init/thinking:
  content?: string;
  // For tool_result:
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown; // Stored as parsed object when possible, string otherwise
}

/**
 * Tool call limit configuration
 */
export interface ToolLimitConfig {
  /** Max calls per tool per query (default: 3) */
  maxCallsPerTool: number;
  /** Query similarity threshold (0-1, default: 0.7) */
  similarityThreshold: number;
}

/**
 * Status of tool usage for graceful exit mechanism
 */
export interface ToolUsageStatus {
  toolName: string;
  callCount: number;
  maxCalls: number;
  remainingCalls: number;
  recentQueries: string[];
  isBlocked: boolean;
  blockReason?: string;
}

/** Default tool limit configuration */
const DEFAULT_LIMIT_CONFIG: ToolLimitConfig = {
  maxCallsPerTool: 3,
  similarityThreshold: 0.7,
};

/**
 * In-memory scratchpad for tracking agent work on a single query.
 * 
 * This is the single source of truth for all agent work on a query.
 * It is intentionally never written to durable storage or restored in a later run.
 * 
 * Includes soft limit warnings to guide the LLM:
 * - Tool call counting with suggested limits (warnings, not blocks)
 * - Query similarity detection to help prevent retry loops
 */
export class Scratchpad {
  private readonly entries: ScratchpadEntry[] = [];
  private readonly limitConfig: ToolLimitConfig;

  // In-memory tracking for tool limits.
  private toolCallCounts: Map<string, number> = new Map();
  private toolQueries: Map<string, string[]> = new Map();

  // In-memory tracking for Anthropic-style context clearing.
  // Stores indices of tool_result entries that have been cleared from context
  private clearedToolIndices: Set<number> = new Set();

  // Compaction state (in-memory only).
  // When set, getToolResults() returns the summary + any post-compaction results
  private compactionSummary: string | null = null;
  private compactionBoundaryIndex: number = -1;

  constructor(query: string, limitConfig?: Partial<ToolLimitConfig>) {
    this.limitConfig = { ...DEFAULT_LIMIT_CONFIG, ...limitConfig };
    this.append({ type: 'init', content: query, timestamp: new Date().toISOString() });
  }

  /**
   * Add a complete tool result with full data.
   * Parses JSON strings to keep structured values in transient memory.
   * Anthropic-style: no inline summarization, full results preserved.
   */
  addToolResult(
    toolName: string,
    args: Record<string, unknown>,
    result: string
  ): void {
    this.append({
      type: 'tool_result',
      timestamp: new Date().toISOString(),
      toolName,
      args,
      result: this.parseResultSafely(result),
    });
  }

  // ============================================================================
  // Tool Limit / Graceful Exit Methods
  // ============================================================================

  /**
   * Check if a tool call can proceed. Returns status with warning if limits exceeded.
   * Call this BEFORE executing a tool to help prevent retry loops.
   * Note: Always allows the call but provides warnings to guide the LLM.
   */
  canCallTool(toolName: string, query?: string): { allowed: boolean; warning?: string } {
    const currentCount = this.toolCallCounts.get(toolName) ?? 0;
    const maxCalls = this.limitConfig.maxCallsPerTool;

    // Check if over the suggested limit - warn but allow
    if (currentCount >= maxCalls) {
      return {
        allowed: true,
        warning: `Tool '${toolName}' has been called ${currentCount} times (suggested limit: ${maxCalls}). ` +
          `If previous calls didn't return the needed data, consider: ` +
          `(1) trying a different tool, (2) using different search terms, or ` +
          `(3) proceeding with what you have and noting any data gaps to the user.`,
      };
    }

    // Check query similarity if query provided
    if (query) {
      const previousQueries = this.toolQueries.get(toolName) ?? [];
      const similarQuery = this.findSimilarQuery(query, previousQueries);
      
      if (similarQuery) {
        // Allow but warn - the LLM should know it's repeating
        const remaining = maxCalls - currentCount;
        return {
          allowed: true,
          warning: `This query is very similar to a previous '${toolName}' call. ` +
            `You have ${remaining} attempt(s) before reaching the suggested limit. ` +
            `If the tool isn't returning useful results, consider: ` +
            `(1) trying a different tool, (2) using different search terms, or ` +
            `(3) acknowledging the data limitation to the user.`,
        };
      }
    }

    // Check if approaching limit (1 call remaining)
    if (currentCount === maxCalls - 1) {
      return {
        allowed: true,
        warning: `You are approaching the suggested limit for '${toolName}' (${currentCount + 1}/${maxCalls}). ` +
          `If this doesn't return the needed data, consider trying a different approach.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a tool call attempt. Call this AFTER the tool executes successfully.
   */
  recordToolCall(toolName: string, query?: string): void {
    // Update call count
    const currentCount = this.toolCallCounts.get(toolName) ?? 0;
    this.toolCallCounts.set(toolName, currentCount + 1);

    // Track query if provided
    if (query) {
      const queries = this.toolQueries.get(toolName) ?? [];
      queries.push(query);
      this.toolQueries.set(toolName, queries);
    }
  }

  /**
   * Get usage status for all tools that have been called.
   * Used to inject tool attempt status into prompts.
   */
  getToolUsageStatus(): ToolUsageStatus[] {
    const statuses: ToolUsageStatus[] = [];
    
    for (const [toolName, callCount] of this.toolCallCounts) {
      const maxCalls = this.limitConfig.maxCallsPerTool;
      const remainingCalls = Math.max(0, maxCalls - callCount);
      const recentQueries = this.toolQueries.get(toolName) ?? [];
      const overLimit = callCount >= maxCalls;
      
      statuses.push({
        toolName,
        callCount,
        maxCalls,
        remainingCalls,
        recentQueries: recentQueries.slice(-3), // Last 3 queries
        isBlocked: false, // Never block, just warn
        blockReason: overLimit ? `Over suggested limit of ${maxCalls} calls` : undefined,
      });
    }
    
    return statuses;
  }

  /**
   * Format tool usage status for injection into prompts.
   */
  formatToolUsageForPrompt(): string | null {
    const statuses = this.getToolUsageStatus();
    
    if (statuses.length === 0) {
      return null;
    }

    const lines = statuses.map(s => {
      const status = s.callCount >= s.maxCalls
        ? `${s.callCount} calls (over suggested limit of ${s.maxCalls})`
        : `${s.callCount}/${s.maxCalls} calls`;
      return `- ${s.toolName}: ${status}`;
    });

    return `## Tool Usage This Query\n\n${lines.join('\n')}\n\n` +
      `Note: If a tool isn't returning useful results after several attempts, consider trying a different tool/approach.`;
  }

  /**
   * Check if a query is too similar to previous queries.
   * Uses word overlap similarity (Jaccard-like).
   */
  private findSimilarQuery(newQuery: string, previousQueries: string[]): string | null {
    const newWords = this.tokenize(newQuery);
    
    for (const prevQuery of previousQueries) {
      const prevWords = this.tokenize(prevQuery);
      const similarity = this.calculateSimilarity(newWords, prevWords);
      
      if (similarity >= this.limitConfig.similarityThreshold) {
        return prevQuery;
      }
    }
    
    return null;
  }

  /**
   * Tokenize a query into normalized words for similarity comparison.
   */
  private tokenize(query: string): Set<string> {
    return new Set(
      query
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2) // Skip very short words
    );
  }

  /**
   * Calculate word overlap similarity between two word sets.
   */
  private calculateSimilarity(set1: Set<string>, set2: Set<string>): number {
    if (set1.size === 0 || set2.size === 0) return 0;
    
    const intersection = [...set1].filter(w => set2.has(w)).length;
    const union = new Set([...set1, ...set2]).size;
    
    return intersection / union; // Jaccard similarity
  }

  /**
   * Safely parse a result string as JSON if possible.
   * Returns the parsed object if valid JSON, otherwise returns the original string.
   */
  private parseResultSafely(result: string): unknown {
    try {
      return JSON.parse(result);
    } catch {
      // Not valid JSON, return as-is (e.g., error messages, plain text)
      return result;
    }
  }

  /**
   * Append thinking/reasoning
   */
  addThinking(thought: string): void {
    this.append({ type: 'thinking', content: thought, timestamp: new Date().toISOString() });
  }

  /**
   * Get full tool results formatted for the iteration prompt.
   * Anthropic-style: full results in context, excluding cleared entries.
   *
   * When a compaction summary is active, returns:
   *   summary + separator + any post-compaction tool results
   */
  getToolResults(): string {
    const entries = this.readEntries();
    let toolResultIndex = 0;

    // Compaction mode: return summary + post-compaction results
    if (this.compactionSummary) {
      const postCompactionResults: string[] = [];

      for (const entry of entries) {
        if (entry.type !== 'tool_result' || !entry.toolName) continue;

        // Skip entries covered by the compaction summary
        if (toolResultIndex <= this.compactionBoundaryIndex) {
          toolResultIndex++;
          continue;
        }

        // Post-compaction entries: format normally
        const argsStr = entry.args
          ? Object.entries(entry.args).map(([k, v]) => `${k}=${v}`).join(', ')
          : '';
        const resultStr = this.stringifyResult(entry.result);
        postCompactionResults.push(`### ${entry.toolName}(${argsStr})\n${resultStr}`);
        toolResultIndex++;
      }

      if (postCompactionResults.length > 0) {
        return `${this.compactionSummary}\n\n---\n\nNew data retrieved after compaction:\n\n${postCompactionResults.join('\n\n')}`;
      }

      return this.compactionSummary;
    }

    // Standard mode: full results with clearing placeholders
    const formattedResults: string[] = [];
    for (const entry of entries) {
      if (entry.type !== 'tool_result' || !entry.toolName) continue;

      // Skip entries that have been cleared from context (in-memory only)
      if (this.clearedToolIndices.has(toolResultIndex)) {
        formattedResults.push(`[Tool result #${toolResultIndex + 1} cleared from context]`);
        toolResultIndex++;
        continue;
      }

      const argsStr = entry.args
        ? Object.entries(entry.args).map(([k, v]) => `${k}=${v}`).join(', ')
        : '';
      const resultStr = this.stringifyResult(entry.result);
      formattedResults.push(`### ${entry.toolName}(${argsStr})\n${resultStr}`);
      toolResultIndex++;
    }

    return formattedResults.join('\n\n');
  }

  /**
   * Get count of active (non-cleared) tool results.
   */
  getActiveToolResultCount(): number {
    const entries = this.readEntries();
    let count = 0;
    let index = 0;
    
    for (const entry of entries) {
      if (entry.type === 'tool_result') {
        if (!this.clearedToolIndices.has(index)) {
          count++;
        }
        index++;
      }
    }
    
    return count;
  }

  /**
   * Store a compaction summary that replaces all current tool results.
   * After this call, getToolResults() returns the summary + any new results added later.
   */
  setCompactionSummary(summary: string): void {
    this.compactionSummary = summary;
    // Count current tool_result entries — all are now covered by the summary
    const entries = this.readEntries();
    let toolResultCount = 0;
    for (const entry of entries) {
      if (entry.type === 'tool_result') {
        toolResultCount++;
      }
    }
    this.compactionBoundaryIndex = toolResultCount - 1;
    // Old clearing state is superseded by the summary
    this.clearedToolIndices.clear();
  }

  /**
   * Get tool call records for DoneEvent (external consumers)
   */
  getToolCallRecords(): ToolCallRecord[] {
    return this.readEntries()
      .filter(e => e.type === 'tool_result' && e.toolName)
      .map(e => ({
        tool: e.toolName!,
        args: e.args!,
        result: this.stringifyResult(e.result),
      }));
  }

  /**
   * Convert a result back to string for API compatibility.
   * If already a string, returns as-is. Otherwise JSON stringifies.
   */
  private stringifyResult(result: unknown): string {
    if (typeof result === 'string') {
      return result;
    }
    return JSON.stringify(result);
  }

  /**
   * Check if any tool results have been recorded
   */
  hasToolResults(): boolean {
    return this.readEntries().some(e => e.type === 'tool_result');
  }

  /**
   * Check if a skill has already been executed in this query.
   * Used for deduplication - each skill should only run once per query.
   */
  hasExecutedSkill(skillName: string): boolean {
    return this.readEntries().some(
      e => e.type === 'tool_result' && e.toolName === 'skill' && e.args?.skill === skillName
    );
  }

  /** Append an entry to this run's transient state. */
  private append(entry: ScratchpadEntry): void {
    this.entries.push(entry);
  }

  /** Read a snapshot of this run's transient entries. */
  private readEntries(): ScratchpadEntry[] {
    return [...this.entries];
  }
}
