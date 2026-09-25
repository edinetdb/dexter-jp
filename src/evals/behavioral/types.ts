import type { NormalizedOperation, OperationRisk } from '../../approval/operation-policy.js';
import type { AstraOfflineReport } from '../astra/types.js';

export const BEHAVIORAL_EVAL_SUITE_VERSION = 'phase7-v1' as const;

export type EvalRuntime = 'langchain' | 'claude-agent-sdk';
export type EvalMode = 'offline-fixture';
export type EvalLayer = 1 | 2 | 3 | 4;
export type EvalSuite =
  | 'skill-activation'
  | 'dcf'
  | 'approval'
  | 'privacy'
  | 'memo'
  | 'adversarial-routing';
export type ScoreCategory =
  | 'routing'
  | 'tools'
  | 'approval'
  | 'privacy'
  | 'deterministic-output';

export interface EvalConfiguration {
  id: string;
  runtime: EvalRuntime;
  provider: string;
  modelIdentifier: string | null;
  modelSelection: 'static-registry' | 'user-supplied' | 'local-discovery';
  eventAdapter: 'langchain-agent-events' | 'claude-sdk-messages';
  credentialRequirement: string | null;
  fixtureCapabilities: {
    xSearch: boolean;
    durableMemory: boolean;
    generalSkillTool: boolean;
  };
}

export type EvalEvent =
  | { type: 'skill_discovered'; name: string }
  | { type: 'tool_call'; id: string; name: string; args: Readonly<Record<string, unknown>> }
  | { type: 'approval_requested'; operation: NormalizedOperation }
  | { type: 'tool_result'; id: string; name: string; status: 'success' | 'error' | 'denied'; output?: unknown }
  | { type: 'final_response'; text: string };

export type CanonicalFixtureEvent =
  | Extract<EvalEvent, { type: 'tool_call' }>
  | Extract<EvalEvent, { type: 'approval_requested' }>
  | Extract<EvalEvent, { type: 'tool_result' }>
  | Extract<EvalEvent, { type: 'final_response' }>;

export type LangChainFixtureFrame =
  | {
      type: 'ai_message';
      toolCalls: Array<{ id: string; name: string; args: Readonly<Record<string, unknown>> }>;
    }
  | { type: 'approval'; operation: NormalizedOperation }
  | { type: 'tool_message'; id: string; name: string; status: 'success' | 'error' | 'denied'; output?: unknown }
  | { type: 'done'; answer: string };

export type ClaudeSdkFixtureFrame =
  | {
      type: 'assistant';
      content: Array<{
        type: 'tool_use';
        id: string;
        name: string;
        input: Readonly<Record<string, unknown>>;
      }>;
    }
  | { type: 'permission'; operation: NormalizedOperation }
  | { type: 'mcp_result'; id: string; name: string; status: 'success' | 'error' | 'denied'; output?: unknown }
  | { type: 'result'; result: string };

export type RecordedFixture =
  | { runtime: 'langchain'; frames: LangChainFixtureFrame[] }
  | { runtime: 'claude-agent-sdk'; frames: ClaudeSdkFixtureFrame[] };

export type EvalScenario =
  | { kind: 'route'; route: 'dcf' | 'x' | 'memo' | 'memory' | 'none'; xAvailable?: boolean }
  | { kind: 'dcf'; variant: 'valid' | 'equal-rates' | 'lower-wacc' | 'negative-fcf' | 'net-cash' | 'sensitivity' }
  | {
      kind: 'approval';
      variant:
        | 'read'
        | 'local-mutation'
        | 'external-mutation'
        | 'destructive-mutation'
        | 'same-tool-different-action'
        | 'changed-target'
        | 'changed-args'
        | 'retry-identical'
        | 'retry-changed'
        | 'unknown-operation';
    }
  | {
      kind: 'privacy';
      variant: 'conversation' | 'scratchpad' | 'tool-result' | 'compaction' | 'explicit-memory' | 'memo' | 'restart';
    }
  | {
      kind: 'memo';
      variant: 'japanese' | 'english' | 'mixed' | 'special' | 'duplicate' | 'changed-content' | 'changed-destination' | 'memory-isolation';
    };

export interface EvalCase {
  id: string;
  suite: EvalSuite;
  layer: Exclude<EvalLayer, 1>;
  userInput: string;
  scenario: EvalScenario;
  applicableRuntimes?: readonly EvalRuntime[];
}

export interface EvalFacts {
  discoverableSkills: string[];
  expectedDiscoverableSkills: string[];
  argsValid: boolean;
  exactOperationBound: boolean;
  memoryMutation: boolean;
  memoCreated: boolean;
  reasoningExposed: boolean;
  credentialExposed: boolean;
  deterministicActual?: string;
  deterministicExpected?: string;
  numericActual?: number;
  numericExpected?: number;
  numericTolerance?: number;
}

export interface EvalExpectation {
  categories: ScoreCategory[];
  skills: string[];
  toolCalls: Record<string, number>;
  forbiddenTools: string[];
  approvalCount?: number;
  approvalRisks?: OperationRisk[];
  resultStatuses?: Record<string, Array<'success' | 'error' | 'denied'>>;
  finalMarkers?: string[];
  memoryMutation?: boolean;
  memoCreated?: boolean;
  exactOperationBound?: boolean;
  argsValid?: boolean;
  requireNumericMatch?: boolean;
  requireDeterministicMatch?: boolean;
}

export interface MaterializedEvalCase {
  definition: EvalCase;
  fixture: RecordedFixture;
  expected: EvalExpectation;
  facts: EvalFacts;
}

export type CriticalFailureKind =
  | 'approval_bypass'
  | 'destructive_without_approval'
  | 'scratchpad_persisted'
  | 'hidden_reasoning_persisted'
  | 'memo_promoted_to_memory'
  | 'target_substitution'
  | 'credential_exposure'
  | 'dcf_calculator_bypass';

export interface CriticalFailure {
  configurationId: string;
  caseId: string;
  kind: CriticalFailureKind;
  message: string;
}

export interface AssertionResult {
  category: ScoreCategory;
  passed: boolean;
  message: string;
}

export interface CaseResult {
  id: string;
  suite: EvalSuite;
  layer: Exclude<EvalLayer, 1>;
  passed: boolean;
  skipped: boolean;
  assertions: AssertionResult[];
  criticalFailures: CriticalFailure[];
}

export interface CategoryScore {
  passed: number;
  total: number;
  rate: number;
}

export interface ConfigurationResult {
  configuration: EvalConfiguration;
  result: 'PASS' | 'FAIL';
  testCount: number;
  passed: number;
  failed: number;
  skipped: number;
  scores: Record<ScoreCategory, CategoryScore>;
  criticalFailures: CriticalFailure[];
  cases: CaseResult[];
}

export interface BaselineCaseResult {
  id: string;
  suite: EvalSuite;
  passed: boolean;
  message: string;
}

export interface ArchitectureBaselineResult {
  result: 'PASS' | 'FAIL';
  excludedFromCrossModelScores: true;
  testCount: number;
  passed: number;
  failed: number;
  cases: BaselineCaseResult[];
}

export interface BehavioralEvalReport {
  schemaVersion: 1;
  suiteVersion: typeof BEHAVIORAL_EVAL_SUITE_VERSION;
  result: 'PASS' | 'FAIL';
  mode: EvalMode;
  gitSha: string | null;
  relevantConfig: {
    liveCalls: false;
    llmJudge: false;
    fixturesContainHiddenReasoning: false;
    xCapability: 'scripted-only';
  };
  baseline: ArchitectureBaselineResult;
  astraOffline: AstraOfflineReport;
  suites: Record<EvalSuite, { behavioralCases: number; baselineCases: number }>;
  configurations: ConfigurationResult[];
  criticalFailures: CriticalFailure[];
  crossRuntimeDifferences: string[];
}