import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { normalizeToolOperation } from '../../approval/operation-policy.js';
import { buildFailureDiagnostic, evaluateAcceptanceExecution } from './evaluate.js';
import { runAcceptanceScenario } from './harness.js';
import { runAcceptanceSuite, writeFailureArtifact } from './runner.js';
import { ACCEPTANCE_SCENARIOS } from './scenarios.js';
import type { AcceptanceReport } from './types.js';

const testBase = resolve(process.cwd(), '.dexter', 'acceptance-test-runs');
let testParent: string;
let report: AcceptanceReport;

async function removeTestRoot(path: string): Promise<void> {
  const parent = resolve(testParent);
  const target = resolve(path);
  if (!target.startsWith(parent + sep)) throw new Error(`Unsafe test cleanup target: ${target}`);
  await rm(target, { recursive: true, force: true });
}

beforeAll(async () => {
  await mkdir(testBase, { recursive: true });
  testParent = await mkdtemp(join(testBase, 'phase8-test-'));
  report = await runAcceptanceSuite();
});

afterAll(async () => {
  const target = resolve(testParent);
  if (!target.startsWith(resolve(testBase) + sep) || !target.split(sep).at(-1)?.startsWith('phase8-test-')) {
    throw new Error(`Unsafe suite cleanup target: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
});

describe('Phase 8 practical workflow acceptance', () => {
  test('defines 20-30 data-driven scenarios with at least five multi-turn workflows', () => {
    expect(ACCEPTANCE_SCENARIOS.length).toBe(30);
    expect(ACCEPTANCE_SCENARIOS.filter((scenario) => scenario.turns.length > 1).length).toBeGreaterThanOrEqual(5);
    expect(new Set(ACCEPTANCE_SCENARIOS.map((scenario) => scenario.id)).size).toBe(ACCEPTANCE_SCENARIOS.length);
  });

  test('covers every required workflow category and adversarial boundary', () => {
    const categories = new Set(ACCEPTANCE_SCENARIOS.map((scenario) => scenario.category));
    expect(categories).toEqual(new Set(['dcf', 'research-x', 'memo', 'memory', 'approval', 'privacy', 'adversarial']));
    expect(ACCEPTANCE_SCENARIOS.filter((scenario) => scenario.category === 'adversarial').length).toBeGreaterThanOrEqual(5);
  });

  test('runs all practical workflows without live APIs or critical failures', () => {
    expect(report.result).toBe('PASS');
    expect(report.mode).toBe('offline-scripted-workflow');
    expect(report.passed).toBe(30);
    expect(report.failed).toBe(0);
    expect(report.criticalFailures).toEqual([]);
    expect(report.evidence).toEqual({
      liveCalls: false,
      xCapability: 'observable-stub',
      phase7Mode: 'offline-fixture',
      phase8Mode: 'offline-scripted-workflow',
      fixturesContainHiddenReasoning: false,
    });
  });

  test('records file and state outcomes without relying on exact final prose', () => {
    const memoCase = report.cases.find((result) => result.id === 'C1-memo-japanese-multiturn');
    const restartCase = report.cases.find((result) => result.id === 'F3-privacy-restart-durable-only');
    expect(memoCase?.fileDiff.created).toEqual(['.dexter/memos/20260115-日本語の会議メモ.md']);
    expect(memoCase?.memoryChanged).toBe(false);
    expect(restartCase?.memoryChanged).toBe(true);
    expect(restartCase?.memoChanged).toBe(false);
  });

  test('detects an approval bypass as a critical failure', async () => {
    const scenario = ACCEPTANCE_SCENARIOS.find((candidate) => candidate.id === 'E2-approval-local-mutation');
    expect(scenario).toBeDefined();
    const root = await mkdtemp(join(testParent, 'bypass-'));
    try {
      const execution = await runAcceptanceScenario(scenario!, root);
      const tampered = {
        ...execution,
        events: execution.events.filter((event) => event.type !== 'approval_outcome'),
      };
      const result = evaluateAcceptanceExecution(tampered);
      expect(result.passed).toBe(false);
      expect(result.criticalFailures).toContain('approval_bypass');
      const diagnostic = buildFailureDiagnostic(tampered, result);
      expect(diagnostic.failedAssertions.length).toBeGreaterThan(0);
    } finally {
      await removeTestRoot(root);
    }
  });

  test('failure artifacts contain only sanitized observable diagnostics', async () => {
    const root = await mkdtemp(join(testParent, 'artifact-'));
    try {
      const operation = normalizeToolOperation('write_file', { path: 'x.txt', content: 'safe' }, { cwd: root });
      const failedReport: AcceptanceReport = {
        ...report,
        result: 'FAIL',
        failed: 1,
        passed: report.passed - 1,
        failureDiagnostics: [{
          scenarioId: 'synthetic-failure',
          classification: 'TEST HARNESS BUG',
          failedAssertions: [{ passed: false, message: 'synthetic' }],
          normalizedObservableEvents: [{
            type: 'tool_result',
            turn: 1,
            name: 'write_file',
            status: 'error',
            operation,
            outputSummary: {
              reasoning: 'PRIVATE_REASONING_VALUE',
              scratchpad: 'PRIVATE_SCRATCHPAD_VALUE',
              api_key: 'PRIVATE_CREDENTIAL_VALUE',
              observable: 'safe diagnostic',
            },
          }],
          expected: { status: 'success' },
          actual: { status: 'error' },
        }],
      };
      const artifactPath = join(root, 'failure.json');
      expect(await writeFailureArtifact(failedReport, artifactPath)).toBe(artifactPath);
      const artifact = await readFile(artifactPath, 'utf8');
      expect(artifact).toContain('safe diagnostic');
      expect(artifact).not.toContain('PRIVATE_REASONING_VALUE');
      expect(artifact).not.toContain('PRIVATE_SCRATCHPAD_VALUE');
      expect(artifact).not.toContain('PRIVATE_CREDENTIAL_VALUE');
      expect(artifact).not.toMatch(/reasoning|scratchpad|api_key/i);
    } finally {
      await removeTestRoot(root);
    }
  });
});