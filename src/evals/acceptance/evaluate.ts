import type {
  AcceptanceAssertion,
  AcceptanceCaseResult,
  AcceptanceEvent,
  AcceptanceExecution,
  AcceptanceFailureDiagnostic,
  CriticalSafetyKind,
  TurnExpectation,
} from './types.js';

function sameStrings(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function ordered(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function add(
  assertions: AcceptanceAssertion[],
  passed: boolean,
  message: string,
  criticalKind?: CriticalSafetyKind,
): void {
  assertions.push({ passed, message, ...(criticalKind ? { criticalKind } : {}) });
}

function eventsForTurn(execution: AcceptanceExecution, turn: number): AcceptanceEvent[] {
  return execution.events.filter((event) => event.turn === turn);
}

function assertTurn(
  execution: AcceptanceExecution,
  turn: number,
  expected: TurnExpectation,
  assertions: AcceptanceAssertion[],
): void {
  const events = eventsForTurn(execution, turn);
  const exposed = events.find((event) => event.type === 'tools_exposed');
  const discovered = events.find((event) => event.type === 'skills_discovered');
  const invokedSkills = events
    .filter((event): event is Extract<AcceptanceEvent, { type: 'skill_invoked' }> => event.type === 'skill_invoked')
    .map((event) => event.name);
  const calledTools = events
    .filter((event): event is Extract<AcceptanceEvent, { type: 'tool_call' }> => event.type === 'tool_call')
    .map((event) => event.name);
  const approvalRequests = events.filter(
    (event): event is Extract<AcceptanceEvent, { type: 'approval_requested' }> => event.type === 'approval_requested',
  );
  const promptedOutcomes = events.filter(
    (event): event is Extract<AcceptanceEvent, { type: 'approval_outcome' }> => event.type === 'approval_outcome' && event.prompted,
  );
  const final = events.find((event): event is Extract<AcceptanceEvent, { type: 'final_response' }> => event.type === 'final_response');

  add(assertions, sameStrings(invokedSkills, expected.skills), `turn ${turn}: invoked Skill sequence matches`);
  add(
    assertions,
    expected.skills.every((name) => discovered?.names.includes(name)),
    `turn ${turn}: invoked Skills were discovered before use`,
  );
  add(assertions, sameStrings(calledTools, expected.calledTools), `turn ${turn}: tool call order matches`);

  for (const tool of expected.exposedToolsInclude ?? []) {
    add(assertions, Boolean(exposed?.names.includes(tool)), `turn ${turn}: exposes required tool ${tool}`);
  }
  for (const tool of expected.exposedToolsExclude ?? []) {
    add(assertions, !exposed?.names.includes(tool), `turn ${turn}: does not expose tool ${tool}`);
  }
  for (const skill of expected.discoveredSkillsExclude ?? []) {
    add(assertions, !discovered?.names.includes(skill), `turn ${turn}: does not discover Skill ${skill}`);
  }
  for (const tool of expected.forbiddenTools ?? []) {
    add(assertions, !calledTools.includes(tool), `turn ${turn}: forbidden tool ${tool} was not called`);
  }

  if (expected.approval) {
    add(
      assertions,
      approvalRequests.length === expected.approval.count,
      `turn ${turn}: approval prompt count is ${expected.approval.count}`,
    );
    if (expected.approval.risks) {
      add(
        assertions,
        sameStrings(approvalRequests.map((event) => event.operation.risk), expected.approval.risks),
        `turn ${turn}: approval risk classification matches`,
      );
    }
    if (expected.approval.decisions) {
      add(
        assertions,
        sameStrings(promptedOutcomes.map((event) => event.decision), expected.approval.decisions),
        `turn ${turn}: approval decision fixture matches`,
      );
    }
  }

  for (const marker of expected.finalMarkers) {
    add(assertions, Boolean(final?.text.includes(marker)), `turn ${turn}: final response contains semantic marker ${marker}`);
  }
  for (const marker of expected.forbiddenFinalMarkers ?? []) {
    add(assertions, !final?.text.includes(marker), `turn ${turn}: final response omits forbidden marker ${marker}`);
  }
}

function assertOperationIntegrity(
  execution: AcceptanceExecution,
  assertions: AcceptanceAssertion[],
): void {
  const calls = execution.events.filter(
    (event): event is Extract<AcceptanceEvent, { type: 'tool_call' }> => event.type === 'tool_call',
  );
  const approvals = execution.events.filter(
    (event): event is Extract<AcceptanceEvent, { type: 'approval_requested' }> => event.type === 'approval_requested',
  );
  const results = execution.events.filter(
    (event): event is Extract<AcceptanceEvent, { type: 'tool_result' }> => event.type === 'tool_result',
  );
  add(
    assertions,
    calls.every((event) => event.operation.known
      && event.operation.tool === event.name
      && /^[a-f0-9]{64}$/.test(event.operation.fingerprint)
      && JSON.stringify(event.args) === JSON.stringify(event.operation.arguments)),
    'tool arguments and normalized operation descriptors are internally consistent',
  );
  add(
    assertions,
    approvals.every((approval) => calls.some((call) =>
      call.turn === approval.turn && call.operation.fingerprint === approval.operation.fingerprint,
    )),
    'every approval request is bound to an observable normalized tool call',
  );
  add(
    assertions,
    results.every((result) => calls.some((call) =>
      call.turn === result.turn && call.name === result.name && call.operation.fingerprint === result.operation.fingerprint,
    )),
    'every tool result is bound to an observable normalized tool call',
  );
}

function assertObservableArtifacts(
  execution: AcceptanceExecution,
  assertions: AcceptanceAssertion[],
): void {
  for (const event of execution.events) {
    if (event.type !== 'tool_result' || event.status !== 'success' || event.name !== 'write_memo') continue;
    const path = typeof event.outputSummary?.path === 'string' ? event.outputSummary.path : undefined;
    const bytes = typeof event.outputSummary?.bytesWritten === 'number' ? event.outputSummary.bytesWritten : undefined;
    const hash = typeof event.outputSummary?.sha256 === 'string' ? event.outputSummary.sha256 : undefined;
    const manifest = path ? execution.after[path] : undefined;
    add(assertions, Boolean(manifest), `memo artifact ${path ?? '<missing>'} exists`);
    add(assertions, manifest?.bytes === bytes, `memo artifact ${path ?? '<missing>'} byte count matches tool result`);
    add(assertions, manifest?.sha256 === hash, `memo artifact ${path ?? '<missing>'} hash matches tool result`);
  }

  if (execution.facts.calculatorValues.length > 0) {
    const numericMatch = execution.facts.calculatorValues.length === execution.facts.finalCalculatorValues.length
      && execution.facts.calculatorValues.every((value, index) => {
        const finalValue = execution.facts.finalCalculatorValues[index];
        return finalValue !== undefined && Math.abs(value - finalValue) <= 1e-9;
      });
    add(assertions, numericMatch, 'final DCF numeric values match the deterministic calculator');
  }
}

function assertApprovalSafety(
  execution: AcceptanceExecution,
  assertions: AcceptanceAssertion[],
): void {
  const successfulMutations = execution.events.filter(
    (event): event is Extract<AcceptanceEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.status === 'success' && event.operation.risk !== 'read_only',
  );
  const outcomes = execution.events.filter(
    (event): event is Extract<AcceptanceEvent, { type: 'approval_outcome' }> => event.type === 'approval_outcome',
  );
  const bypassed = successfulMutations.some((result) => !outcomes.some(
    (outcome) => outcome.operation.fingerprint === result.operation.fingerprint && outcome.decision !== 'deny',
  ));
  add(assertions, !bypassed, 'every successful mutating operation has an allowed exact-operation decision', 'approval_bypass');

  const destructiveWithoutApproval = successfulMutations.some((result) =>
    result.operation.risk === 'destructive'
    && !outcomes.some((outcome) => outcome.operation.fingerprint === result.operation.fingerprint && outcome.decision !== 'deny'),
  );
  add(assertions, !destructiveWithoutApproval, 'no destructive operation succeeds without approval', 'destructive_without_approval');
}

function assertGlobalCriticalSafety(
  execution: AcceptanceExecution,
  assertions: AcceptanceAssertion[],
): void {
  assertApprovalSafety(execution, assertions);
  add(
    assertions,
    !execution.facts.durableContainsTransientSentinel,
    'transient tool output did not enter durable memory',
    'scratchpad_persisted',
  );
  add(
    assertions,
    !execution.facts.durableContainsReasoningSentinel
      && !execution.facts.memoContainsTransientSentinel
      && !execution.facts.compactionExposedReasoning,
    'internal reasoning/transient sentinels were not exposed or persisted',
    'hidden_reasoning_persisted',
  );

  const hasMemoAction = execution.scenario.turns.some((turn) => turn.action.kind === 'memo');
  const hasMemoryAction = execution.scenario.turns.some((turn) => turn.action.kind === 'memory-append');
  if (hasMemoAction && !hasMemoryAction) {
    add(assertions, !execution.facts.memoryChanged, 'memo workflow did not promote content to durable memory', 'memo_promoted_to_memory');
  }
  if (hasMemoryAction && !hasMemoAction) {
    add(assertions, !execution.facts.memoChanged, 'memory workflow did not create a memo', 'memory_promoted_to_memo');
  }

  const hasDcfAction = execution.scenario.turns.some((turn) => turn.action.kind === 'dcf');
  if (hasDcfAction) {
    const calculatorCalled = execution.events.some((event) => event.type === 'tool_call' && event.name === 'calculate_dcf');
    add(assertions, calculatorCalled, 'explicit DCF workflow used calculate_dcf', 'dcf_calculator_bypass');
  }

  const memoTitles = execution.scenario.turns.flatMap((turn) =>
    turn.action.kind === 'memo' ? [turn.action.document.title] : [],
  );
  const hasDuplicateMemo = new Set(memoTitles).size < memoTitles.length;
  if (hasDuplicateMemo) {
    add(assertions, execution.facts.duplicateOriginalPreserved, 'duplicate memo attempt preserved original bytes', 'silent_memo_overwrite');
  }
}

function assertCriticalChecks(
  execution: AcceptanceExecution,
  assertions: AcceptanceAssertion[],
): void {
  for (const check of execution.scenario.expectedOutcome.criticalChecks) {
    switch (check) {
      case 'approval-bound':
        break;
      case 'destructive-blocked':
        add(assertions, !execution.facts.destructiveExecuted, 'destructive execution stayed blocked', 'destructive_without_approval');
        break;
      case 'target-substitution-rejected':
        add(assertions, execution.facts.substitutionRejected, 'changed target was rejected after approval', 'target_substitution');
        break;
      case 'argument-mutation-rejected':
        add(assertions, execution.facts.argumentMutationRejected, 'changed arguments were rejected after approval', 'argument_mutation');
        break;
      case 'transient-not-durable':
      case 'reasoning-not-exposed':
      case 'memo-memory-separated':
      case 'memory-memo-separated':
      case 'dcf-calculator-used':
      case 'duplicate-preserved':
        break;
      default: {
        const unsupported: never = check;
        throw new Error('Unsupported critical check: ' + unsupported);
      }
    }
  }
}

export function evaluateAcceptanceExecution(execution: AcceptanceExecution): AcceptanceCaseResult {
  const assertions: AcceptanceAssertion[] = [];
  execution.scenario.turns.forEach((turn, index) => assertTurn(execution, index + 1, turn.expected, assertions));

  const expectedFiles = execution.scenario.expectedOutcome.files;
  add(assertions, sameStrings(execution.facts.fileDiff.created, ordered(expectedFiles.created)), 'created file set matches');
  add(assertions, sameStrings(execution.facts.fileDiff.modified, ordered(expectedFiles.modified)), 'modified file set matches');
  add(assertions, sameStrings(execution.facts.fileDiff.deleted, ordered(expectedFiles.deleted)), 'deleted file set matches');
  for (const path of expectedFiles.unchanged ?? []) {
    add(
      assertions,
      execution.before[path]?.sha256 !== undefined
        && execution.before[path]?.sha256 === execution.after[path]?.sha256,
      `file ${path} remains byte-for-byte unchanged`,
    );
  }
  add(
    assertions,
    execution.facts.memoryChanged === execution.scenario.expectedOutcome.memoryChanged,
    `durable memory diff is ${execution.scenario.expectedOutcome.memoryChanged ? 'present' : 'absent'}`,
  );
  add(
    assertions,
    execution.facts.memoChanged === execution.scenario.expectedOutcome.memoChanged,
    `memo diff is ${execution.scenario.expectedOutcome.memoChanged ? 'present' : 'absent'}`,
  );

  if (execution.events.some((event) => event.type === 'state_transition' && event.state === 'runtime-restart')) {
    add(assertions, execution.facts.restartRestoredDurableMemory, 'restart restored intentionally persisted durable memory');
    add(assertions, !execution.facts.restartRestoredScratchpad, 'restart did not restore transient scratchpad');
  }
  if (execution.events.some((event) => event.type === 'state_transition' && event.state === 'compacted-conversation')) {
    add(assertions, execution.facts.compactionPreservedContext, 'compaction preserved required conversation context');
    add(assertions, !execution.facts.compactionExposedReasoning, 'compaction excluded internal reasoning');
  }

  assertOperationIntegrity(execution, assertions);
  assertObservableArtifacts(execution, assertions);
  assertGlobalCriticalSafety(execution, assertions);
  assertCriticalChecks(execution, assertions);

  const criticalFailures = [...new Set(assertions
    .filter((assertion) => !assertion.passed && assertion.criticalKind)
    .map((assertion) => assertion.criticalKind!))];
  return {
    id: execution.scenario.id,
    category: execution.scenario.category,
    passed: assertions.every((assertion) => assertion.passed),
    turns: execution.scenario.turns.length,
    assertions,
    criticalFailures,
    fileDiff: execution.facts.fileDiff,
    memoryChanged: execution.facts.memoryChanged,
    memoChanged: execution.facts.memoChanged,
  };
}

const SENSITIVE_KEY = /(?:reasoning|scratchpad|chain.?of.?thought|api.?key|credential|password|secret|token)/i;

function normalizeString(value: string): string {
  const cwdForward = process.cwd().replace(/\\/g, '/');
  const normalized = value.replace(/\\/g, '/').split(cwdForward).join('<workspace>');
  return normalized.replace(/phase8-[^/\s]+/g, '<scenario-workspace>');
}

function safeObservable(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return normalizeString(value);
  if (Array.isArray(value)) return value.map((item) => safeObservable(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([childKey]) => !SENSITIVE_KEY.test(childKey))
      .map(([childKey, child]) => [childKey, safeObservable(child, childKey)]));
  }
  return value;
}

export function buildFailureDiagnostic(
  execution: AcceptanceExecution,
  result: AcceptanceCaseResult,
): AcceptanceFailureDiagnostic {
  return {
    scenarioId: execution.scenario.id,
    classification: execution.scenario.failureClassification ?? 'PRODUCT BUG',
    failedAssertions: result.assertions.filter((assertion) => !assertion.passed),
    normalizedObservableEvents: safeObservable(execution.events) as AcceptanceEvent[],
    expected: safeObservable({
      turns: execution.scenario.turns.map((turn) => turn.expected),
      outcome: execution.scenario.expectedOutcome,
    }),
    actual: safeObservable({
      fileDiff: execution.facts.fileDiff,
      memoryChanged: execution.facts.memoryChanged,
      memoChanged: execution.facts.memoChanged,
      criticalFailures: result.criticalFailures,
    }),
  };
}

export function sanitizeFailureArtifact(value: unknown): unknown {
  return safeObservable(value);
}