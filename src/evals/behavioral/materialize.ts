import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  OperationApprovalGate,
  decideOperationApproval,
  normalizeToolOperation,
  type NormalizedOperation,
  type OperationRisk,
} from '../../approval/operation-policy.js';
import {
  CalculateDcfInputSchema,
  calculateDcfAnalysis,
  type CalculateDcfInput,
} from '../../tools/finance/calculate-dcf.js';
import {
  memoDocumentSchema,
  prepareWriteMemoInput,
  type MemoDocument,
} from '../../memo/document.js';
import { renderMemo } from '../../memo/renderer.js';
import { discoverSkills } from '../../skills/registry.js';
import { hasExplicitMemoIntent } from '../../skills/memo-intent.js';
import { encodeRecordedFixture } from './normalize.js';
import type {
  CanonicalFixtureEvent,
  EvalCase,
  EvalConfiguration,
  EvalExpectation,
  EvalFacts,
  MaterializedEvalCase,
  ScoreCategory,
} from './types.js';

const FIXED_NOW = new Date('2026-01-15T12:00:00.000Z');
const FIXED_CREATED = '2026-01-15';
const EVAL_CWD = resolve(process.cwd(), '.phase7-offline-eval');
const BUILTIN_SKILLS = new Set(['dcf-valuation', 'x-research', 'write-memo']);

const BASE_DCF_INPUT: CalculateDcfInput = {
  forecastFreeCashFlows: [
    { period: 'FY2027', value: 100 },
    { period: 'FY2028', value: 110 },
    { period: 'FY2029', value: 120 },
  ],
  wacc: 0.08,
  terminalGrowthRate: 0.02,
  netDebt: 40,
  dilutedSharesOutstanding: 10_000_000,
  unit: 'JPY_million',
  waccDelta: 0.01,
  growthDelta: 0.005,
};

interface BuildState {
  events: CanonicalFixtureEvent[];
  expected: EvalExpectation;
  facts: EvalFacts;
  nextId: number;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function isXAvailable(definition: EvalCase, configuration: EvalConfiguration): boolean {
  return definition.scenario.kind === 'route' && definition.scenario.route === 'x'
    && definition.scenario.xAvailable !== undefined
    ? definition.scenario.xAvailable
    : configuration.fixtureCapabilities.xSearch;
}

function runtimeSkillVisibility(
  definition: EvalCase,
  configuration: EvalConfiguration,
): { actual: string[]; expected: string[] } {
  const memoIntent = hasExplicitMemoIntent(definition.userInput);
  const xAvailable = isXAvailable(definition, configuration);
  const availableTools = new Set<string>(['calculate_dcf']);
  if (xAvailable) availableTools.add('x_search');
  if (memoIntent) availableTools.add('write_memo');

  const hasSkillTool = configuration.fixtureCapabilities.generalSkillTool
    || (configuration.runtime === 'claude-agent-sdk' && memoIntent);
  const actual = hasSkillTool
    ? discoverSkills({ availableTools, userQuery: definition.userInput })
        .map((skill) => skill.name)
        .filter((name) => BUILTIN_SKILLS.has(name))
    : [];

  const expected = new Set<string>();
  if (hasSkillTool) {
    expected.add('dcf-valuation');
    if (xAvailable) expected.add('x-research');
    if (memoIntent) expected.add('write-memo');
  }
  return { actual: sorted(actual), expected: sorted(expected) };
}

function buildState(definition: EvalCase, configuration: EvalConfiguration): BuildState {
  const visibility = runtimeSkillVisibility(definition, configuration);
  return {
    events: [],
    expected: {
      categories: [],
      skills: [],
      toolCalls: {},
      forbiddenTools: [],
    },
    facts: {
      discoverableSkills: visibility.actual,
      expectedDiscoverableSkills: visibility.expected,
      argsValid: true,
      exactOperationBound: true,
      memoryMutation: false,
      memoCreated: false,
      reasoningExposed: false,
      credentialExposed: false,
    },
    nextId: 1,
  };
}

function addCategories(state: BuildState, ...categories: ScoreCategory[]): void {
  for (const category of categories) {
    if (!state.expected.categories.includes(category)) {
      state.expected.categories.push(category);
    }
  }
}

function callTool(
  state: BuildState,
  name: string,
  args: Record<string, unknown>,
): string {
  const id = `call-${state.nextId++}`;
  state.events.push({ type: 'tool_call', id, name, args });
  state.expected.toolCalls[name] = (state.expected.toolCalls[name] ?? 0) + 1;
  return id;
}

function addSkill(state: BuildState, name: string): void {
  callTool(state, 'skill', { skill: name });
  state.expected.skills.push(name);
}

function addApproval(state: BuildState, operation: NormalizedOperation): void {
  state.events.push({ type: 'approval_requested', operation });
}

function addResult(
  state: BuildState,
  id: string,
  name: string,
  status: 'success' | 'error' | 'denied',
  output?: unknown,
): void {
  state.events.push({
    type: 'tool_result',
    id,
    name,
    status,
    ...(output !== undefined ? { output } : {}),
  });
  const statuses = state.expected.resultStatuses ?? {};
  statuses[name] = [...(statuses[name] ?? []), status];
  state.expected.resultStatuses = statuses;
}

function finalResponse(state: BuildState, text: string, ...markers: string[]): void {
  state.events.push({ type: 'final_response', text });
  state.expected.finalMarkers = [...(state.expected.finalMarkers ?? []), ...markers];
}

function forbid(state: BuildState, ...tools: string[]): void {
  for (const tool of tools) {
    if (!state.expected.forbiddenTools.includes(tool)) state.expected.forbiddenTools.push(tool);
  }
}

function expectApprovals(state: BuildState, count: number, risks: OperationRisk[] = []): void {
  state.expected.approvalCount = count;
  state.expected.approvalRisks = risks;
  addCategories(state, 'approval');
}

function addPolicyControlledCall(
  state: BuildState,
  tool: string,
  args: Record<string, unknown>,
  status: 'success' | 'error' | 'denied' = 'success',
): { id: string; operation: NormalizedOperation } {
  const id = callTool(state, tool, args);
  const operation = normalizeToolOperation(tool, args, { cwd: EVAL_CWD, now: FIXED_NOW });
  if (decideOperationApproval(operation).requirement === 'user_approval') {
    addApproval(state, operation);
  }
  addResult(state, id, tool, status, { operation: operation.kind });
  return { id, operation };
}

function dcfInput(variant: Extract<EvalCase['scenario'], { kind: 'dcf' }>['variant'] | 'valid'): CalculateDcfInput {
  switch (variant) {
    case 'equal-rates':
      return { ...BASE_DCF_INPUT, wacc: 0.02, terminalGrowthRate: 0.02 };
    case 'lower-wacc':
      return { ...BASE_DCF_INPUT, wacc: 0.01, terminalGrowthRate: 0.02 };
    case 'negative-fcf':
      return {
        ...BASE_DCF_INPUT,
        forecastFreeCashFlows: [
          { period: 'FY2027', value: -20 },
          { period: 'FY2028', value: 80 },
          { period: 'FY2029', value: 120 },
        ],
      };
    case 'net-cash':
      return { ...BASE_DCF_INPUT, netDebt: -40 };
    case 'sensitivity':
    case 'valid':
      return { ...BASE_DCF_INPUT };
  }
}

function buildDcfFlow(
  state: BuildState,
  configuration: EvalConfiguration,
  variant: Extract<EvalCase['scenario'], { kind: 'dcf' }>['variant'] | 'valid',
): void {
  addCategories(state, 'routing', 'tools', 'deterministic-output');
  if (configuration.fixtureCapabilities.generalSkillTool) {
    addSkill(state, 'dcf-valuation');
  }

  const input = dcfInput(variant);
  const id = callTool(state, 'calculate_dcf', input as Record<string, unknown>);
  const parsed = CalculateDcfInputSchema.safeParse(input);
  state.facts.argsValid = parsed.success;
  state.expected.argsValid = parsed.success;

  if (!parsed.success) {
    addResult(state, id, 'calculate_dcf', 'error', { code: 'INVALID_DCF_ASSUMPTIONS' });
    finalResponse(state, 'DCF_INPUT_REJECTED', 'DCF_INPUT_REJECTED');
    return;
  }

  const result = calculateDcfAnalysis(parsed.data);
  addResult(state, id, 'calculate_dcf', 'success', {
    intrinsicValuePerShare: result.base.intrinsicValuePerShare,
    sensitivityCells: result.sensitivity.rows.flatMap((row) => row.cells).length,
  });

  const marker = variant === 'sensitivity'
    ? `DCF_SENSITIVITY cells=${result.sensitivity.rows.flatMap((row) => row.cells).length}`
    : `DCF_RESULT intrinsicValuePerShare=${result.base.intrinsicValuePerShare}`;
  finalResponse(state, marker, variant === 'sensitivity' ? 'DCF_SENSITIVITY' : 'DCF_RESULT');

  if (variant !== 'sensitivity') {
    state.facts.numericExpected = result.base.intrinsicValuePerShare;
    state.facts.numericActual = Number(marker.split('=').at(-1));
    state.facts.numericTolerance = 1e-9;
    state.expected.requireNumericMatch = true;
  } else {
    state.facts.deterministicExpected = 'cells=9';
    state.facts.deterministicActual = `cells=${result.sensitivity.rows.flatMap((row) => row.cells).length}`;
    state.expected.requireDeterministicMatch = true;
  }
  forbid(state, 'write_memo', 'memory_update');
}

function memoDocument(variant: Extract<EvalCase['scenario'], { kind: 'memo' }>['variant'] | 'japanese'): MemoDocument {
  switch (variant) {
    case 'english':
      return { title: 'Toyota DCF memo', summary: 'Validated assumptions and conclusion.', tags: ['DCF', 'Toyota'] };
    case 'mixed':
      return { title: 'トヨタ DCF result', summary: '日本語とEnglishを混在させた確定メモ。', keyPoints: ['WACC 8%', 'growth 2%'] };
    case 'special':
      return { title: '成長/収益:*? 🚀', summary: 'Markdown # * [special] と全角記号「」を安全に扱う。' };
    case 'duplicate':
      return { title: '重複メモ', summary: '最初の内容を保持する。' };
    case 'changed-content':
      return { title: '承認内容', summary: '承認された本文。' };
    case 'changed-destination':
      return { title: '承認先', summary: '承認された保存先。' };
    case 'memory-isolation':
      return { title: 'メモと記憶の分離', summary: 'この内容はメモだけに保存する。' };
    case 'japanese':
      return { title: 'トヨタ分析メモ', summary: '確定した分析結果。', keyPoints: ['結論を記録', '内部推論は含めない'] };
  }
}

async function buildMemoFlow(
  state: BuildState,
  configuration: EvalConfiguration,
  variant: Extract<EvalCase['scenario'], { kind: 'memo' }>['variant'] | 'japanese',
): Promise<void> {
  addCategories(state, 'routing', 'tools', 'approval', 'privacy', 'deterministic-output');
  addSkill(state, 'write-memo');

  const document = memoDocument(variant);
  const rawArgs = { document };
  const id = callTool(state, 'write_memo', rawArgs);
  const operation = normalizeToolOperation('write_memo', rawArgs, { cwd: EVAL_CWD, now: FIXED_NOW });
  addApproval(state, operation);
  expectApprovals(state, 1, ['local_mutation']);
  state.facts.argsValid = memoDocumentSchema.safeParse(document).success;
  state.expected.argsValid = true;
  state.expected.memoryMutation = false;
  forbid(state, 'memory_update', 'write_file', 'edit_file');

  let status: 'success' | 'error' | 'denied' = 'success';
  let exactBound = true;
  if (variant === 'duplicate') {
    status = 'error';
  } else if (variant === 'changed-content' || variant === 'changed-destination') {
    const gate = new OperationApprovalGate(async () => 'allow-once', new Set(), {
      cwd: EVAL_CWD,
      now: FIXED_NOW,
    });
    await gate.authorize('write_memo', rawArgs);
    const changedDocument = variant === 'changed-content'
      ? { ...document, summary: '承認後に差し替えた本文。' }
      : { ...document, title: '別の保存先' };
    try {
      gate.claim('write_memo', { document: changedDocument });
      exactBound = false;
    } catch {
      exactBound = true;
    }
    status = 'denied';
  }

  state.facts.exactOperationBound = exactBound;
  state.expected.exactOperationBound = true;
  const prepared = prepareWriteMemoInput(rawArgs, FIXED_CREATED);
  const rendered = renderMemo(prepared.document, { created: prepared.created });
  const renderedAgain = renderMemo(prepared.document, { created: prepared.created });
  const hash = createHash('sha256').update(rendered).digest('hex');
  const secondHash = createHash('sha256').update(renderedAgain).digest('hex');
  state.facts.deterministicActual = hash;
  state.facts.deterministicExpected = secondHash;
  state.expected.requireDeterministicMatch = true;
  state.facts.memoCreated = status === 'success';
  state.expected.memoCreated = status === 'success';
  addResult(state, id, 'write_memo', status, {
    sha256: hash,
    bytes: Buffer.byteLength(rendered, 'utf8'),
    path: operation.target,
  });

  if (status === 'success') {
    finalResponse(state, `MEMO_CREATED sha256=${hash}`, 'MEMO_CREATED');
  } else if (status === 'error') {
    finalResponse(state, 'MEMO_DUPLICATE_REJECTED', 'MEMO_DUPLICATE_REJECTED');
  } else {
    finalResponse(state, 'MEMO_OPERATION_CHANGED_REJECTED', 'MEMO_OPERATION_CHANGED_REJECTED');
  }
}

async function buildRoute(
  definition: EvalCase,
  configuration: EvalConfiguration,
  state: BuildState,
): Promise<void> {
  if (definition.scenario.kind !== 'route') return;
  addCategories(state, 'routing', 'tools');

  switch (definition.scenario.route) {
    case 'dcf':
      buildDcfFlow(state, configuration, 'valid');
      return;
    case 'x': {
      const available = isXAvailable(definition, configuration);
      if (available && configuration.runtime === 'langchain') {
        addSkill(state, 'x-research');
        const id = callTool(state, 'x_search', { query: 'Toyota earnings' });
        addResult(state, id, 'x_search', 'success', { posts: 3 });
        finalResponse(state, 'X_RESEARCH_COMPLETE', 'X_RESEARCH_COMPLETE');
      } else {
        forbid(state, 'x_search');
        finalResponse(state, 'CAPABILITY_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE');
      }
      return;
    }
    case 'memo':
      await buildMemoFlow(state, configuration, 'japanese');
      return;
    case 'memory':
      forbid(state, 'write_memo');
      if (configuration.fixtureCapabilities.durableMemory) {
        const args = { action: 'append', file: 'long_term', content: '- Explicit user memory' };
        addPolicyControlledCall(state, 'memory_update', args);
        expectApprovals(state, 1, ['local_mutation']);
        state.facts.memoryMutation = true;
        state.expected.memoryMutation = true;
        addCategories(state, 'privacy');
        finalResponse(state, 'MEMORY_UPDATED', 'MEMORY_UPDATED');
      } else {
        forbid(state, 'memory_update');
        finalResponse(state, 'MEMORY_CAPABILITY_UNAVAILABLE', 'MEMORY_CAPABILITY_UNAVAILABLE');
      }
      return;
    case 'none':
      forbid(state, 'calculate_dcf', 'x_search', 'write_memo', 'memory_update');
      finalResponse(state, 'NO_SPECIALIZED_ACTION', 'NO_SPECIALIZED_ACTION');
  }
}

async function buildApprovalFlow(state: BuildState, variant: Extract<EvalCase['scenario'], { kind: 'approval' }>['variant']): Promise<void> {
  addCategories(state, 'tools', 'approval');

  switch (variant) {
    case 'read': {
      addPolicyControlledCall(state, 'read_file', { path: 'notes.md' });
      expectApprovals(state, 0);
      break;
    }
    case 'local-mutation': {
      addPolicyControlledCall(state, 'edit_file', { path: 'notes.md', old_text: 'a', new_text: 'b' });
      expectApprovals(state, 1, ['local_mutation']);
      break;
    }
    case 'external-mutation': {
      addPolicyControlledCall(state, 'heartbeat', { action: 'update', content: '- Check status' });
      expectApprovals(state, 1, ['external_mutation']);
      break;
    }
    case 'destructive-mutation': {
      addPolicyControlledCall(state, 'cron', { action: 'remove', jobId: 'job-1' });
      expectApprovals(state, 1, ['destructive']);
      break;
    }
    case 'same-tool-different-action': {
      addPolicyControlledCall(state, 'cron', { action: 'list' });
      addPolicyControlledCall(state, 'cron', { action: 'remove', jobId: 'job-1' });
      expectApprovals(state, 1, ['destructive']);
      break;
    }
    case 'changed-target':
    case 'changed-args': {
      const original = variant === 'changed-target'
        ? { path: 'approved.md', old_text: 'a', new_text: 'b' }
        : { path: 'approved.md', content: 'approved' };
      const tool = variant === 'changed-target' ? 'edit_file' : 'write_file';
      const changed = variant === 'changed-target'
        ? { ...original, path: 'different.md' }
        : { ...original, content: 'changed' };
      const id = callTool(state, tool, original);
      const gate = new OperationApprovalGate(async () => 'allow-once', new Set(), {
        cwd: EVAL_CWD,
        now: FIXED_NOW,
      });
      const authorization = await gate.authorize(tool, original);
      addApproval(state, authorization.operation);
      try {
        gate.claim(tool, changed);
        state.facts.exactOperationBound = false;
      } catch {
        state.facts.exactOperationBound = true;
      }
      addResult(state, id, tool, 'denied', { code: 'OPERATION_CHANGED' });
      state.expected.exactOperationBound = true;
      expectApprovals(state, 1, [authorization.operation.risk]);
      break;
    }
    case 'retry-identical':
    case 'retry-changed': {
      let promptCount = 0;
      const gate = new OperationApprovalGate(async () => {
        promptCount++;
        return 'allow-session';
      }, new Set(), { cwd: EVAL_CWD, now: FIXED_NOW });
      const firstArgs = { path: 'notes.md', old_text: 'a', new_text: 'b' };
      const secondArgs = variant === 'retry-identical'
        ? firstArgs
        : { ...firstArgs, new_text: 'c' };
      for (const args of [firstArgs, secondArgs]) {
        const id = callTool(state, 'edit_file', args);
        const authorization = await gate.authorize('edit_file', args);
        if (authorization.prompted) addApproval(state, authorization.operation);
        gate.claim('edit_file', authorization.operation.arguments as Record<string, unknown>);
        addResult(state, id, 'edit_file', 'success');
      }
      const expectedPrompts = variant === 'retry-identical' ? 1 : 2;
      expectApprovals(state, expectedPrompts, Array.from({ length: expectedPrompts }, () => 'local_mutation'));
      state.facts.deterministicActual = String(promptCount);
      state.facts.deterministicExpected = String(expectedPrompts);
      state.expected.requireDeterministicMatch = true;
      addCategories(state, 'deterministic-output');
      break;
    }
    case 'unknown-operation': {
      const args = { action: 'mutate', target: 'opaque-resource' };
      const id = callTool(state, 'unknown_mutation', args);
      const operation = normalizeToolOperation('unknown_mutation', args, { cwd: EVAL_CWD, now: FIXED_NOW });
      addApproval(state, operation);
      addResult(state, id, 'unknown_mutation', 'denied', { code: 'UNKNOWN_FAIL_CLOSED' });
      expectApprovals(state, 1, ['sensitive']);
      break;
    }
  }
  finalResponse(state, 'APPROVAL_CONTRACT_EVALUATED', 'APPROVAL_CONTRACT_EVALUATED');
}

async function buildPrivacyFlow(
  state: BuildState,
  configuration: EvalConfiguration,
  variant: Extract<EvalCase['scenario'], { kind: 'privacy' }>['variant'],
): Promise<void> {
  addCategories(state, 'privacy');
  state.expected.memoryMutation = false;

  switch (variant) {
    case 'explicit-memory':
      if (configuration.fixtureCapabilities.durableMemory) {
        const args = { action: 'append', file: 'long_term', content: '- Explicit user memory' };
        addPolicyControlledCall(state, 'memory_update', args);
        expectApprovals(state, 1, ['local_mutation']);
        addCategories(state, 'tools', 'approval');
        state.facts.memoryMutation = true;
        state.expected.memoryMutation = true;
        finalResponse(state, 'MEMORY_UPDATED', 'MEMORY_UPDATED');
      } else {
        forbid(state, 'memory_update', 'write_memo');
        finalResponse(state, 'MEMORY_CAPABILITY_UNAVAILABLE', 'MEMORY_CAPABILITY_UNAVAILABLE');
      }
      return;
    case 'memo':
      await buildMemoFlow(state, configuration, 'memory-isolation');
      return;
    case 'tool-result': {
      const id = callTool(state, 'read_filings', { ticker: '7203' });
      addResult(state, id, 'read_filings', 'success', { evidence: 'observable-only' });
      addCategories(state, 'tools');
      forbid(state, 'memory_update');
      finalResponse(state, 'TOOL_RESULT_TRANSIENT', 'TOOL_RESULT_TRANSIENT');
      return;
    }
    case 'compaction':
      forbid(state, 'memory_update');
      finalResponse(state, 'CONTEXT_COMPACTED_TRANSIENTLY', 'CONTEXT_COMPACTED_TRANSIENTLY');
      return;
    case 'conversation':
      forbid(state, 'memory_update');
      finalResponse(state, 'CONVERSATION_TRANSIENT', 'CONVERSATION_TRANSIENT');
      return;
    case 'scratchpad':
      forbid(state, 'memory_update');
      finalResponse(state, 'SCRATCHPAD_TRANSIENT', 'SCRATCHPAD_TRANSIENT');
      return;
    case 'restart':
      forbid(state, 'memory_update');
      finalResponse(state, 'TRANSIENT_STATE_NOT_RESTORED', 'TRANSIENT_STATE_NOT_RESTORED');
  }
}

export async function materializeEvalCase(
  definition: EvalCase,
  configuration: EvalConfiguration,
): Promise<MaterializedEvalCase> {
  const state = buildState(definition, configuration);

  switch (definition.scenario.kind) {
    case 'route':
      await buildRoute(definition, configuration, state);
      break;
    case 'dcf':
      buildDcfFlow(state, configuration, definition.scenario.variant);
      break;
    case 'approval':
      await buildApprovalFlow(state, definition.scenario.variant);
      break;
    case 'privacy':
      await buildPrivacyFlow(state, configuration, definition.scenario.variant);
      break;
    case 'memo':
      await buildMemoFlow(state, configuration, definition.scenario.variant);
      break;
  }

  state.expected.skills.sort();
  state.expected.forbiddenTools.sort();
  return {
    definition,
    fixture: encodeRecordedFixture(configuration, state.events),
    expected: state.expected,
    facts: state.facts,
  };
}