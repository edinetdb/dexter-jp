import { describe, expect, test } from 'bun:test';
import { judgeQuestionHash } from './hash.js';

describe('judgeQuestionHash', () => {
  test('is stable regardless of criteria key order', () => {
    const h1 = judgeQuestionHash({
      state: 's',
      instructions: 'i',
      criteria: { a: '1', b: '2' },
      model: 'jev-latest',
    });
    const h2 = judgeQuestionHash({
      state: 's',
      instructions: 'i',
      criteria: { b: '2', a: '1' },
      model: 'jev-latest',
    });
    expect(h1).toBe(h2);
  });

  test('changes when state changes', () => {
    const base = { state: 's1', instructions: 'i', criteria: ['a', 'b'], model: 'jev-latest' };
    const h1 = judgeQuestionHash(base);
    const h2 = judgeQuestionHash({ ...base, state: 's2' });
    expect(h1).not.toBe(h2);
  });

  test('changes when instructions change', () => {
    const base = { state: 's', instructions: 'i1', criteria: ['a'], model: 'jev-latest' };
    const h1 = judgeQuestionHash(base);
    const h2 = judgeQuestionHash({ ...base, instructions: 'i2' });
    expect(h1).not.toBe(h2);
  });

  test('changes when criteria change', () => {
    const base = { state: 's', instructions: 'i', criteria: { a: '1' }, model: 'jev-latest' };
    const h1 = judgeQuestionHash(base);
    const h2 = judgeQuestionHash({ ...base, criteria: { a: '2' } });
    expect(h1).not.toBe(h2);
  });

  test('changes when model changes', () => {
    const base = { state: 's', instructions: 'i', criteria: ['a'], model: 'jev-latest' };
    const h1 = judgeQuestionHash(base);
    const h2 = judgeQuestionHash({ ...base, model: 'jev-2' });
    expect(h1).not.toBe(h2);
  });

  test('produces a hex sha256 digest', () => {
    const h = judgeQuestionHash({ state: 's', instructions: 'i', criteria: ['a'], model: 'jev-latest' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
