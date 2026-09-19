import { BEHAVIORAL_EVAL_CASES } from './cases.js';
import { evaluateMaterializedCase } from './evaluate.js';
import { getBehavioralEvalConfigurations } from './matrix.js';
import { materializeEvalCase } from './materialize.js';
import { runArchitectureBaseline } from './baseline.js';
import {
  BEHAVIORAL_EVAL_SUITE_VERSION,
  type BehavioralEvalReport,
  type CaseResult,
  type CategoryScore,
  type ConfigurationResult,
  type EvalConfiguration,
  type EvalCase,
  type EvalSuite,
  type ScoreCategory,
} from './types.js';

const SCORE_CATEGORIES: ScoreCategory[] = [
  'routing',
  'tools',
  'approval',
  'privacy',
  'deterministic-output',
];

const SUITES: EvalSuite[] = [
  'skill-activation',
  'dcf',
  'approval',
  'privacy',
  'memo',
  'adversarial-routing',
];

function gitSha(): string | null {
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) return null;
    const value = new TextDecoder().decode(result.stdout).trim();
    return /^[0-9a-f]{40}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

function scoreCases(cases: CaseResult[]): Record<ScoreCategory, CategoryScore> {
  return Object.fromEntries(SCORE_CATEGORIES.map((category) => {
    const assertions = cases.flatMap((result) =>
      result.assertions.filter((item) => item.category === category)
    );
    const passed = assertions.filter((item) => item.passed).length;
    return [category, {
      passed,
      total: assertions.length,
      rate: assertions.length === 0 ? 1 : passed / assertions.length,
    }];
  })) as Record<ScoreCategory, CategoryScore>;
}

function skippedCase(definition: EvalCase): CaseResult {
  return {
    id: definition.id,
    suite: definition.suite,
    layer: definition.layer,
    passed: true,
    skipped: true,
    assertions: [],
    criticalFailures: [],
  };
}

async function evaluateConfiguration(
  configuration: EvalConfiguration,
  cases: readonly EvalCase[],
): Promise<ConfigurationResult> {
  const results: CaseResult[] = [];
  for (const definition of cases) {
    if (definition.applicableRuntimes && !definition.applicableRuntimes.includes(configuration.runtime)) {
      results.push(skippedCase(definition));
      continue;
    }
    const materialized = await materializeEvalCase(definition, configuration);
    results.push(evaluateMaterializedCase(configuration, materialized));
  }

  const executed = results.filter((result) => !result.skipped);
  const criticalFailures = executed.flatMap((result) => result.criticalFailures);
  const passed = executed.filter((result) => result.passed).length;
  const failed = executed.length - passed;
  return {
    configuration,
    result: failed === 0 && criticalFailures.length === 0 ? 'PASS' : 'FAIL',
    testCount: executed.length,
    passed,
    failed,
    skipped: results.length - executed.length,
    scores: scoreCases(executed),
    criticalFailures,
    cases: results,
  };
}

export interface BehavioralEvalOptions {
  configurations?: readonly EvalConfiguration[];
  cases?: readonly EvalCase[];
}

export async function runBehavioralEval(
  options: BehavioralEvalOptions = {},
): Promise<BehavioralEvalReport> {
  const cases = options.cases ?? BEHAVIORAL_EVAL_CASES;
  const configurations = options.configurations ?? getBehavioralEvalConfigurations();
  const baseline = await runArchitectureBaseline();
  const results: ConfigurationResult[] = [];
  for (const configuration of configurations) {
    results.push(await evaluateConfiguration(configuration, cases));
  }
  const criticalFailures = results.flatMap((result) => result.criticalFailures);

  const suites = Object.fromEntries(SUITES.map((suite) => [suite, {
    behavioralCases: cases.filter((definition) => definition.suite === suite).length,
    baselineCases: baseline.cases.filter((definition) => definition.suite === suite).length,
  }])) as BehavioralEvalReport['suites'];

  return {
    schemaVersion: 1,
    suiteVersion: BEHAVIORAL_EVAL_SUITE_VERSION,
    result: baseline.result === 'PASS'
      && results.every((result) => result.result === 'PASS')
      && criticalFailures.length === 0
      ? 'PASS'
      : 'FAIL',
    mode: 'offline-fixture',
    gitSha: gitSha(),
    relevantConfig: {
      liveCalls: false,
      llmJudge: false,
      fixturesContainHiddenReasoning: false,
      xCapability: 'scripted-only',
    },
    baseline,
    suites,
    configurations: results,
    criticalFailures,
    crossRuntimeDifferences: [
      'LangChain receives provider-normalized AIMessage.tool_calls; Claude Agent SDK uses namespaced SDK tool_use/MCP records before EvalEvent normalization.',
      'Claude Agent SDK exposes calculate_dcf directly and does not expose the general Skill meta-tool; explicit memo turns are the exception and expose skill plus write_memo.',
      'The offline SDK profile has no x_search or durable-memory tools; those requests must remain unavailable rather than silently substitute another capability.',
      'LangChain owns Dexter compaction and durable-memory integration; SDK mode keeps those facilities outside its tool/prompt surface.',
    ],
  };
}

function fraction(score: CategoryScore): string {
  return `${score.passed}/${score.total}`;
}

export function renderHumanReport(report: BehavioralEvalReport): string {
  const lines = [
    `Phase 7 offline behavioral evaluation: ${report.result}`,
    `Suite: ${report.suiteVersion}  Mode: ${report.mode}  Git: ${report.gitSha ?? 'unavailable'}`,
    `Architecture baseline (excluded from cross-model scores): ${report.baseline.passed}/${report.baseline.testCount}`,
    `Critical failures: ${report.criticalFailures.length}`,
    '',
    'Suites:',
    ...SUITES.map((suite) =>
      `- ${suite}: behavioral ${report.suites[suite].behavioralCases}, baseline ${report.suites[suite].baselineCases}`
    ),
    '',
    'Configurations:',
  ];

  for (const result of report.configurations) {
    const model = result.configuration.modelIdentifier ?? `[${result.configuration.modelSelection}]`;
    lines.push(
      `- ${result.result} ${result.configuration.runtime}/${result.configuration.provider}/${model}`
      + ` | routing ${fraction(result.scores.routing)}`
      + ` | tools ${fraction(result.scores.tools)}`
      + ` | approval ${fraction(result.scores.approval)}`
      + ` | privacy ${fraction(result.scores.privacy)}`
      + ` | deterministic ${fraction(result.scores['deterministic-output'])}`
      + ` | skipped ${result.skipped}`,
    );
  }

  const failedBaseline = report.baseline.cases.filter((item) => !item.passed);
  const failedCases = report.configurations.flatMap((configuration) =>
    configuration.cases
      .filter((item) => !item.skipped && !item.passed)
      .map((item) => `${configuration.configuration.id}:${item.id}`)
  );
  if (failedBaseline.length || failedCases.length) {
    lines.push('', 'Failures:');
    for (const item of failedBaseline) lines.push(`- baseline:${item.id}: ${item.message}`);
    for (const item of failedCases) lines.push(`- ${item}`);
  }

  return lines.join('\n');
}