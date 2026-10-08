import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  buildFailureDiagnostic,
  evaluateAcceptanceExecution,
  sanitizeFailureArtifact,
} from './evaluate.js';
import { runAcceptanceScenario } from './harness.js';
import { ACCEPTANCE_SCENARIOS } from './scenarios.js';
import {
  PRACTICAL_ACCEPTANCE_SUITE_VERSION,
  type AcceptanceCaseResult,
  type AcceptanceFailureDiagnostic,
  type AcceptanceFinding,
  type AcceptanceReport,
  type AcceptanceScenario,
} from './types.js';

export interface RunAcceptanceOptions {
  scenarios?: readonly AcceptanceScenario[];
  workspaceParent?: string;
}

function safeScenarioDirectory(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

async function removeGeneratedSuiteRoot(root: string, parent: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedParent = resolve(parent);
  const insideParent = resolvedRoot.startsWith(resolvedParent + sep);
  if (!insideParent || !basename(resolvedRoot).startsWith('phase8-')) {
    throw new Error(`Refusing to remove an unverified acceptance workspace: ${resolvedRoot}`);
  }
  await rm(resolvedRoot, { recursive: true, force: true });
}

function harnessFailure(
  scenario: AcceptanceScenario,
  error: unknown,
): { result: AcceptanceCaseResult; diagnostic: AcceptanceFailureDiagnostic; finding: AcceptanceFinding } {
  const message = error instanceof Error ? error.message : String(error);
  const result: AcceptanceCaseResult = {
    id: scenario.id,
    category: scenario.category,
    passed: false,
    turns: scenario.turns.length,
    assertions: [{ passed: false, message: `Acceptance harness failed: ${message}` }],
    criticalFailures: [],
    fileDiff: { created: [], modified: [], deleted: [] },
    memoryChanged: false,
    memoChanged: false,
  };
  const diagnostic: AcceptanceFailureDiagnostic = {
    scenarioId: scenario.id,
    classification: 'TEST HARNESS BUG',
    failedAssertions: result.assertions,
    normalizedObservableEvents: [],
    expected: scenario.expectedOutcome,
    actual: { error: message },
  };
  return {
    result,
    diagnostic,
    finding: { scenarioId: scenario.id, classification: 'TEST HARNESS BUG', summary: message },
  };
}

export async function runAcceptanceSuite(
  options: RunAcceptanceOptions = {},
): Promise<AcceptanceReport> {
  const scenarios = options.scenarios ?? ACCEPTANCE_SCENARIOS;
  const parent = resolve(options.workspaceParent ?? join(process.cwd(), '.dexter', 'acceptance-runs'));
  await mkdir(parent, { recursive: true });
  const suiteRoot = await mkdtemp(join(parent, 'phase8-'));
  const cases: AcceptanceCaseResult[] = [];
  const diagnostics: AcceptanceFailureDiagnostic[] = [];
  const findings: AcceptanceFinding[] = [];

  try {
    for (const scenario of scenarios) {
      try {
        const execution = await runAcceptanceScenario(
          scenario,
          join(suiteRoot, safeScenarioDirectory(scenario.id)),
        );
        const result = evaluateAcceptanceExecution(execution);
        cases.push(result);
        if (!result.passed) {
          diagnostics.push(buildFailureDiagnostic(execution, result));
          findings.push({
            scenarioId: scenario.id,
            classification: scenario.failureClassification ?? 'PRODUCT BUG',
            summary: result.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.message).join('; '),
          });
        }
      } catch (error) {
        const failure = harnessFailure(scenario, error);
        cases.push(failure.result);
        diagnostics.push(failure.diagnostic);
        findings.push(failure.finding);
      }
    }
  } finally {
    await removeGeneratedSuiteRoot(suiteRoot, parent);
  }

  const criticalFailures = cases.flatMap((result) =>
    result.criticalFailures.map((kind) => ({ scenarioId: result.id, kind })),
  );
  const failed = cases.filter((result) => !result.passed).length;
  return {
    schemaVersion: 1,
    suiteVersion: PRACTICAL_ACCEPTANCE_SUITE_VERSION,
    mode: 'offline-scripted-workflow',
    result: failed === 0 && criticalFailures.length === 0 ? 'PASS' : 'FAIL',
    scenarioCount: cases.length,
    turnCount: scenarios.reduce((sum, scenario) => sum + scenario.turns.length, 0),
    multiTurnScenarioCount: scenarios.filter((scenario) => scenario.turns.length > 1).length,
    passed: cases.length - failed,
    failed,
    criticalFailures,
    cases,
    findings,
    failureDiagnostics: diagnostics,
    evidence: {
      liveCalls: false,
      xCapability: 'observable-stub',
      phase7Mode: 'offline-fixture',
      phase8Mode: 'offline-scripted-workflow',
      fixturesContainHiddenReasoning: false,
    },
  };
}

export async function writeFailureArtifact(
  report: AcceptanceReport,
  path: string,
): Promise<string | null> {
  if (report.result === 'PASS') return null;
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const payload = sanitizeFailureArtifact({
    schemaVersion: 1,
    suiteVersion: report.suiteVersion,
    result: report.result,
    mode: report.mode,
    evidence: report.evidence,
    criticalFailures: report.criticalFailures,
    failures: report.failureDiagnostics,
  });
  await writeFile(absolute, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return absolute;
}