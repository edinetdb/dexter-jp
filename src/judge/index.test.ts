import { describe, expect, test } from 'bun:test';
import { RetryableJudgeError } from './errors.js';
import { runJudgeBatch } from './index.js';
import type { ChoiceAnswer, ChoiceQuestion, JudgeBackend, JudgeRequest } from './types.js';

const stanceQuestion: ChoiceQuestion = {
  type: 'choice',
  instructions: 'i',
  criteria: { supports: 's', contradicts: 'c', unrelated: 'u' },
};

const fixedAnswer: ChoiceAnswer = {
  type: 'choice',
  backend: 'jev',
  choice: 'supports',
  confidence: 0.9,
  probabilities: { supports: 0.9, contradicts: 0.05, unrelated: 0.05 },
};

function makeRequests(n: number, questionKey = 'q'): JudgeRequest[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `r${i}`,
    state: `state-${i}`,
    questions: { [questionKey]: stanceQuestion },
  }));
}

const noopSleep = async (_ms: number): Promise<void> => {};

describe('runJudgeBatch — happy path', () => {
  test('collects answers for every request when nothing exceeds budget', async () => {
    const backend: JudgeBackend = {
      name: 'jev',
      call: async () => ({ answers: { q: fixedAnswer }, inputTokens: 10 }),
    };
    const result = await runJudgeBatch(makeRequests(5), { backend, concurrency: 3, sleep: noopSleep });

    expect(Object.keys(result.answers).length).toBe(5);
    expect(result.uncheckedCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.usage.requestCount).toBe(5);
    expect(result.usage.inputTokens).toBe(50);
    expect(result.backend).toBe('jev');
  });
});

describe('runJudgeBatch — concurrency', () => {
  test('never runs more than `concurrency` backend calls at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const backend: JudgeBackend = {
      name: 'jev',
      call: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { answers: { q: fixedAnswer }, inputTokens: 0 };
      },
    };
    const result = await runJudgeBatch(makeRequests(30), { backend, concurrency: 3, sleep: noopSleep });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBe(3); // 実際に並列している証拠（直列なら 1 で止まる）
    expect(result.uncheckedCount).toBe(0);
  });
});

describe('runJudgeBatch — retry counts against the request budget', () => {
  // ★ 再試行を予算カウントから外すと赤。
  // 赤にする変異の当て方: index.ts の callWithRetry から
  //   `if (!budget.tryReserveRequest()) return 'skipped';`
  // をループの先頭(再試行のたび)ではなく関数の最初(初回だけ)に1回だけ呼ぶ形に書き換える。
  // すると、backend.call の呼び出し回数が maxRequests(5) を超えて 9 になり、
  // 以下の `expect(callCount).toBeLessThanOrEqual(5)` が fail する。
  test('★ a backend that always 429s cannot exceed maxRequests even across retries', async () => {
    let callCount = 0;
    const backend: JudgeBackend = {
      name: 'jev',
      call: async () => {
        callCount++;
        throw new RetryableJudgeError('always rate limited');
      },
    };
    const requests = makeRequests(3);
    const result = await runJudgeBatch(requests, {
      backend,
      concurrency: 1,
      maxRequests: 5,
      maxRetries: 2,
      sleep: noopSleep,
    });

    // 各 request は最大 maxRetries+1=3 回叩かれうるので、3 request なら理論上 9 回になるはず。
    // 予算(5)を超えないことが「再試行も予算にカウントしている」ことの直接証拠。
    expect(callCount).toBeLessThanOrEqual(5);
    expect(callCount).toBe(5);
    expect(result.usage.requestCount).toBe(5);
    expect(result.truncated).toBe(true);
    // 1件目は 3 回叩ききってエラー回答が確定、2・3件目は予算切れで未検査。
    expect(result.uncheckedCount).toBe(2);
    expect(Object.keys(result.answers).length).toBe(1);
    const q = result.answers.r0.q;
    expect('error' in q).toBe(true);
  });

  test('retries eventually succeed after transient failures', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const backend: JudgeBackend = {
      name: 'jev',
      call: async () => {
        attempts++;
        if (attempts < 3) throw new RetryableJudgeError('transient');
        return { answers: { q: fixedAnswer }, inputTokens: 1 };
      },
    };
    const result = await runJudgeBatch([makeRequests(1)[0] as JudgeRequest], {
      backend,
      concurrency: 1,
      maxRetries: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([500, 1000]); // 指数バックオフ
    const q = result.answers.r0.q;
    expect('error' in q).toBe(false);
  });

  test('non-retryable errors fail immediately without consuming retry budget', async () => {
    let callCount = 0;
    const backend: JudgeBackend = {
      name: 'jev',
      call: async () => {
        callCount++;
        throw new Error('permanent failure, e.g. 400');
      },
    };
    const result = await runJudgeBatch([makeRequests(1)[0] as JudgeRequest], {
      backend,
      maxRetries: 2,
      sleep: noopSleep,
    });
    expect(callCount).toBe(1);
    expect(result.usage.requestCount).toBe(1);
    const q = result.answers.r0.q;
    expect('error' in q).toBe(true);
  });
});

describe('runJudgeBatch — wall-clock cutoff', () => {
  // ★ 90秒の打ち切りで「未検査 n」に 0 を返すと赤。
  // 赤にする変異の当て方: index.ts の runJudgeBatch から `uncheckedCount++` の呼び出しを
  // 削除して(または常に `uncheckedCount = 0` を返すように書き換えて)、以下の
  // `expect(result.uncheckedCount).toBe(3)` を fail させる。
  test('★ stops submitting new requests once the injected clock passes maxWallClockMs, and reports the real unchecked count', async () => {
    let t = 0;
    const now = () => t;
    const backend: JudgeBackend = {
      name: 'jev',
      call: async () => {
        t += 1000; // 1回の呼び出しで「1秒」経過したことにする
        return { answers: { q: fixedAnswer }, inputTokens: 0 };
      },
    };
    const result = await runJudgeBatch(makeRequests(5), {
      backend,
      concurrency: 1,
      maxWallClockMs: 1500,
      maxRequests: 1000,
      maxInputTokens: 1_000_000,
      now,
      sleep: noopSleep,
    });

    expect(Object.keys(result.answers).length).toBe(2); // r0, r1 だけ完走
    expect(result.uncheckedCount).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.usage.requestCount).toBe(2);
  });
});

describe('runJudgeBatch — token budget', () => {
  test('stops once accumulated input tokens reach the cap', async () => {
    const backend: JudgeBackend = {
      name: 'jev',
      call: async () => ({ answers: { q: fixedAnswer }, inputTokens: 40 }),
    };
    const result = await runJudgeBatch(makeRequests(5), {
      backend,
      concurrency: 1,
      maxInputTokens: 100,
      sleep: noopSleep,
    });
    // 40, 80(まだ<100), 120(>=100で打ち切り) -> 3 回目で使い切り、以降は未検査
    expect(Object.keys(result.answers).length).toBe(3);
    expect(result.uncheckedCount).toBe(2);
    expect(result.truncated).toBe(true);
  });
});
