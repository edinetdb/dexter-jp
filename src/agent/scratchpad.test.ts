import { describe, expect, test } from 'bun:test';
import { Scratchpad } from './scratchpad.js';

describe('scratchpad privacy boundary', () => {
  test('a new run cannot restore tool output, thinking, or a compaction summary', () => {
    const firstRun = new Scratchpad('same query');
    firstRun.addThinking('private intermediate reasoning');
    firstRun.addToolResult('web_search', { query: 'candidate' }, 'intermediate tool output');
    firstRun.recordActiveSkill('dcf-valuation', 'Use deterministic calculator only.');
    firstRun.setCompactionSummary('transient compacted context');

    expect(firstRun.getToolCallRecords()).toHaveLength(1);
    expect(firstRun.getToolResults()).toContain('transient compacted context');

    const restartedRun = new Scratchpad('same query');
    expect(restartedRun.hasToolResults()).toBe(false);
    expect(restartedRun.getToolCallRecords()).toEqual([]);
    expect(restartedRun.getToolResults()).toBe('');
    expect(restartedRun.getActiveSkillContracts()).toEqual([]);
  });
});

describe('active Skill compaction recovery', () => {
  test('keeps Skill details in run-local structured state across full compaction', () => {
    const scratchpad = new Scratchpad('value the company');
    scratchpad.addToolResult(
      'skill',
      { skill: 'dcf-valuation' },
      '## Skill: dcf-valuation\n\nUse calculate_dcf with sourced inputs.',
    );
    scratchpad.recordActiveSkill(
      'dcf-valuation',
      '## Skill: dcf-valuation\n\nUse calculate_dcf with sourced inputs.',
    );
    scratchpad.setCompactionSummary('Verified revenue inputs; DCF remains pending.');

    expect(scratchpad.getActiveSkillContracts()).toEqual([{
      name: 'dcf-valuation',
      instructions: '## Skill: dcf-valuation\n\nUse calculate_dcf with sourced inputs.',
    }]);
    expect(scratchpad.formatActiveSkillContractsForPrompt())
      .toContain('Use calculate_dcf with sourced inputs.');
  });

  test('does not send Skill instructions to the compaction summarizer', () => {
    const scratchpad = new Scratchpad('research');
    scratchpad.addToolResult(
      'skill',
      { skill: 'x-research' },
      'private run-local Skill contract',
    );
    scratchpad.addToolResult(
      'web_search',
      { query: 'company results' },
      'verified public evidence',
    );

    expect(scratchpad.getCompactionEvidence()).toContain('verified public evidence');
    expect(scratchpad.getCompactionEvidence()).not.toContain('private run-local Skill contract');
  });

  test('Skill dedup remains active after compaction', () => {
    const scratchpad = new Scratchpad('research');
    scratchpad.addToolResult('skill', { skill: 'x-research' }, 'instructions');
    scratchpad.recordActiveSkill('x-research', 'instructions');
    scratchpad.setCompactionSummary('summary');

    expect(scratchpad.hasExecutedSkill('x-research')).toBe(true);
    expect(scratchpad.hasExecutedSkill('other-skill')).toBe(false);
  });
});

describe('tool progress detection', () => {
  test('four distinct successful retrievals do not trigger a loop warning', () => {
    const scratchpad = new Scratchpad('compare companies');
    for (let index = 1; index <= 4; index += 1) {
      scratchpad.recordToolOutcome(
        'web_search',
        { query: `company-${index}` },
        `result-${index}`,
        false,
      );
      expect(scratchpad.formatToolProgressWarningForPrompt()).toBeNull();
    }
  });

  test('repeated identical failure triggers one warning', () => {
    const scratchpad = new Scratchpad('research');
    const args = { query: 'same target' };
    scratchpad.recordToolOutcome('web_search', args, 'Error: timeout', true);
    expect(scratchpad.formatToolProgressWarningForPrompt()).toBeNull();

    scratchpad.recordToolOutcome('web_search', args, 'Error: timeout', true);
    expect(scratchpad.formatToolProgressWarningForPrompt()).toContain('same failure');
    expect(scratchpad.formatToolProgressWarningForPrompt()).toBeNull();
  });

  test('same query with unchanged successful result triggers a warning', () => {
    const scratchpad = new Scratchpad('research');
    const args = { query: 'same target', page: 1 };
    scratchpad.recordToolOutcome('web_search', args, 'unchanged result', false);
    scratchpad.recordToolOutcome('web_search', { page: 1, query: 'same target' }, 'unchanged result', false);

    expect(scratchpad.formatToolProgressWarningForPrompt()).toContain('unchanged result');
  });
});
