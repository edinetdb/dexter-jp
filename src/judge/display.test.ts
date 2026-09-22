import { describe, expect, test } from 'bun:test';
import {
  containsForbiddenDisplayWord,
  FORBIDDEN_DISPLAY_WORDS,
  JUDGE_DISPLAY_STRINGS,
  JUDGE_ESTIMATE_DISCLAIMER,
} from './display.js';

describe('judge display text (G-A6)', () => {
  test('the estimate disclaimer is the exact verbatim wording', () => {
    expect(JUDGE_ESTIMATE_DISCLAIMER).toBe('この段落と主張の関係についてのモデルの推定');
  });

  test('none of the judge display strings contain a forbidden word', () => {
    for (const s of JUDGE_DISPLAY_STRINGS) {
      expect(containsForbiddenDisplayWord(s)).toBeNull();
    }
  });

  test('★ containsForbiddenDisplayWord actually catches each forbidden word', () => {
    for (const word of FORBIDDEN_DISPLAY_WORDS) {
      expect(containsForbiddenDisplayWord(`テスト${word}テスト`)).toBe(word);
    }
  });

  test('forbidden words are exactly the three named in the design (正しい確率/支持率/的中)', () => {
    expect([...FORBIDDEN_DISPLAY_WORDS].sort()).toEqual(['支持率', '正しい確率', '的中'].sort());
  });
});
