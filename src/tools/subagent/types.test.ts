import { describe, expect, test } from 'bun:test';
import { SPAWN_SUBAGENT_DESCRIPTION } from './spawn-subagent.js';
import {
  SUBAGENT_TYPES,
  hasExplicitXResearchIntent,
  resolveSubagentTools,
} from './types.js';

describe('worker contract propagation', () => {
  test('worker receives the minimal shared contract', () => {
    const prompt = SUBAGENT_TYPES.research.systemPrompt;

    expect(prompt).toContain('Never invent missing values');
    expect(prompt).toContain('only when the assigned task explicitly requests it');
    expect(prompt).toContain('Complete every requested deliverable');
    expect(prompt).toContain('Respect approval and safety boundaries');
    expect(prompt).toContain('required capability is unavailable');
  });

  test('research worker does not receive X search without explicit X intent', () => {
    expect(resolveSubagentTools('research', '競合4社の最新情報を調査して'))
      .not.toContain('x_search');
    expect(hasExplicitXResearchIntent('Solve for variable x in this formula')).toBe(false);
  });

  test('explicit X request retains X search capability', () => {
    expect(resolveSubagentTools('research', 'Xでこの会社への反応を調査して'))
      .toContain('x_search');
    expect(resolveSubagentTools('research', 'Search Twitter posts about the launch'))
      .toContain('x_search');
    expect(resolveSubagentTools('research', 'Search X posts about the launch'))
      .toContain('x_search');
  });

  test('explicit DCF work keeps deterministic calculation with the orchestrator', () => {
    const prompt = SUBAGENT_TYPES.analysis.systemPrompt;

    expect(prompt).toContain('orchestrator owns deterministic DCF calculation through calculate_dcf');
    expect(resolveSubagentTools('analysis', 'DCF valuation inputsを収集して'))
      .not.toContain('calculate_dcf');
    expect(SPAWN_SUBAGENT_DESCRIPTION)
      .toContain('run the deterministic `calculate_dcf` tool yourself');
  });

  test('worker must report missing DCF inputs instead of fabricating them', () => {
    const prompt = SUBAGENT_TYPES.analysis.systemPrompt;

    expect(prompt).toContain('report missing inputs');
    expect(prompt).toContain('do not calculate a substitute DCF or fabricate inputs');
  });
});
