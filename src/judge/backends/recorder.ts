/** replay backend 用の録画ファイルを書く。demo 同梱データ・テスト fixture の生成に使う。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { judgeQuestionHash } from '../hash.js';
import type { AnswerOrError, Question } from '../types.js';
import { DEFAULT_REPLAY_MODEL, replayFilePath, type JudgeRecording } from './replay.js';

export interface WriteJudgeRecordingInput {
  dir: string;
  state: string;
  question: Question;
  answer: AnswerOrError;
  inputTokens?: number;
  model?: string;
}

export function writeJudgeRecording(input: WriteJudgeRecordingInput): string {
  const model = input.model ?? DEFAULT_REPLAY_MODEL;
  const hash = judgeQuestionHash({
    state: input.state,
    instructions: input.question.instructions,
    criteria: input.question.criteria,
    model,
  });
  mkdirSync(input.dir, { recursive: true });
  const filePath = replayFilePath(input.dir, hash);
  const recording: JudgeRecording = { answer: input.answer, inputTokens: input.inputTokens ?? 0 };
  writeFileSync(filePath, JSON.stringify(recording, null, 2));
  return filePath;
}
