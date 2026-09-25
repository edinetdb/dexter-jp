import { describe, expect, test } from 'bun:test';
import type { ChoiceAnswer, ChoiceQuestion, NoulAnswer, NoulQuestion, ScoreAnswer, ScoreQuestion } from './types.js';
import {
  validateAnswer,
  validateChoiceAnswer,
  validateDistribution,
  validateNoulAnswer,
  validateScoreAnswer,
} from './validate.js';

const stanceQuestion: ChoiceQuestion = {
  type: 'choice',
  instructions: '仮説に対して証拠はどの立場か',
  criteria: {
    supports: '裏付けている',
    contradicts: '食い違う',
    unrelated: '無関係',
  },
};

const importanceQuestion: ScoreQuestion = {
  type: 'score',
  instructions: '開示の重要度',
  criteria: ['経過報告', '軽微な決定', '業績に直結', '支配・存続に関わる'],
};

const guardQuestion: NoulQuestion = {
  type: 'noul',
  instructions: '売買助言を求めているか',
  criteria: { true: '助言を求めている', false: '求めていない' },
};

describe('validateDistribution', () => {
  test('accepts a well-formed distribution', () => {
    const r = validateDistribution({ a: 0.2, b: 0.8 }, ['a', 'b']);
    expect(r.error).toBeUndefined();
    expect(r.argmax).toBe('b');
    expect(r.normalized).toEqual({ a: 0.2, b: 0.8 });
  });

  test('rejects when keys do not match criteria (extra key)', () => {
    const r = validateDistribution({ a: 0.5, b: 0.5, c: 0.0 }, ['a', 'b']);
    expect(r.error?.code).toBe('invalid_distribution');
  });

  test('rejects when keys do not match criteria (missing key)', () => {
    const r = validateDistribution({ a: 1.0 }, ['a', 'b']);
    expect(r.error?.code).toBe('invalid_distribution');
  });

  test('rejects a negative value', () => {
    const r = validateDistribution({ a: -0.1, b: 1.1 }, ['a', 'b']);
    expect(r.error?.code).toBe('invalid_distribution');
  });

  test('rejects when the sum is not ~1', () => {
    const r = validateDistribution({ a: 0.3, b: 0.3 }, ['a', 'b']);
    expect(r.error?.code).toBe('invalid_distribution');
  });

  test('rejects a non-object', () => {
    const r = validateDistribution('not an object', ['a', 'b']);
    expect(r.error?.code).toBe('invalid_distribution');
  });

  test('tolerates small floating point drift in the sum', () => {
    const r = validateDistribution({ a: 0.3333, b: 0.3333, c: 0.3333 }, ['a', 'b', 'c']);
    expect(r.error).toBeUndefined();
  });
});

describe('validateChoiceAnswer', () => {
  const goodRaw = {
    type: 'choice',
    choice: 'supports',
    confidence: 0.99,
    probabilities: { supports: 0.99, contradicts: 0.01, unrelated: 0.0 },
  };

  test('accepts a consistent, well-formed answer', () => {
    const raw = validateChoiceAnswer(stanceQuestion, goodRaw);
    expect('error' in raw).toBe(false);
    if ('error' in raw) throw new Error('unreachable');
    const ans = raw as ChoiceAnswer;
    expect(ans.type).toBe('choice');
    expect(ans.backend).toBe('jev');
    expect(ans.choice).toBe('supports');
    expect(ans.probabilities).toEqual({ supports: 0.99, contradicts: 0.01, unrelated: 0.0 });
  });

  test('rejects a choice not in the declared criteria', () => {
    const ans = validateChoiceAnswer(stanceQuestion, { ...goodRaw, choice: 'irrelevant' });
    expect('error' in ans).toBe(true);
  });

  test('rejects confidence outside [0,1]', () => {
    const ans = validateChoiceAnswer(stanceQuestion, { ...goodRaw, confidence: 1.5 });
    expect('error' in ans).toBe(true);
  });

  test('rejects missing probabilities', () => {
    const { probabilities, ...rest } = goodRaw;
    void probabilities;
    const ans = validateChoiceAnswer(stanceQuestion, rest);
    expect('error' in ans).toBe(true);
  });

  // ★ probabilities のキーへの値の割り当てを 1 つずらす（choice はそのまま "supports"）と赤。
  // このテストが green のうちは検出できているという証明。
  // 赤にする変異の当て方: validate.ts の validateChoiceAnswer から
  //   `const maxVal = Math.max(...); if (Math.abs(dist.normalized[choice] - maxVal) > 1e-9) { return invalid(...); }`
  // の一貫性検査を削除する（= choice と最大確率クラスの一致検査を外す）と、このテストは
  // 「rejects」の expect(true) が false になり fail する。
  test('★ rejects when probabilities are shifted so choice no longer matches the argmax class', () => {
    // supports の確率(0.99)を unrelated へ移し、choice フィールドは "supports" のまま。
    const shifted = {
      ...goodRaw,
      probabilities: { supports: 0.01, contradicts: 0.0, unrelated: 0.99 },
    };
    const ans = validateChoiceAnswer(stanceQuestion, shifted);
    expect('error' in ans).toBe(true);
    if ('error' in ans) {
      expect(ans.code).toBe('invalid_distribution');
    }
  });

  test('accepts a tie where choice is one of the tied max classes', () => {
    const tied = { ...goodRaw, choice: 'supports', probabilities: { supports: 0.5, contradicts: 0.5, unrelated: 0.0 } };
    const ans = validateChoiceAnswer(stanceQuestion, tied);
    expect('error' in ans).toBe(false);
  });
});

describe('validateScoreAnswer', () => {
  const goodRaw = {
    type: 'score',
    score: 1.01,
    confidence: 0.99,
    legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' },
    probabilities: { 0: 0.0, 1: 1.0, 2: 0.0, 3: 0.0 },
  };

  test('accepts a well-formed answer and buckets to the max class', () => {
    const raw = validateScoreAnswer(importanceQuestion, goodRaw);
    expect('error' in raw).toBe(false);
    if ('error' in raw) throw new Error('unreachable');
    const ans = raw as ScoreAnswer;
    expect(ans.bucket).toBe('1');
    expect(ans.score).toBe(1.01);
  });

  test('bucket is null when the max probability is below 0.5 (要確認)', () => {
    const split = { ...goodRaw, probabilities: { 0: 0.1, 1: 0.45, 2: 0.45, 3: 0.0 } };
    const raw = validateScoreAnswer(importanceQuestion, split);
    expect('error' in raw).toBe(false);
    if ('error' in raw) throw new Error('unreachable');
    const ans = raw as ScoreAnswer;
    expect(ans.bucket).toBeNull();
  });

  test('falls back to criteria text when legend is missing', () => {
    const { legend, ...rest } = goodRaw;
    void legend;
    const raw = validateScoreAnswer(importanceQuestion, rest);
    expect('error' in raw).toBe(false);
    if ('error' in raw) throw new Error('unreachable');
    const ans = raw as ScoreAnswer;
    expect(ans.legend['1']).toBe('軽微な決定');
  });

  test('rejects probabilities keyed by class name instead of index', () => {
    const bad = { ...goodRaw, probabilities: { low: 1.0 } };
    const ans = validateScoreAnswer(importanceQuestion, bad);
    expect('error' in ans).toBe(true);
  });

  test('rejects a non-numeric score', () => {
    const ans = validateScoreAnswer(importanceQuestion, { ...goodRaw, score: 'high' });
    expect('error' in ans).toBe(true);
  });
});

describe('validateNoulAnswer', () => {
  test('accepts a bare noul value with no probabilities', () => {
    const raw = validateNoulAnswer(guardQuestion, { type: 'noul', noul: 0.96 });
    expect('error' in raw).toBe(false);
    if ('error' in raw) throw new Error('unreachable');
    const ans = raw as NoulAnswer;
    expect(ans.noul).toBe(0.96);
    expect(ans.probabilities).toBeUndefined();
  });

  test('rejects noul outside [0,1]', () => {
    const ans = validateNoulAnswer(guardQuestion, { type: 'noul', noul: 1.2 });
    expect('error' in ans).toBe(true);
  });

  test('rejects probabilities that disagree with noul', () => {
    const ans = validateNoulAnswer(guardQuestion, {
      type: 'noul',
      noul: 0.96,
      probabilities: { true: 0.1, false: 0.9 },
    });
    expect('error' in ans).toBe(true);
  });

  test('accepts consistent probabilities', () => {
    const ans = validateNoulAnswer(guardQuestion, {
      type: 'noul',
      noul: 0.96,
      probabilities: { true: 0.96, false: 0.04 },
    });
    expect('error' in ans).toBe(false);
  });
});

describe('validateAnswer (dispatch)', () => {
  test('returns missing_answer when raw is undefined', () => {
    const ans = validateAnswer(stanceQuestion, undefined);
    expect('error' in ans).toBe(true);
    if ('error' in ans) expect(ans.code).toBe('missing_answer');
  });

  test('dispatches to the right validator by question.type', () => {
    const choiceAns = validateAnswer(stanceQuestion, {
      choice: 'unrelated',
      confidence: 1,
      probabilities: { supports: 0, contradicts: 0, unrelated: 1 },
    });
    expect('error' in choiceAns).toBe(false);

    const noulAns = validateAnswer(guardQuestion, { noul: 0.03 });
    expect('error' in noulAns).toBe(false);
  });
});
