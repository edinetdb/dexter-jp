import { describe, expect, test } from 'bun:test';
import { hasRemainingIterationBudget } from './iteration-budget.js';

describe('agent hard iteration budget', () => {
  test('remains enforced at the configured maximum', () => {
    expect(hasRemainingIterationBudget(3, 4)).toBe(true);
    expect(hasRemainingIterationBudget(4, 4)).toBe(false);
    expect(hasRemainingIterationBudget(5, 4)).toBe(false);
  });
});
