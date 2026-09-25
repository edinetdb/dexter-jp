import { describe, expect, test } from 'bun:test';
import { estimateJudgeCost } from './estimate.js';

describe('estimateJudgeCost', () => {
  test('returns a single line combining paragraph and claim counts', () => {
    const line = estimateJudgeCost(132, 3);
    expect(line.split('\n').length).toBe(1);
    expect(line).toContain('132');
    expect(line).toContain('3');
    expect(line).toContain('396'); // 132 * 3
  });

  test('handles zero gracefully', () => {
    expect(estimateJudgeCost(0, 0)).toContain('0');
  });
});
