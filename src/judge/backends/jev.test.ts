import { describe, expect, test } from 'bun:test';
import type { ChoiceAnswer, ChoiceQuestion } from '../types.js';
import { createJevBackend, JEV_ENDPOINT } from './jev.js';

const stanceQuestion: ChoiceQuestion = {
  type: 'choice',
  instructions: '仮説に対して証拠はどの立場か',
  criteria: { supports: '裏付けている', contradicts: '食い違う', unrelated: '無関係' },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createJevBackend', () => {
  test('posts to the documented endpoint with bearer auth and parses a well-formed answer', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(200, {
        answers: {
          a1: {
            type: 'choice',
            choice: 'supports',
            confidence: 0.99,
            probabilities: { supports: 0.99, contradicts: 0.01, unrelated: 0.0 },
          },
        },
        usage: { input_tokens: 123 },
        model: 'jev-latest',
      });
    };

    const backend = createJevBackend('secret-key', { fetchImpl });
    const result = await backend.call({
      key: 'p1',
      state: '証拠テキスト',
      questions: { a1: stanceQuestion },
    });

    expect(capturedUrl).toBe(JEV_ENDPOINT);
    expect(capturedInit?.method).toBe('POST');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(capturedInit?.body as string);
    expect(body.state).toBe('証拠テキスト');
    expect(body.questions.a1.type).toBe('choice');
    expect(body.model).toBe('jev-latest');

    expect(result.inputTokens).toBe(123);
    const a1 = result.answers.a1;
    expect('error' in a1).toBe(false);
    if (!('error' in a1)) {
      const choiceAns = a1 as ChoiceAnswer;
      expect(choiceAns.type).toBe('choice');
      expect(choiceAns.choice).toBe('supports');
    }
  });

  test('reports missing_answer when a question key is absent from the response', async () => {
    const fetchImpl = async () => jsonResponse(200, { answers: {}, usage: { input_tokens: 5 } });
    const backend = createJevBackend('key', { fetchImpl });
    const result = await backend.call({ key: 'p1', state: 's', questions: { a1: stanceQuestion } });
    const a1 = result.answers.a1;
    expect('error' in a1).toBe(true);
    if ('error' in a1) expect(a1.code).toBe('missing_answer');
  });

  test('reports invalid_distribution for a malformed answer instead of throwing', async () => {
    const fetchImpl = async () =>
      jsonResponse(200, {
        answers: { a1: { type: 'choice', choice: 'supports', confidence: 0.9, probabilities: { supports: 0.3 } } },
        usage: {},
      });
    const backend = createJevBackend('key', { fetchImpl });
    const result = await backend.call({ key: 'p1', state: 's', questions: { a1: stanceQuestion } });
    const a1 = result.answers.a1;
    expect('error' in a1).toBe(true);
    if ('error' in a1) expect(a1.code).toBe('invalid_distribution');
  });

  // ★ probabilities のキーへの値の割り当てを1つずらす(choice は "supports" のまま)と赤。
  // 赤にする変異の当て方: ../validate.ts の choice 一貫性検査(maxVal との比較)を削除すると、
  // この統合テストは「rejects」の expect(true) が false になり fail する。
  test('★ end-to-end: a shifted-probability Jev response is rejected, not silently accepted', async () => {
    const fetchImpl = async () =>
      jsonResponse(200, {
        answers: {
          a1: {
            type: 'choice',
            choice: 'supports', // 選択は supports のまま
            confidence: 0.99,
            // だが確率の山は unrelated に移っている(shift mutation)
            probabilities: { supports: 0.01, contradicts: 0.0, unrelated: 0.99 },
          },
        },
        usage: { input_tokens: 10 },
      });
    const backend = createJevBackend('key', { fetchImpl });
    const result = await backend.call({ key: 'p1', state: 's', questions: { a1: stanceQuestion } });
    const a1 = result.answers.a1;
    expect('error' in a1).toBe(true);
    if ('error' in a1) expect(a1.code).toBe('invalid_distribution');
  });

  test('429 throws a RetryableJudgeError (caller decides whether to retry)', async () => {
    const fetchImpl = async () => new Response('rate limited', { status: 429 });
    const backend = createJevBackend('key', { fetchImpl });
    await expect(backend.call({ key: 'p1', state: 's', questions: { a1: stanceQuestion } })).rejects.toThrow(
      /rate limited/,
    );
  });

  test('5xx throws a RetryableJudgeError', async () => {
    const fetchImpl = async () => new Response('boom', { status: 503 });
    const backend = createJevBackend('key', { fetchImpl });
    await expect(backend.call({ key: 'p1', state: 's', questions: { a1: stanceQuestion } })).rejects.toThrow(
      /server error/,
    );
  });

  test('4xx (non-429) throws a NonRetryableJudgeError', async () => {
    const fetchImpl = async () => new Response('bad request', { status: 400 });
    const backend = createJevBackend('key', { fetchImpl });
    await expect(backend.call({ key: 'p1', state: 's', questions: { a1: stanceQuestion } })).rejects.toThrow(
      /failed \(400\)/,
    );
  });

  test('network errors from fetch become RetryableJudgeError', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNRESET');
    };
    const backend = createJevBackend('key', { fetchImpl });
    await expect(backend.call({ key: 'p1', state: 's', questions: { a1: stanceQuestion } })).rejects.toThrow(
      /network error/,
    );
  });

  test('throws immediately when constructed without an API key', () => {
    expect(() => createJevBackend('')).toThrow();
  });
});
