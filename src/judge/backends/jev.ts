/**
 * Jev バックエンド。実測済みの HTTP 契約で TypeSafe の Jev を叩く。
 *   POST https://api.typesafe.ai/v1/systemone
 *   headers: Authorization: Bearer <key>, Content-Type: application/json
 *   body: { state, questions: { [key]: {type, instructions, criteria} }, model }
 *   応答: { answers: { [key]: <raw answer> }, usage: { input_tokens }, model }
 *
 * `fetchImpl` は注入可能（既定は global fetch）。テストは必ず fetchImpl を注入し、
 * 実 API へは絶対に出ない（no-network.test.ts で担保）。
 */
import { NonRetryableJudgeError, RetryableJudgeError } from '../errors.js';
import type { JudgeBackend, JudgeBackendCallResult, JudgeRequest } from '../types.js';
import { validateAnswer } from '../validate.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_JEV_MODEL = 'jev-latest';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface CreateJevBackendOptions {
  model?: string;
  fetchImpl?: FetchLike;
}

interface JevResponseBody {
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: number };
  model?: string;
}

export function createJevBackend(apiKey: string, opts: CreateJevBackendOptions = {}): JudgeBackend {
  const model = opts.model ?? DEFAULT_JEV_MODEL;
  const fetchImpl: FetchLike = opts.fetchImpl ?? (globalThis.fetch as FetchLike);

  if (!apiKey) {
    throw new NonRetryableJudgeError('TYPESAFE_API_KEY is required to create the jev backend');
  }

  return {
    name: 'jev',
    async call(request: JudgeRequest): Promise<JudgeBackendCallResult> {
      const body = {
        state: request.state,
        questions: Object.fromEntries(
          Object.entries(request.questions).map(([key, q]) => [
            key,
            { type: q.type, instructions: q.instructions, criteria: q.criteria },
          ]),
        ),
        model,
      };

      let res: Response;
      try {
        res = await fetchImpl(JEV_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw new RetryableJudgeError(
          `jev network error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      if (res.status === 429) {
        throw new RetryableJudgeError('jev rate limited (429)');
      }
      if (res.status >= 500) {
        throw new RetryableJudgeError(`jev server error (${res.status})`);
      }
      if (!res.ok) {
        throw new NonRetryableJudgeError(`jev request failed (${res.status})`);
      }

      let json: JevResponseBody;
      try {
        json = (await res.json()) as JevResponseBody;
      } catch (e) {
        throw new RetryableJudgeError(
          `jev response was not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const rawAnswers = json.answers ?? {};
      const inputTokens = typeof json.usage?.input_tokens === 'number' ? json.usage.input_tokens : 0;

      const answers: JudgeBackendCallResult['answers'] = {};
      for (const [key, question] of Object.entries(request.questions)) {
        answers[key] = validateAnswer(question, rawAnswers[key]);
      }

      return { answers, inputTokens };
    },
  };
}
