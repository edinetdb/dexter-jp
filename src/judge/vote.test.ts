import { describe, expect, test } from 'bun:test';
import { RetryableJudgeError } from './errors.js';
import type { JudgeBackend } from './types.js';
import { ADVICE_GUARD_QUESTION_KEY, voteAdvice } from './vote.js';

const noopSleep = async (_ms: number): Promise<void> => {};

function jevBackend(noul: number): JudgeBackend {
  return {
    name: 'jev',
    call: async () => ({
      answers: { [ADVICE_GUARD_QUESTION_KEY]: { type: 'noul', backend: 'jev', noul } },
      inputTokens: 5,
    }),
  };
}

function llmBackend(label: 'true' | 'false'): JudgeBackend {
  return {
    name: 'llm',
    call: async () => ({
      answers: { [ADVICE_GUARD_QUESTION_KEY]: { type: 'noul', backend: 'llm', label } },
      inputTokens: 5,
    }),
  };
}

describe('voteAdvice — jev backend (probability-bearing)', () => {
  test('high noul => isAdvice true, probability passed through', async () => {
    const v = await voteAdvice('これ今買っていいやつ？', { backend: jevBackend(0.96) });
    expect(v.isAdvice).toBe(true);
    expect(v.probability).toBe(0.96);
  });

  test('low noul => isAdvice false', async () => {
    const v = await voteAdvice('日産の減益は関税が主因だと思う。開示で確かめたい', { backend: jevBackend(0.03) });
    expect(v.isAdvice).toBe(false);
    expect(v.probability).toBe(0.03);
  });

  test('threshold is configurable', async () => {
    const v = await voteAdvice('微妙な文', { backend: jevBackend(0.6), threshold: 0.7 });
    expect(v.isAdvice).toBe(false);
    expect(v.probability).toBe(0.6);
  });

  test('sends the exact state/question shape (design §5)', async () => {
    let captured: unknown;
    const backend: JudgeBackend = {
      name: 'jev',
      call: async (req) => {
        captured = req;
        return { answers: { [ADVICE_GUARD_QUESTION_KEY]: { type: 'noul', backend: 'jev', noul: 0.1 } }, inputTokens: 0 };
      },
    };
    await voteAdvice('テスト入力', { backend });
    const req = captured as { state: string; questions: Record<string, { instructions: string }> };
    expect(req.state).toBe('利用者の入力: テスト入力');
    expect(req.questions[ADVICE_GUARD_QUESTION_KEY].instructions).toContain('割安か割高か');
    expect(req.questions[ADVICE_GUARD_QUESTION_KEY].instructions).toContain('妥当な株価の水準');
  });
});

describe('voteAdvice — llm backend (label-only, no probability)', () => {
  test('label "true" => isAdvice true, probability=1 (not thresholded)', async () => {
    const v = await voteAdvice('目標株価を教えて', { backend: llmBackend('true') });
    expect(v.isAdvice).toBe(true);
    expect(v.probability).toBe(1);
  });

  test('label "false" => isAdvice false, probability=0', async () => {
    const v = await voteAdvice('リスク記述は去年から変わった？', { backend: llmBackend('false') });
    expect(v.isAdvice).toBe(false);
    expect(v.probability).toBe(0);
  });
});

describe('voteAdvice — fails loud (does not return null) when the judge layer is unusable', () => {
  test('missing answer throws', async () => {
    const backend: JudgeBackend = { name: 'jev', call: async () => ({ answers: {}, inputTokens: 0 }) };
    await expect(voteAdvice('x', { backend })).rejects.toThrow(/no answer/);
  });

  test('an AnswerError from the backend throws (llm key missing, etc.)', async () => {
    const backend: JudgeBackend = {
      name: 'llm',
      call: async () => ({
        answers: { [ADVICE_GUARD_QUESTION_KEY]: { error: 'no LLM provider configured', code: 'unknown' } },
        inputTokens: 0,
      }),
    };
    await expect(voteAdvice('x', { backend })).rejects.toThrow(/backend failed/);
  });

  test('a persistently failing (RetryableJudgeError) backend throws after retries, not null', async () => {
    let calls = 0;
    const backend: JudgeBackend = {
      name: 'jev',
      call: async () => {
        calls++;
        throw new RetryableJudgeError('network down');
      },
    };
    await expect(voteAdvice('x', { backend, maxRetries: 2, sleep: noopSleep })).rejects.toThrow(/network down/);
    expect(calls).toBe(3); // 初回 + 再試行2回
  });

  test('a non-retryable error throws immediately without retrying', async () => {
    let calls = 0;
    const backend: JudgeBackend = {
      name: 'jev',
      call: async () => {
        calls++;
        throw new Error('auth error');
      },
    };
    await expect(voteAdvice('x', { backend, maxRetries: 2, sleep: noopSleep })).rejects.toThrow(/auth error/);
    expect(calls).toBe(1);
  });
});

describe('voteAdvice — recovers from a transient failure', () => {
  test('succeeds on the 2nd attempt after one RetryableJudgeError', async () => {
    let calls = 0;
    const backend: JudgeBackend = {
      name: 'jev',
      call: async () => {
        calls++;
        if (calls === 1) throw new RetryableJudgeError('transient');
        return { answers: { [ADVICE_GUARD_QUESTION_KEY]: { type: 'noul', backend: 'jev', noul: 0.9 } }, inputTokens: 0 };
      },
    };
    const v = await voteAdvice('x', { backend, sleep: noopSleep });
    expect(v.isAdvice).toBe(true);
    expect(calls).toBe(2);
  });
});
