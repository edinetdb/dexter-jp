import { describe, expect, test } from 'bun:test';
import { Scratchpad } from './scratchpad.js';

describe('scratchpad privacy boundary', () => {
  test('a new run cannot restore tool output, thinking, or a compaction summary', () => {
    const firstRun = new Scratchpad('same query');
    firstRun.addThinking('private intermediate reasoning');
    firstRun.addToolResult('web_search', { query: 'candidate' }, 'intermediate tool output');
    firstRun.setCompactionSummary('transient compacted context');

    expect(firstRun.getToolCallRecords()).toHaveLength(1);
    expect(firstRun.getToolResults()).toContain('transient compacted context');

    const restartedRun = new Scratchpad('same query');
    expect(restartedRun.hasToolResults()).toBe(false);
    expect(restartedRun.getToolCallRecords()).toEqual([]);
    expect(restartedRun.getToolResults()).toBe('');
  });
});