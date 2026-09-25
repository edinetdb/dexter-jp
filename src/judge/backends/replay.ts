/**
 * replay バックエンド。テストがポートとして注入して使う（env からは選ばれない = review T9 H5）。
 * 要求のハッシュ = state + instructions + criteria + model（hash.ts）。
 * 録画が 1 問でも見つからなければ ReplayMissError を投げて**失敗する**。実 API へは絶対に落ちない
 * （フォールバックの try/catch を足すと ★ テストが赤になる = replay.test.ts 参照）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ReplayMissError } from '../errors.js';
import { judgeQuestionHash } from '../hash.js';
import type { AnswerOrError, JudgeBackend, JudgeBackendCallResult, JudgeRequest } from '../types.js';

export const DEFAULT_REPLAY_MODEL = 'jev-latest';

export interface JudgeRecording {
  answer: AnswerOrError;
  inputTokens: number;
}

export interface CreateReplayBackendOptions {
  model?: string;
}

export function replayFilePath(dir: string, hash: string): string {
  return path.join(dir, `${hash}.json`);
}

export function createReplayBackend(dir: string, opts: CreateReplayBackendOptions = {}): JudgeBackend {
  const model = opts.model ?? DEFAULT_REPLAY_MODEL;

  return {
    name: 'replay',
    async call(request: JudgeRequest): Promise<JudgeBackendCallResult> {
      const answers: JudgeBackendCallResult['answers'] = {};
      let inputTokens = 0;

      for (const [key, question] of Object.entries(request.questions)) {
        const hash = judgeQuestionHash({
          state: request.state,
          instructions: question.instructions,
          criteria: question.criteria,
          model,
        });
        const filePath = replayFilePath(dir, hash);
        if (!existsSync(filePath)) {
          throw new ReplayMissError(
            `no recording for question "${key}" (hash ${hash}) in ${dir}. Record it first; the replay backend never falls back to a live API.`,
          );
        }
        const recorded = JSON.parse(readFileSync(filePath, 'utf8')) as JudgeRecording;
        answers[key] = recorded.answer;
        inputTokens += recorded.inputTokens ?? 0;
      }

      return { answers, inputTokens };
    },
  };
}
