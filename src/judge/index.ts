/**
 * 判定層（Judge）の公開 API。設計 = design-v0.md §4.1・§5。
 * `runJudgeBatch` が予算（同時 16・200 回・15 万トークン・90 秒）・再試行（429 は指数バックオフ 2 回）
 * を守りながら複数の JudgeRequest を実行する。
 */
import {
  BudgetTracker,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_WALL_CLOCK_MS,
} from './budget.js';
import { RetryableJudgeError } from './errors.js';
import { runPool } from './pool.js';
import { resolveJudgeBackend } from './backends/select.js';
import type {
  AnswerOrError,
  JudgeBackend,
  JudgeBatchResult,
  JudgeRequest,
} from './types.js';

export * from './types.js';
export * from './errors.js';
export * from './display.js';
export { estimateJudgeCost } from './estimate.js';
export { judgeQuestionHash } from './hash.js';
export { validateAnswer, validateChoiceAnswer, validateScoreAnswer, validateNoulAnswer, validateDistribution } from './validate.js';
export { createJevBackend, JEV_ENDPOINT, DEFAULT_JEV_MODEL } from './backends/jev.js';
export { createLlmBackend } from './backends/llm.js';
export { createReplayBackend, replayFilePath, DEFAULT_REPLAY_MODEL, type JudgeRecording } from './backends/replay.js';
export { writeJudgeRecording } from './backends/recorder.js';
export { resolveJudgeBackend } from './backends/select.js';
export {
  voteAdvice,
  ADVICE_GUARD_QUESTION,
  ADVICE_GUARD_QUESTION_KEY,
  type AdviceVoteResult,
  type VoteAdviceOptions,
} from './vote.js';
export {
  BudgetTracker,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_WALL_CLOCK_MS,
  DEFAULT_MAX_RETRIES,
} from './budget.js';

export interface RunJudgeBatchOptions {
  /** テスト・呼び出し側での明示指定。省略時は resolveJudgeBackend() で env から選ぶ。 */
  backend?: JudgeBackend;
  concurrency?: number;
  maxRequests?: number;
  maxInputTokens?: number;
  maxWallClockMs?: number;
  maxRetries?: number;
  /** テスト注入用。実時間を待たないため。 */
  sleep?: (ms: number) => Promise<void>;
  /** テスト注入用の時計。 */
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number): number {
  // attempt=1 -> 500ms, attempt=2 -> 1000ms (src/model/llm.ts の withRetry と同じ形)
  return 500 * 2 ** (attempt - 1);
}

function errorAnswersFor(request: JudgeRequest, message: string): Record<string, AnswerOrError> {
  return Object.fromEntries(
    Object.keys(request.questions).map((key) => [key, { error: message, code: 'unknown' as const }]),
  );
}

async function callWithRetry(
  backend: JudgeBackend,
  request: JudgeRequest,
  budget: BudgetTracker,
  maxRetries: number,
  sleep: (ms: number) => Promise<void>,
): Promise<Record<string, AnswerOrError> | 'skipped'> {
  let attempt = 0;
  for (;;) {
    // 予算チェックは再試行のたびに通す。ここを 1 回目だけに限定すると
    // 429 を返し続けるバックエンドに対して再試行が上限 200 回を超えて走ってしまう(★予算超過)。
    if (!budget.tryReserveRequest()) return 'skipped';

    try {
      const result = await backend.call(request);
      budget.addInputTokens(result.inputTokens);
      return result.answers;
    } catch (e) {
      const retryable = e instanceof RetryableJudgeError;
      if (retryable && attempt < maxRetries) {
        attempt++;
        await sleep(backoffMs(attempt));
        continue;
      }
      const message = e instanceof Error ? e.message : String(e);
      return errorAnswersFor(request, message);
    }
  }
}

export async function runJudgeBatch(
  requests: readonly JudgeRequest[],
  opts: RunJudgeBatchOptions = {},
): Promise<JudgeBatchResult> {
  const backend = opts.backend ?? resolveJudgeBackend();
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;

  const budget = new BudgetTracker({
    maxRequests: opts.maxRequests ?? DEFAULT_MAX_REQUESTS,
    maxInputTokens: opts.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
    maxWallClockMs: opts.maxWallClockMs ?? DEFAULT_MAX_WALL_CLOCK_MS,
    now: opts.now,
  });

  const answers: JudgeBatchResult['answers'] = {};
  // 未検査(着手できなかった／予算切れで打ち切った) request の数。ハードコード 0 にすると
  // ★「90 秒の打ち切りで未検査 n に 0 を返す」テストが赤になる = 実際にスキップした数を数える。
  let uncheckedCount = 0;

  await runPool(requests, concurrency, async (request) => {
    if (budget.isExhausted()) {
      uncheckedCount++;
      return;
    }
    const result = await callWithRetry(backend, request, budget, maxRetries, sleep);
    if (result === 'skipped') {
      uncheckedCount++;
      return;
    }
    answers[request.key] = result;
  });

  return {
    answers,
    usage: budget.usage(),
    truncated: budget.isExhausted(),
    uncheckedCount,
    backend: backend.name,
  };
}
