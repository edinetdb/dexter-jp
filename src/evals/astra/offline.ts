import { rebuildMessagesAfterCompaction } from '../../agent/compact.js';
import { buildSystemPrompt } from '../../agent/prompts.js';
import { Scratchpad } from '../../agent/scratchpad.js';
import { ASTRA_MODEL_ID } from '../../model/openai-runtime.js';
import { BEHAVIORAL_EVAL_CASES } from '../behavioral/cases.js';
import { evaluateMaterializedCase } from '../behavioral/evaluate.js';
import { getBehavioralEvalConfigurations } from '../behavioral/matrix.js';
import { materializeEvalCase } from '../behavioral/materialize.js';
import type { AstraOfflineCaseResult, AstraOfflineReport } from './types.js';

function check(condition: unknown, evidence: string): asserts condition {
  if (!condition) throw new Error(evidence);
}

async function runCase(
  id: string,
  run: () => void | Promise<void>,
): Promise<AstraOfflineCaseResult> {
  try {
    await run();
    return { id, passed: true, evidence: 'contract preserved' };
  } catch (error) {
    return {
      id,
      passed: false,
      evidence: error instanceof Error ? error.message : String(error),
    };
  }
}

function astraPrompt(): string {
  return buildSystemPrompt(
    ASTRA_MODEL_ID,
    null,
    'cli',
    undefined,
    [],
    null,
    null,
    new Set(['skill', 'calculate_dcf', 'x_search', 'memory_update', 'write_memo']),
    true,
    'Run the assigned task.',
  );
}

async function checkBehavioralCases(ids: readonly string[]): Promise<void> {
  const configuration = getBehavioralEvalConfigurations().find(
    (item) => item.modelIdentifier === ASTRA_MODEL_ID,
  );
  check(configuration, 'Astra is missing from the provider-neutral eval matrix.');

  for (const id of ids) {
    const definition = BEHAVIORAL_EVAL_CASES.find((item) => item.id === id);
    check(definition, 'Missing behavioral fixture: ' + id);
    const materialized = await materializeEvalCase(definition, configuration);
    const result = evaluateMaterializedCase(configuration, materialized);
    check(result.passed, 'Behavioral fixture failed: ' + id);
  }
}

export async function runAstraOfflineCompatibility(): Promise<AstraOfflineReport> {
  const cases = await Promise.all([
    runCase('astra.multi-part-completion', () => {
      const prompt = astraPrompt();
      check(
        prompt.includes('Complete every requested deliverable and required validation')
        && prompt.includes('do not stop after a partial result'),
        'Completion contract is missing from the Astra prompt path.',
      );
    }),
    runCase('astra.missing-required-input', () => {
      const prompt = astraPrompt();
      check(prompt.includes('Never fabricate missing facts'), 'Fabrication guard is missing.');
      check(
        prompt.includes('Ask a concise clarification only when an input is required')
        && prompt.includes('completed work, the incomplete part, and the blocker'),
        'Required-input clarification/blocker contract is missing.',
      );
    }),
    runCase('astra.multiple-successful-retrievals', () => {
      const scratchpad = new Scratchpad('compare four companies');
      for (let index = 1; index <= 4; index += 1) {
        scratchpad.recordToolOutcome(
          'web_search',
          { query: 'company-' + index },
          'result-' + index,
          false,
        );
        check(
          scratchpad.formatToolProgressWarningForPrompt() === null,
          'Distinct successful retrievals triggered a false loop warning.',
        );
      }
    }),
    runCase('astra.no-progress-repeat', () => {
      const scratchpad = new Scratchpad('research one company');
      const args = { query: 'same target' };
      scratchpad.recordToolOutcome('web_search', args, 'unchanged', false);
      scratchpad.recordToolOutcome('web_search', args, 'unchanged', false);
      check(
        scratchpad.formatToolProgressWarningForPrompt()?.includes('unchanged result'),
        'Repeated no-progress operation did not trigger a warning.',
      );
    }),
    runCase('astra.compaction-skill-recovery', () => {
      const scratchpad = new Scratchpad('run a DCF');
      const instructions = 'Use calculate_dcf with sourced, period-labeled inputs.';
      scratchpad.addToolResult('skill', { skill: 'dcf-valuation' }, instructions);
      scratchpad.recordActiveSkill('dcf-valuation', instructions);
      scratchpad.setCompactionSummary('Inputs gathered; calculation remains pending.');

      const rebuilt = rebuildMessagesAfterCompaction(
        'base system contract',
        scratchpad.getToolResults(),
        'run a DCF',
        scratchpad.formatActiveSkillContractsForPrompt(),
      );
      check(rebuilt[0].content.toString().includes(instructions), 'Active Skill details were not restored.');
      check(scratchpad.hasExecutedSkill('dcf-valuation'), 'Skill dedup state was lost.');
      check(
        !scratchpad.getCompactionEvidence().includes(instructions),
        'Skill details leaked into generated compaction evidence.',
      );
    }),
    runCase('astra.explicit-dcf', () => checkBehavioralCases(['dcf.valid'])),
    runCase('astra.implicit-valuation', () =>
      checkBehavioralCases(['skill.dcf.implicit-negative', 'dcf.not-requested'])),
    runCase('astra.explicit-x-capability', () =>
      checkBehavioralCases(['skill.x.explicit', 'skill.unavailable-capability'])),
    runCase('astra.implicit-sentiment-no-x', () =>
      checkBehavioralCases(['skill.x.implicit-negative', 'adversarial.x-implicit'])),
    runCase('astra.memo-vs-memory', () =>
      checkBehavioralCases([
        'memo.japanese',
        'memo.memory-isolation',
        'skill.memory-vs-memo',
        'privacy.memo-is-not-memory',
      ])),
  ]);

  return {
    label: 'ASTRA OFFLINE COMPATIBILITY',
    result: cases.every((item) => item.passed) ? 'PASS' : 'FAIL',
    mode: 'offline-fixture',
    liveCalls: false,
    cases,
  };
}
