import { createHash } from 'node:crypto';

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

export interface ActiveSkillContract {
  name: string;
  instructions: string;
}

interface ToolProgressRecord {
  toolName: string;
  signature: string;
  outcomeHash: string;
  failed: boolean;
}

const MAX_TOOL_PROGRESS_RECORDS = 50;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

/**
 * In-memory scratchpad for a single agent run.
 *
 * Tool evidence, active Skill contracts, progress detection, and compaction
 * state are transient. None of this state is written to durable memory.
 */
export class Scratchpad {
  private readonly entries: ScratchpadEntry[] = [];
  private readonly activeSkillContracts = new Map<string, string>();
  private readonly toolProgressRecords: ToolProgressRecord[] = [];
  private readonly emittedProgressWarnings = new Set<string>();

  // In-memory tracking for Anthropic-style context clearing.
  // Stores indices of tool_result entries that have been cleared from context
  private clearedToolIndices: Set<number> = new Set();

  // Compaction state (in-memory only).
  // When set, getToolResults() returns the summary + any post-compaction results
  private compactionSummary: string | null = null;
  private compactionBoundaryIndex: number = -1;

  constructor(query: string) {
    this.append({ type: 'init', content: query, timestamp: new Date().toISOString() });
  }

  /**
   * Add a complete tool result with full data.
   * Parses JSON strings to keep structured values in transient memory.
   */
  addToolResult(
    toolName: string,
    args: Record<string, unknown>,
    result: string,
  ): void {
    this.append({
      type: 'tool_result',
      timestamp: new Date().toISOString(),
      toolName,
      args,
      result: this.parseResultSafely(result),
    });
  }

  /**
   * Record a completed attempt for no-progress detection.
   * Distinct arguments or changing results count as progress and never warn.
   */
  recordToolOutcome(
    toolName: string,
    args: Record<string, unknown>,
    result: string,
    failed: boolean,
  ): void {
    const signature = JSON.stringify(canonicalize({ toolName, args }));
    const outcomeHash = createHash('sha256').update(result).digest('hex');
    this.toolProgressRecords.push({ toolName, signature, outcomeHash, failed });
    if (this.toolProgressRecords.length > MAX_TOOL_PROGRESS_RECORDS) {
      this.toolProgressRecords.splice(
        0,
        this.toolProgressRecords.length - MAX_TOOL_PROGRESS_RECORDS,
      );
    }
  }

  /**
   * Return a warning only after an exact operation repeats without new output.
   * Each unchanged outcome is warned once so the warning itself cannot loop.
   */
  formatToolProgressWarningForPrompt(): string | null {
    const latest = this.toolProgressRecords.at(-1);
    if (!latest) return null;

    const repetitions = this.toolProgressRecords.filter(record =>
      record.signature === latest.signature
      && record.outcomeHash === latest.outcomeHash
      && record.failed === latest.failed,
    ).length;
    if (repetitions < 2) return null;

    const warningKey = [
      latest.signature,
      latest.outcomeHash,
      latest.failed ? 'failure' : 'unchanged',
    ].join(':');
    if (this.emittedProgressWarnings.has(warningKey)) return null;
    this.emittedProgressWarnings.add(warningKey);

    const outcome = latest.failed ? 'the same failure' : 'an unchanged result';
    return [
      '## Tool progress warning',
      '',
      `The same ${latest.toolName} operation repeated with ${outcome}.`,
      'Change the query, target, or tool before retrying it. Continue other independent work, or report the blocker if this operation is required.',
    ].join('\n');
  }

  /** Keep a successful Skill contract available after full compaction. */
  recordActiveSkill(name: string, instructions: string): void {
    const trimmedName = name.trim();
    const trimmedInstructions = instructions.trim();
    if (!trimmedName || !trimmedInstructions) return;
    this.activeSkillContracts.set(trimmedName, trimmedInstructions);
  }

  /** Return a defensive snapshot of run-local active Skill contracts. */
  getActiveSkillContracts(): ActiveSkillContract[] {
    return [...this.activeSkillContracts.entries()].map(([name, instructions]) => ({
      name,
      instructions,
    }));
  }

  /** Format active Skill contracts for trusted prompt reconstruction. */
  formatActiveSkillContractsForPrompt(): string {
    const contracts = this.getActiveSkillContracts();
    if (contracts.length === 0) return '';

    return [
      '## Active Skill contracts',
      '',
      'These run-local Skill instructions remain active after context compaction.',
      '',
      ...contracts.map(contract =>
        `### ${contract.name}\n\n${contract.instructions}`,
      ),
    ].join('\n');
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
  getToolResults(options: { excludeSkillInstructions?: boolean } = {}): string {
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

        if (options.excludeSkillInstructions && entry.toolName === 'skill') {
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

      if (options.excludeSkillInstructions && entry.toolName === 'skill') {
        toolResultIndex++;
        continue;
      }

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

  /** Tool evidence safe to send to the compaction summarizer. */
  getCompactionEvidence(): string {
    return this.getToolResults({ excludeSkillInstructions: true });
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
