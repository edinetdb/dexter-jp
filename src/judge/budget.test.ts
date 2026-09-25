import { describe, expect, test } from 'bun:test';
import { BudgetTracker } from './budget.js';

describe('BudgetTracker', () => {
  test('reserves requests up to maxRequests, then refuses', () => {
    const b = new BudgetTracker({ maxRequests: 2, maxInputTokens: 1_000_000, maxWallClockMs: 1_000_000 });
    expect(b.tryReserveRequest()).toBe(true);
    expect(b.tryReserveRequest()).toBe(true);
    expect(b.tryReserveRequest()).toBe(false);
    expect(b.usage().requestCount).toBe(2);
    expect(b.isExhausted()).toBe(true);
  });

  test('becomes exhausted once input tokens reach the cap', () => {
    const b = new BudgetTracker({ maxRequests: 1000, maxInputTokens: 100, maxWallClockMs: 1_000_000 });
    expect(b.isExhausted()).toBe(false);
    b.addInputTokens(60);
    expect(b.isExhausted()).toBe(false);
    b.addInputTokens(60);
    expect(b.isExhausted()).toBe(true);
    // once exhausted, no further requests can be reserved
    expect(b.tryReserveRequest()).toBe(false);
  });

  test('becomes exhausted once the injected clock passes maxWallClockMs', () => {
    let t = 0;
    const b = new BudgetTracker({ maxRequests: 1000, maxInputTokens: 1_000_000, maxWallClockMs: 1000, now: () => t });
    expect(b.isExhausted()).toBe(false);
    t = 1500;
    expect(b.isExhausted()).toBe(true);
    expect(b.tryReserveRequest()).toBe(false);
  });

  test('ignores non-positive token additions', () => {
    const b = new BudgetTracker({ maxRequests: 10, maxInputTokens: 100, maxWallClockMs: 1_000_000 });
    b.addInputTokens(-5);
    b.addInputTokens(0);
    expect(b.usage().inputTokens).toBe(0);
  });
});
