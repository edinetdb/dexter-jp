import type { MemoDocument } from '../../memo/document.js';
import type { CalculateDcfInput } from '../../tools/finance/calculate-dcf.js';
import type {
  ApprovalDecision,
  NormalizedOperation,
  OperationRisk,
} from '../../approval/operation-policy.js';

export const PRACTICAL_ACCEPTANCE_SUITE_VERSION = 'phase8-v1' as const;
export const ACCEPTANCE_FIXED_DATE = '2026-01-15' as const;

export type AcceptanceCategory =
  | 'dcf'
  | 'research-x'
  | 'memo'
  | 'memory'
  | 'approval'
  | 'privacy'
  | 'adversarial';

export type FindingClassification =
  | 'TEST HARNESS BUG'
  | 'EXPECTATION BUG'
  | 'PRODUCT BUG'
  | 'PRODUCT GAP'
  | 'DOCUMENTED LIMITATION';

export type CriticalSafetyKind =
  | 'approval_bypass'
  | 'destructive_without_approval'
  | 'target_substitution'
  | 'argument_mutation'
  | 'hidden_reasoning_persisted'
  | 'scratchpad_persisted'
  | 'memo_promoted_to_memory'
  | 'memory_promoted_to_memo'
  | 'dcf_calculator_bypass'
  | 'silent_memo_overwrite';

export type CriticalCheck =
  | 'approval-bound'
  | 'destructive-blocked'
  | 'target-substitution-rejected'
  | 'argument-mutation-rejected'
  | 'transient-not-durable'
  | 'reasoning-not-exposed'
  | 'memo-memory-separated'
  | 'memory-memo-separated'
  | 'dcf-calculator-used'
  | 'duplicate-preserved';

export type AcceptanceAction =
  | { kind: 'none'; marker?: string }
  | { kind: 'dcf'; input: CalculateDcfInput }
  | { kind: 'x-research'; query: string }
  | { kind: 'memo'; document: MemoDocument }
  | { kind: 'memory-append'; content: string }
  | { kind: 'read-file'; path: string }
  | { kind: 'edit-file'; path: string; oldText: string; newText: string }
  | { kind: 'destructive-denied'; jobId: string }
  | {
      kind: 'target-substitution';
      approvedPath: string;
      candidatePath: string;
      oldText: string;
      newText: string;
    }
  | {
      kind: 'argument-mutation';
      path: string;
      approvedContent: string;
      candidateContent: string;
    }
  | { kind: 'exact-retry'; path: string; content: string }
  | { kind: 'tool-heavy'; count: number }
  | { kind: 'compaction' }
  | { kind: 'restart' };

export interface ApprovalFixture {
  decision: ApprovalDecision;
}

export interface TurnExpectation {
  exposedToolsInclude?: string[];
  exposedToolsExclude?: string[];
  discoveredSkillsExclude?: string[];
  skills: string[];
  calledTools: string[];
  forbiddenTools?: string[];
  approval?: {
    count: number;
    risks?: OperationRisk[];
    decisions?: ApprovalDecision[];
  };
  finalMarkers: string[];
  forbiddenFinalMarkers?: string[];
}

export interface AcceptanceTurn {
  input: string;
  action: AcceptanceAction;
  approval?: ApprovalFixture;
  expected: TurnExpectation;
}

export interface FileDiffExpectation {
  created: string[];
  modified: string[];
  deleted: string[];
  unchanged?: string[];
}

export interface AcceptanceScenario {
  id: string;
  category: AcceptanceCategory;
  description: string;
  initialFiles?: Record<string, string>;
  turns: AcceptanceTurn[];
  expectedOutcome: {
    files: FileDiffExpectation;
    memoryChanged: boolean;
    memoChanged: boolean;
    criticalChecks: CriticalCheck[];
  };
  failureClassification?: Exclude<FindingClassification, 'TEST HARNESS BUG'>;
}

export type AcceptanceEvent =
  | { type: 'tools_exposed'; turn: number; names: string[] }
  | { type: 'skills_discovered'; turn: number; names: string[] }
  | { type: 'skill_invoked'; turn: number; name: string }
  | {
      type: 'tool_call';
      turn: number;
      name: string;
      args: Readonly<Record<string, unknown>>;
      operation: NormalizedOperation;
    }
  | {
      type: 'approval_requested';
      turn: number;
      operation: NormalizedOperation;
    }
  | {
      type: 'approval_outcome';
      turn: number;
      operation: NormalizedOperation;
      decision: ApprovalDecision;
      prompted: boolean;
    }
  | {
      type: 'tool_result';
      turn: number;
      name: string;
      status: 'success' | 'error' | 'denied';
      operation: NormalizedOperation;
      outputSummary?: Readonly<Record<string, unknown>>;
    }
  | {
      type: 'state_transition';
      turn: number;
      state: 'compacted-conversation' | 'runtime-restart';
      details: Readonly<Record<string, unknown>>;
    }
  | { type: 'final_response'; turn: number; text: string };

export interface FileManifestEntry {
  bytes: number;
  sha256: string;
}

export interface FileManifest {
  [path: string]: FileManifestEntry;
}

export interface FileDiff {
  created: string[];
  modified: string[];
  deleted: string[];
}

export interface AcceptanceFacts {
  fileDiff: FileDiff;
  memoryChanged: boolean;
  memoChanged: boolean;
  durableContainsTransientSentinel: boolean;
  durableContainsReasoningSentinel: boolean;
  memoContainsTransientSentinel: boolean;
  substitutionRejected: boolean;
  argumentMutationRejected: boolean;
  destructiveExecuted: boolean;
  duplicateOriginalPreserved: boolean;
  restartRestoredDurableMemory: boolean;
  restartRestoredScratchpad: boolean;
  compactionPreservedContext: boolean;
  compactionExposedReasoning: boolean;
  calculatorValues: number[];
  finalCalculatorValues: number[];
}

export interface AcceptanceExecution {
  scenario: AcceptanceScenario;
  events: AcceptanceEvent[];
  before: FileManifest;
  after: FileManifest;
  facts: AcceptanceFacts;
}

export interface AcceptanceAssertion {
  passed: boolean;
  message: string;
  criticalKind?: CriticalSafetyKind;
}

export interface AcceptanceCaseResult {
  id: string;
  category: AcceptanceCategory;
  passed: boolean;
  turns: number;
  assertions: AcceptanceAssertion[];
  criticalFailures: CriticalSafetyKind[];
  fileDiff: FileDiff;
  memoryChanged: boolean;
  memoChanged: boolean;
}

export interface AcceptanceFailureDiagnostic {
  scenarioId: string;
  classification: FindingClassification;
  failedAssertions: AcceptanceAssertion[];
  normalizedObservableEvents: AcceptanceEvent[];
  expected: unknown;
  actual: unknown;
}

export interface AcceptanceFinding {
  scenarioId: string;
  classification: FindingClassification;
  summary: string;
}

export interface AcceptanceReport {
  schemaVersion: 1;
  suiteVersion: typeof PRACTICAL_ACCEPTANCE_SUITE_VERSION;
  mode: 'offline-scripted-workflow';
  result: 'PASS' | 'FAIL';
  scenarioCount: number;
  turnCount: number;
  multiTurnScenarioCount: number;
  passed: number;
  failed: number;
  criticalFailures: Array<{ scenarioId: string; kind: CriticalSafetyKind }>;
  cases: AcceptanceCaseResult[];
  findings: AcceptanceFinding[];
  failureDiagnostics: AcceptanceFailureDiagnostic[];
  evidence: {
    liveCalls: false;
    xCapability: 'observable-stub';
    phase7Mode: 'offline-fixture';
    phase8Mode: 'offline-scripted-workflow';
    fixturesContainHiddenReasoning: false;
  };
}