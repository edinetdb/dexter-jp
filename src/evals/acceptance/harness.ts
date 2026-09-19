import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  OperationApprovalGate,
  normalizeToolOperation,
  type ApprovalDecision,
  type NormalizedOperation,
} from '../../approval/operation-policy.js';
import { buildCompactionSource } from '../../agent/compact.js';
import { Scratchpad } from '../../agent/scratchpad.js';
import {
  DurableMemoryPersistence,
  EXPLICIT_MEMORY_UPDATE_ORIGIN,
} from '../../memory/persistence.js';
import { MemoryStore } from '../../memory/store.js';
import { discoverSkills } from '../../skills/index.js';
import { hasExplicitMemoIntent } from '../../skills/memo-intent.js';
import { editFileTool } from '../../tools/filesystem/edit-file.js';
import { readFileTool } from '../../tools/filesystem/read-file.js';
import { writeFileTool } from '../../tools/filesystem/write-file.js';
import { calculateDcfTool, type CalculateDcfInput } from '../../tools/finance/calculate-dcf.js';
import { createWriteMemoTool } from '../../tools/memo/write-memo.js';
import { createSkillTool } from '../../tools/skill.js';
import type {
  AcceptanceAction,
  AcceptanceEvent,
  AcceptanceExecution,
  AcceptanceFacts,
  AcceptanceScenario,
  AcceptanceTurn,
  FileDiff,
  FileManifest,
} from './types.js';

const FIXED_NOW = new Date(2026, 0, 15, 12, 0, 0, 0);
const TRANSIENT_SENTINEL = 'TRANSIENT_TOOL_OUTPUT_SENTINEL';
const REASONING_SENTINEL = 'INTERNAL_REASONING_SENTINEL';
const TOOL_HEAVY_SEQUENCE = ['read_filings', 'get_financials', 'web_search'] as const;

interface Snapshot {
  manifest: FileManifest;
  contents: Record<string, string>;
}

interface AuthorizationResult {
  gate: OperationApprovalGate;
  operation: NormalizedOperation;
  allowed: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function portable(path: string): string {
  return path.replace(/\\/g, '/');
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

async function snapshotFiles(root: string): Promise<Snapshot> {
  const manifest: FileManifest = {};
  const contents: Record<string, string> = {};

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const data = await readFile(absolute);
        const path = portable(relative(root, absolute));
        manifest[path] = { bytes: data.byteLength, sha256: sha256(data) };
        contents[path] = data.toString('utf8');
      }
    }
  }

  await visit(root);
  return { manifest, contents };
}

export function diffFileManifests(before: FileManifest, after: FileManifest): FileDiff {
  const beforePaths = new Set(Object.keys(before));
  const afterPaths = new Set(Object.keys(after));
  return {
    created: sorted([...afterPaths].filter((path) => !beforePaths.has(path))),
    modified: sorted([...afterPaths].filter(
      (path) => beforePaths.has(path) && before[path]!.sha256 !== after[path]!.sha256,
    )),
    deleted: sorted([...beforePaths].filter((path) => !afterPaths.has(path))),
  };
}

function parseToolData(raw: string): unknown {
  const parsed = JSON.parse(raw) as { data?: unknown };
  return parsed.data;
}

function compactError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').slice(0, 180);
}

class ScenarioHarness {
  private readonly events: AcceptanceEvent[] = [];
  private readonly sessionApprovals = new Set<string>();
  private readonly memoryStore: MemoryStore;
  private readonly memoryPersistence: DurableMemoryPersistence;
  private readonly memoTool;
  private scratchpad: Scratchpad;
  private readonly conversation: Array<{ input: string; output: string }> = [];
  private readonly facts: AcceptanceFacts = {
    fileDiff: { created: [], modified: [], deleted: [] },
    memoryChanged: false,
    memoChanged: false,
    durableContainsTransientSentinel: false,
    durableContainsReasoningSentinel: false,
    memoContainsTransientSentinel: false,
    substitutionRejected: false,
    argumentMutationRejected: false,
    destructiveExecuted: false,
    duplicateOriginalPreserved: false,
    restartRestoredDurableMemory: false,
    restartRestoredScratchpad: false,
    compactionPreservedContext: false,
    compactionExposedReasoning: false,
    calculatorValues: [],
    finalCalculatorValues: [],
  };

  constructor(
    private readonly scenario: AcceptanceScenario,
    private readonly root: string,
  ) {
    this.memoryStore = new MemoryStore(join(root, '.dexter'));
    this.memoryPersistence = new DurableMemoryPersistence(this.memoryStore);
    this.memoTool = createWriteMemoTool({ cwd: root });
    this.scratchpad = new Scratchpad(scenario.turns[0]?.input ?? scenario.id);
  }

  async run(): Promise<AcceptanceExecution> {
    await this.seedInitialFiles();
    const before = await snapshotFiles(this.root);

    for (let index = 0; index < this.scenario.turns.length; index += 1) {
      await this.runTurn(index + 1, this.scenario.turns[index]!);
    }

    const after = await snapshotFiles(this.root);
    this.finishFacts(before, after);
    return {
      scenario: this.scenario,
      events: this.events,
      before: before.manifest,
      after: after.manifest,
      facts: this.facts,
    };
  }

  private async seedInitialFiles(): Promise<void> {
    for (const [path, content] of Object.entries(this.scenario.initialFiles ?? {})) {
      const absolute = resolve(this.root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
    }
  }

  private finishFacts(before: Snapshot, after: Snapshot): void {
    this.facts.fileDiff = diffFileManifests(before.manifest, after.manifest);
    this.facts.memoryChanged = this.facts.fileDiff.created.some((path) => path.startsWith('.dexter/memory/'))
      || this.facts.fileDiff.modified.some((path) => path.startsWith('.dexter/memory/'))
      || this.facts.fileDiff.deleted.some((path) => path.startsWith('.dexter/memory/'));
    this.facts.memoChanged = this.facts.fileDiff.created.some((path) => path.startsWith('.dexter/memos/'))
      || this.facts.fileDiff.modified.some((path) => path.startsWith('.dexter/memos/'))
      || this.facts.fileDiff.deleted.some((path) => path.startsWith('.dexter/memos/'));

    const durableText = Object.entries(after.contents)
      .filter(([path]) => path.startsWith('.dexter/memory/'))
      .map(([, content]) => content)
      .join('\n');
    const memoText = Object.entries(after.contents)
      .filter(([path]) => path.startsWith('.dexter/memos/'))
      .map(([, content]) => content)
      .join('\n');
    this.facts.durableContainsTransientSentinel = durableText.includes(TRANSIENT_SENTINEL);
    this.facts.durableContainsReasoningSentinel = durableText.includes(REASONING_SENTINEL);
    this.facts.memoContainsTransientSentinel = memoText.includes(TRANSIENT_SENTINEL)
      || memoText.includes(REASONING_SENTINEL);
  }

  private exposedTools(input: string): { tools: Set<string>; skills: string[] } {
    const tools = new Set([
      'calculate_dcf',
      'x_search',
      'memory_update',
      'read_file',
      'edit_file',
      'write_file',
      'read_filings',
      'get_financials',
      'web_search',
      'cron',
    ]);
    if (hasExplicitMemoIntent(input)) tools.add('write_memo');
    const skills = discoverSkills({ availableTools: tools, userQuery: input }).map((skill) => skill.name).sort();
    if (skills.length > 0) tools.add('skill');
    return { tools, skills };
  }

  private async runTurn(turnNumber: number, turn: AcceptanceTurn): Promise<void> {
    const exposed = this.exposedTools(turn.input);
    this.events.push({ type: 'tools_exposed', turn: turnNumber, names: sorted(exposed.tools) });
    this.events.push({ type: 'skills_discovered', turn: turnNumber, names: exposed.skills });

    let finalText: string;
    switch (turn.action.kind) {
      case 'none':
        finalText = turn.action.marker ?? 'NO_SPECIALIZED_ACTION';
        break;
      case 'dcf':
        finalText = await this.runDcf(turnNumber, turn, exposed.tools);
        break;
      case 'x-research':
        finalText = await this.runXResearch(turnNumber, turn, exposed.tools);
        break;
      case 'memo':
        finalText = await this.runMemo(turnNumber, turn, exposed.tools);
        break;
      case 'memory-append':
        finalText = await this.runMemoryAppend(turnNumber, turn);
        break;
      case 'read-file':
        finalText = await this.runReadFile(turnNumber, turn);
        break;
      case 'edit-file':
        finalText = await this.runEditFile(turnNumber, turn);
        break;
      case 'destructive-denied':
        finalText = await this.runDestructiveDenial(turnNumber, turn);
        break;
      case 'target-substitution':
        finalText = await this.runTargetSubstitution(turnNumber, turn);
        break;
      case 'argument-mutation':
        finalText = await this.runArgumentMutation(turnNumber, turn);
        break;
      case 'exact-retry':
        finalText = await this.runExactRetry(turnNumber, turn);
        break;
      case 'tool-heavy':
        finalText = await this.runToolHeavy(turnNumber, turn.action);
        break;
      case 'compaction':
        finalText = this.runCompaction(turnNumber, turn.input);
        break;
      case 'restart':
        finalText = await this.runRestart(turnNumber, turn.input);
        break;
      default: {
        const unsupported: never = turn.action;
        throw new Error('Unsupported acceptance action: ' + JSON.stringify(unsupported));
      }
    }

    this.events.push({ type: 'final_response', turn: turnNumber, text: finalText });
    this.conversation.push({ input: turn.input, output: finalText });
  }

  private createGate(
    turnNumber: number,
    decision: ApprovalDecision,
  ): OperationApprovalGate {
    return new OperationApprovalGate(
      async (request) => {
        this.events.push({ type: 'approval_requested', turn: turnNumber, operation: request.operation });
        return decision;
      },
      this.sessionApprovals,
      { cwd: this.root, now: FIXED_NOW },
    );
  }

  private async authorize(
    turnNumber: number,
    name: string,
    args: Record<string, unknown>,
    decision: ApprovalDecision,
    gate = this.createGate(turnNumber, decision),
  ): Promise<AuthorizationResult> {
    const operation = normalizeToolOperation(name, args, { cwd: this.root, now: FIXED_NOW });
    this.events.push({ type: 'tool_call', turn: turnNumber, name, args: operation.arguments, operation });
    const authorization = await gate.authorize(name, args);
    if (authorization.policy.requirement === 'user_approval') {
      this.events.push({
        type: 'approval_outcome',
        turn: turnNumber,
        operation: authorization.operation,
        decision: authorization.decision ?? 'deny',
        prompted: authorization.prompted,
      });
    }
    return { gate, operation: authorization.operation, allowed: authorization.allowed };
  }

  private recordResult(
    turn: number,
    name: string,
    operation: NormalizedOperation,
    status: 'success' | 'error' | 'denied',
    outputSummary?: Record<string, unknown>,
  ): void {
    this.events.push({ type: 'tool_result', turn, name, status, operation, ...(outputSummary ? { outputSummary } : {}) });
    const args = operation.arguments as Record<string, unknown>;
    const result = JSON.stringify({ status, ...outputSummary });
    this.scratchpad.addToolResult(name, args, result);
    if (status !== 'denied') {
      this.scratchpad.recordToolOutcome(name, args, result, status === 'error');
    }
  }

  private async invokeSkill(
    turnNumber: number,
    name: string,
    input: string,
    availableTools: ReadonlySet<string>,
  ): Promise<void> {
    this.events.push({ type: 'skill_invoked', turn: turnNumber, name });
    const args = { skill: name, args: input };
    const authorized = await this.authorize(turnNumber, 'skill', args, 'deny');
    const claimed = authorized.gate.claim('skill', args);
    const result = await createSkillTool(availableTools, { userQuery: input }).invoke(claimed.arguments);
    if (result.startsWith('Error:')) throw new Error(result);
    this.recordResult(turnNumber, 'skill', claimed, 'success', { skill: name, instructionBytes: Buffer.byteLength(result, 'utf8') });
  }

  private async runDcf(turnNumber: number, turn: AcceptanceTurn, tools: ReadonlySet<string>): Promise<string> {
    await this.invokeSkill(turnNumber, 'dcf-valuation', turn.input, tools);
    const action = turn.action;
    if (action.kind !== 'dcf') throw new Error('DCF action mismatch.');
    const args = action.input as Record<string, unknown>;
    const authorized = await this.authorize(turnNumber, 'calculate_dcf', args, 'deny');
    const claimed = authorized.gate.claim('calculate_dcf', args);
    try {
      const raw = await calculateDcfTool.invoke(claimed.arguments as unknown as CalculateDcfInput) as string;
      const data = parseToolData(raw) as { base: { assumptions: { wacc: number; terminalGrowthRate: number }; intrinsicValuePerShare: number } };
      const value = data.base.intrinsicValuePerShare;
      this.facts.calculatorValues.push(value);
      this.facts.finalCalculatorValues.push(value);
      this.recordResult(turnNumber, 'calculate_dcf', claimed, 'success', { intrinsicValuePerShare: value });
      return `DCF_RESULT WACC=${data.base.assumptions.wacc} growth=${data.base.assumptions.terminalGrowthRate} intrinsic=${value}`;
    } catch (error) {
      this.recordResult(turnNumber, 'calculate_dcf', claimed, 'error', { error: compactError(error) });
      return 'DCF_INPUT_REJECTED invalid WACC / terminal growth relationship; assumptions were not corrected.';
    }
  }

  private async runXResearch(turnNumber: number, turn: AcceptanceTurn, tools: ReadonlySet<string>): Promise<string> {
    await this.invokeSkill(turnNumber, 'x-research', turn.input, tools);
    const action = turn.action;
    if (action.kind !== 'x-research') throw new Error('X action mismatch.');
    const args = { query: action.query };
    const authorized = await this.authorize(turnNumber, 'x_search', args, 'deny');
    const claimed = authorized.gate.claim('x_search', args);
    this.recordResult(turnNumber, 'x_search', claimed, 'success', { mode: 'observable-stub', resultCount: 2 });
    return 'X_RESEARCH_COMPLETE offline observable stub; no live API was called.';
  }

  private async runMemo(turnNumber: number, turn: AcceptanceTurn, tools: ReadonlySet<string>): Promise<string> {
    await this.invokeSkill(turnNumber, 'write-memo', turn.input, tools);
    const action = turn.action;
    if (action.kind !== 'memo') throw new Error('Memo action mismatch.');
    const args = { document: action.document };
    const decision = turn.approval?.decision ?? 'deny';
    const authorized = await this.authorize(turnNumber, 'write_memo', args, decision);
    if (!authorized.allowed) {
      this.recordResult(turnNumber, 'write_memo', authorized.operation, 'denied', { reason: 'user-denied' });
      return 'OPERATION_DENIED memo was not written.';
    }

    const target = authorized.operation.target;
    let originalHash: string | undefined;
    if (target) {
      try {
        originalHash = sha256(await readFile(target));
      } catch {
        originalHash = undefined;
      }
    }

    const claimed = authorized.gate.claim('write_memo', args);
    try {
      const raw = await this.memoTool.invoke(claimed.arguments);
      const data = parseToolData(raw) as { path: string; bytesWritten: number };
      const bytes = target ? await readFile(target) : Buffer.alloc(0);
      this.recordResult(turnNumber, 'write_memo', claimed, 'success', {
        path: data.path,
        bytesWritten: data.bytesWritten,
        sha256: sha256(bytes),
      });
      return `MEMO_CREATED path=${data.path} bytes=${data.bytesWritten} sha256=${sha256(bytes)}`;
    } catch (error) {
      let afterHash: string | undefined;
      if (target) {
        try {
          afterHash = sha256(await readFile(target));
        } catch {
          afterHash = undefined;
        }
      }
      const message = compactError(error);
      if (message.includes('already exists')) {
        this.facts.duplicateOriginalPreserved = originalHash !== undefined && originalHash === afterHash;
      }
      this.recordResult(turnNumber, 'write_memo', claimed, 'error', { error: message, originalPreserved: this.facts.duplicateOriginalPreserved });
      return message.includes('already exists') ? 'MEMO_DUPLICATE_REJECTED existing bytes preserved.' : 'MEMO_WRITE_FAILED';
    }
  }

  private async runMemoryAppend(turnNumber: number, turn: AcceptanceTurn): Promise<string> {
    const action = turn.action;
    if (action.kind !== 'memory-append') throw new Error('Memory action mismatch.');
    const args = { action: 'append', file: 'long_term', content: action.content };
    const authorized = await this.authorize(turnNumber, 'memory_update', args, turn.approval?.decision ?? 'deny');
    if (!authorized.allowed) {
      this.recordResult(turnNumber, 'memory_update', authorized.operation, 'denied', { reason: 'user-denied' });
      return 'OPERATION_DENIED memory was not updated.';
    }
    const claimed = authorized.gate.claim('memory_update', args);
    await this.memoryPersistence.apply({
      origin: EXPLICIT_MEMORY_UPDATE_ORIGIN,
      action: 'append',
      file: String(claimed.arguments.file),
      content: String(claimed.arguments.content),
    });
    this.recordResult(turnNumber, 'memory_update', claimed, 'success', { file: claimed.arguments.file });
    return 'MEMORY_UPDATED explicit durable memory path completed.';
  }

  private absolutePath(path: string): string {
    return resolve(this.root, path);
  }

  private async runReadFile(turnNumber: number, turn: AcceptanceTurn): Promise<string> {
    const action = turn.action;
    if (action.kind !== 'read-file') throw new Error('Read action mismatch.');
    const args = { path: this.absolutePath(action.path) };
    const authorized = await this.authorize(turnNumber, 'read_file', args, 'deny');
    const claimed = authorized.gate.claim('read_file', args);
    const raw = await readFileTool.invoke(claimed.arguments as unknown as { path: string; offset?: number; limit?: number }) as string;
    const data = parseToolData(raw) as { content: string };
    this.recordResult(turnNumber, 'read_file', claimed, 'success', { contentBytes: Buffer.byteLength(data.content, 'utf8') });
    return 'READ_COMPLETE content was observed without approval.';
  }

  private async runEditFile(turnNumber: number, turn: AcceptanceTurn): Promise<string> {
    const action = turn.action;
    if (action.kind !== 'edit-file') throw new Error('Edit action mismatch.');
    const args = { path: this.absolutePath(action.path), old_text: action.oldText, new_text: action.newText };
    const authorized = await this.authorize(turnNumber, 'edit_file', args, turn.approval?.decision ?? 'deny');
    if (!authorized.allowed) {
      this.recordResult(turnNumber, 'edit_file', authorized.operation, 'denied');
      return 'OPERATION_DENIED edit was not applied.';
    }
    const claimed = authorized.gate.claim('edit_file', args);
    await editFileTool.invoke(claimed.arguments as unknown as { path: string; old_text: string; new_text: string });
    this.recordResult(turnNumber, 'edit_file', claimed, 'success', { target: portable(action.path) });
    return 'EDIT_COMPLETE exact approved edit applied.';
  }

  private async runDestructiveDenial(turnNumber: number, turn: AcceptanceTurn): Promise<string> {
    const action = turn.action;
    if (action.kind !== 'destructive-denied') throw new Error('Destructive action mismatch.');
    const args = { action: 'remove', jobId: action.jobId };
    const authorized = await this.authorize(turnNumber, 'cron', args, turn.approval?.decision ?? 'deny');
    if (!authorized.allowed) {
      this.recordResult(turnNumber, 'cron', authorized.operation, 'denied', { executed: false });
      return 'OPERATION_DENIED destructive operation was not executed.';
    }
    this.facts.destructiveExecuted = true;
    this.recordResult(turnNumber, 'cron', authorized.operation, 'success', { executed: true });
    return 'DESTRUCTIVE_OPERATION_EXECUTED';
  }

  private async runTargetSubstitution(turnNumber: number, turn: AcceptanceTurn): Promise<string> {
    const action = turn.action;
    if (action.kind !== 'target-substitution') throw new Error('Target substitution mismatch.');
    const approvedArgs = {
      path: this.absolutePath(action.approvedPath),
      old_text: action.oldText,
      new_text: action.newText,
    };
    const authorized = await this.authorize(turnNumber, 'edit_file', approvedArgs, turn.approval?.decision ?? 'deny');
    const candidateArgs = { ...approvedArgs, path: this.absolutePath(action.candidatePath) };
    try {
      authorized.gate.claim('edit_file', candidateArgs);
      await editFileTool.invoke(candidateArgs);
      this.recordResult(turnNumber, 'edit_file', authorized.operation, 'success', { substituted: true });
      return 'TARGET_SUBSTITUTION_EXECUTED';
    } catch (error) {
      this.facts.substitutionRejected = true;
      this.recordResult(turnNumber, 'edit_file', authorized.operation, 'error', { error: compactError(error), substituted: false });
      return 'TARGET_SUBSTITUTION_REJECTED exact target binding held.';
    }
  }

  private async runArgumentMutation(turnNumber: number, turn: AcceptanceTurn): Promise<string> {
    const action = turn.action;
    if (action.kind !== 'argument-mutation') throw new Error('Argument mutation mismatch.');
    const approvedArgs = { path: this.absolutePath(action.path), content: action.approvedContent };
    const authorized = await this.authorize(turnNumber, 'write_file', approvedArgs, turn.approval?.decision ?? 'deny');
    const candidateArgs = { ...approvedArgs, content: action.candidateContent };
    try {
      authorized.gate.claim('write_file', candidateArgs);
      await writeFileTool.invoke(candidateArgs);
      this.recordResult(turnNumber, 'write_file', authorized.operation, 'success', { mutated: true });
      return 'ARGUMENT_MUTATION_EXECUTED';
    } catch (error) {
      this.facts.argumentMutationRejected = true;
      this.recordResult(turnNumber, 'write_file', authorized.operation, 'error', { error: compactError(error), mutated: false });
      return 'ARGUMENT_MUTATION_REJECTED exact argument binding held.';
    }
  }

  private async runExactRetry(turnNumber: number, turn: AcceptanceTurn): Promise<string> {
    const action = turn.action;
    if (action.kind !== 'exact-retry') throw new Error('Exact retry mismatch.');
    const args = { path: this.absolutePath(action.path), content: action.content };
    const decision = turn.approval?.decision ?? 'deny';
    const gate = this.createGate(turnNumber, decision);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const authorized = await this.authorize(turnNumber, 'write_file', args, decision, gate);
      if (!authorized.allowed) {
        this.recordResult(turnNumber, 'write_file', authorized.operation, 'denied', { attempt });
        return 'OPERATION_DENIED retry was not written.';
      }
      const claimed = gate.claim('write_file', args);
      await writeFileTool.invoke(claimed.arguments as unknown as { path: string; content: string });
      this.recordResult(turnNumber, 'write_file', claimed, 'success', { attempt });
    }
    return 'EXACT_RETRY_COMPLETE one prompt, two exactly bound executions.';
  }

  private async runToolHeavy(turnNumber: number, action: Extract<AcceptanceAction, { kind: 'tool-heavy' }>): Promise<string> {
    this.scratchpad.addThinking(`${REASONING_SENTINEL}: discarded hypothesis and private working notes.`);
    for (let index = 0; index < action.count; index += 1) {
      const name = TOOL_HEAVY_SEQUENCE[index % TOOL_HEAVY_SEQUENCE.length]!;
      const args = { query: `fixture-${index + 1}` };
      const authorized = await this.authorize(turnNumber, name, args, 'deny');
      const claimed = authorized.gate.claim(name, args);
      this.recordResult(turnNumber, name, claimed, 'success', {
        evidenceId: index + 1,
        transientMarker: `${TRANSIENT_SENTINEL}-${index + 1}`,
      });
    }
    return `TOOL_HEAVY_COMPLETE ${action.count} observable tool results remain transient.`;
  }

  private runCompaction(turnNumber: number, currentInput: string): string {
    const messages: BaseMessage[] = [];
    for (const item of this.conversation) {
      messages.push(new HumanMessage(item.input));
      messages.push(new AIMessage(item.output));
    }
    messages.push(new HumanMessage(currentInput));
    messages.push(new AIMessage({
      content: `${REASONING_SENTINEL}: failed private hypothesis`,
      tool_calls: [{ name: 'web_search', args: { query: 'private candidate' }, id: 'private-tool-call' }],
    }));
    messages.push(new AIMessage('確認済みの結論は段階導入です。'));

    const source = buildCompactionSource(messages, this.scratchpad.getToolResults());
    const summary = 'Original query: Alpha案件。Verified conclusion: 段階導入。Pending work: implementation plan.';
    this.scratchpad.setCompactionSummary(summary);
    this.facts.compactionPreservedContext = source.includes('Alpha案件')
      && source.includes('段階導入')
      && this.scratchpad.getToolResults().includes('段階導入');
    this.facts.compactionExposedReasoning = source.includes(REASONING_SENTINEL)
      || summary.includes(REASONING_SENTINEL);
    this.events.push({
      type: 'state_transition',
      turn: turnNumber,
      state: 'compacted-conversation',
      details: {
        requiredContextPreserved: this.facts.compactionPreservedContext,
        hiddenReasoningExcluded: !this.facts.compactionExposedReasoning,
        durableWrite: false,
      },
    });
    return this.facts.compactionPreservedContext && !this.facts.compactionExposedReasoning
      ? 'COMPACTION_CONTEXT_PRESERVED transient state only.'
      : 'COMPACTION_CONTRACT_FAILED';
  }

  private async runRestart(turnNumber: number, currentInput: string): Promise<string> {
    const replacementScratchpad = new Scratchpad(currentInput);
    const replacementStore = new MemoryStore(join(this.root, '.dexter'));
    const restored = await replacementStore.loadSessionContext(2_000);
    this.facts.restartRestoredDurableMemory = restored.text.includes('Put conclusions first');
    this.facts.restartRestoredScratchpad = replacementScratchpad.hasToolResults();
    this.scratchpad = replacementScratchpad;
    this.events.push({
      type: 'state_transition',
      turn: turnNumber,
      state: 'runtime-restart',
      details: {
        durableMemoryRestored: this.facts.restartRestoredDurableMemory,
        scratchpadRestored: this.facts.restartRestoredScratchpad,
      },
    });
    return this.facts.restartRestoredDurableMemory && !this.facts.restartRestoredScratchpad
      ? 'RESTART_DURABLE_ONLY durable memory restored; transient scratchpad absent.'
      : 'RESTART_BOUNDARY_FAILED';
  }
}

export async function runAcceptanceScenario(
  scenario: AcceptanceScenario,
  root: string,
): Promise<AcceptanceExecution> {
  await mkdir(root, { recursive: true });
  return new ScenarioHarness(scenario, root).run();
}