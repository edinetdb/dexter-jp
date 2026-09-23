import { describe, expect, test } from 'bun:test';
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from '../types.js';
import { createLlmBackend } from './llm.js';

const stanceQuestion: ChoiceQuestion = {
  type: 'choice',
  instructions: '仮説に対して証拠はどの立場か',
  criteria: { supports: '裏付けている', contradicts: '食い違う', unrelated: '無関係' },
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

function fakeCallLlm(text: string) {
  return async () => ({ response: text, usage: { inputTokens: 42, outputTokens: 3, totalTokens: 45 } });
}

describe('createLlmBackend (label-only)', () => {
  test('returns a LabelOnlyAnswer with no confidence/probabilities fields', async () => {
    const backend = createLlmBackend({ callLlmImpl: fakeCallLlm('理由...\nANSWER: supports') });
    const result = await backend.call({ key: 'p1', state: 's', questions: { a1: stanceQuestion } });
    const a1 = result.answers.a1;
    expect('error' in a1).toBe(false);
    if ('error' in a1) throw new Error('unreachable');
    expect(a1.backend).toBe('llm');
    expect(a1.type).toBe('choice');
    expect((a1 as { label: string }).label).toBe('supports');
    // 確率つき型のフィールドが存在しないこと（undefined を入れるのではなく型として無い）
    expect('confidence' in a1).toBe(false);
    expect('probabilities' in a1).toBe(false);
  });

  test('works for score questions, labeling by class index', async () => {
    const backend = createLlmBackend({ callLlmImpl: fakeCallLlm('ANSWER: 2') });
    const result = await backend.call({ key: 'p1', state: 's', questions: { imp: importanceQuestion } });
    const imp = result.answers.imp;
    expect('error' in imp).toBe(false);
    if ('error' in imp) throw new Error('unreachable');
    expect((imp as { label: string }).label).toBe('2');
  });

  test('works for noul questions', async () => {
    const backend = createLlmBackend({ callLlmImpl: fakeCallLlm('ANSWER: true') });
    const result = await backend.call({ key: 'p1', state: 's', questions: { g: guardQuestion } });
    const g = result.answers.g;
    expect('error' in g).toBe(false);
    if ('error' in g) throw new Error('unreachable');
    expect((g as { label: string }).label).toBe('true');
  });

  test('reports missing_answer when no valid label can be extracted', async () => {
    const backend = createLlmBackend({ callLlmImpl: fakeCallLlm('よくわかりません') });
    const result = await backend.call({ key: 'p1', state: 's', questions: { a1: stanceQuestion } });
    const a1 = result.answers.a1;
    expect('error' in a1).toBe(true);
    if ('error' in a1) expect(a1.code).toBe('missing_answer');
  });

  test('falls back to a bare label match when the ANSWER: marker is missing', async () => {
    const backend = createLlmBackend({ callLlmImpl: fakeCallLlm('この文章は contradicts だと考えられる') });
    const result = await backend.call({ key: 'p1', state: 's', questions: { a1: stanceQuestion } });
    const a1 = result.answers.a1;
    expect('error' in a1).toBe(false);
    if ('error' in a1) throw new Error('unreachable');
    expect((a1 as { label: string }).label).toBe('contradicts');
  });

  test('sums input tokens across multiple questions in one request', async () => {
    const backend = createLlmBackend({ callLlmImpl: fakeCallLlm('ANSWER: supports') });
    const result = await backend.call({
      key: 'p1',
      state: 's',
      questions: { a1: stanceQuestion, a2: stanceQuestion },
    });
    expect(result.inputTokens).toBe(84); // 42 * 2
  });

  test('captures a thrown error from callLlm as an answer-level error, not a rejection', async () => {
    const backend = createLlmBackend({
      callLlmImpl: async () => {
        throw new Error('provider down');
      },
    });
    const result = await backend.call({ key: 'p1', state: 's', questions: { a1: stanceQuestion } });
    const a1 = result.answers.a1;
    expect('error' in a1).toBe(true);
    if ('error' in a1) expect(a1.error).toContain('provider down');
  });
});
