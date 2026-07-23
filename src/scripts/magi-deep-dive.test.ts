import { describe, test, expect } from 'bun:test';
import { buildPrompt, voteLabel } from './magi-deep-dive.js';

describe('voteLabel', () => {
  test('maps true/false/null to Japanese labels', () => {
    expect(voteLabel(true)).toBe('賛成');
    expect(voteLabel(false)).toBe('反対');
    expect(voteLabel(null)).toBe('判定不能');
  });
});

describe('buildPrompt', () => {
  test('includes ticker, name, result, votes, and financial text', () => {
    const prompt = buildPrompt({
      code: '7203',
      name: 'トヨタ',
      result: '本命候補 (満場一致 3/3)',
      fin_text: 'PER: 11.04倍\nPBR: 0.99倍',
      votes: [
        { name: 'バルタザール', vote: true, reason: 'PER<10, PBR<1' },
        { name: 'メルキオール', vote: false, reason: 'リスクあり' },
      ],
    });

    expect(prompt).toContain('7203（トヨタ）');
    expect(prompt).toContain('本命候補 (満場一致 3/3)');
    expect(prompt).toContain('バルタザール: 賛成 — PER<10, PBR<1');
    expect(prompt).toContain('メルキオール: 反対 — リスクあり');
    expect(prompt).toContain('PER: 11.04倍');
  });

  test('falls back to the code alone when name is missing', () => {
    const prompt = buildPrompt({
      code: '9999',
      result: '本命候補 (条件付き 2/3)',
      fin_text: '',
      votes: [],
    });

    expect(prompt).toContain('9999');
    expect(prompt).not.toContain('9999（');
    expect(prompt).toContain('(なし)');
  });
});
