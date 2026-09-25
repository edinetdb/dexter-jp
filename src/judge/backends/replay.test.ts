import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChoiceQuestion } from '../types.js';
import { writeJudgeRecording } from './recorder.js';
import { createReplayBackend } from './replay.js';

const stanceQuestion: ChoiceQuestion = {
  type: 'choice',
  instructions: '仮説に対して証拠はどの立場か',
  criteria: { supports: '裏付けている', contradicts: '食い違う', unrelated: '無関係' },
};

describe('createReplayBackend', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dexter-judge-replay-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('replays a previously recorded answer by hash', async () => {
    writeJudgeRecording({
      dir,
      state: '証拠テキスト',
      question: stanceQuestion,
      answer: { type: 'choice', backend: 'jev', choice: 'supports', confidence: 0.99, probabilities: { supports: 0.99, contradicts: 0.01, unrelated: 0.0 } },
      inputTokens: 50,
    });

    const backend = createReplayBackend(dir);
    const result = await backend.call({ key: 'p1', state: '証拠テキスト', questions: { a1: stanceQuestion } });

    expect(result.inputTokens).toBe(50);
    const a1 = result.answers.a1;
    expect('error' in a1).toBe(false);
    if ('error' in a1) throw new Error('unreachable');
    expect(a1.type).toBe('choice');
    expect((a1 as { choice: string }).choice).toBe('supports');
  });

  // ★ 録画が無い時に実 API へ落ちる、と赤。
  // このテストは replay 単体で「フォールバックせず throw する」ことを固定する。
  // 赤にする変異の当て方: backends/replay.ts の call() 内の
  //   `if (!existsSync(filePath)) { throw new ReplayMissError(...); }`
  // を、jev/llm バックエンドへフォールバックする try/catch に書き換えると、
  // この test は「rejects」の期待が満たされなくなり fail する。
  test('★ throws (does not fall back to a live API) when no recording exists', async () => {
    const backend = createReplayBackend(dir);
    await expect(
      backend.call({ key: 'p1', state: '未録画の証拠', questions: { a1: stanceQuestion } }),
    ).rejects.toThrow(/no recording/);
  });

  test('a partial match (state changed) is treated as a miss, not the old recording', async () => {
    writeJudgeRecording({
      dir,
      state: '証拠A',
      question: stanceQuestion,
      answer: { type: 'choice', backend: 'jev', choice: 'supports', confidence: 0.9, probabilities: { supports: 0.9, contradicts: 0.05, unrelated: 0.05 } },
    });
    const backend = createReplayBackend(dir);
    await expect(
      backend.call({ key: 'p1', state: '証拠B（別の段落）', questions: { a1: stanceQuestion } }),
    ).rejects.toThrow();
  });

  test('one missing question in a multi-question request still throws (no partial silent success)', async () => {
    const otherQuestion: ChoiceQuestion = { ...stanceQuestion, instructions: '別の質問' };
    writeJudgeRecording({
      dir,
      state: 's',
      question: stanceQuestion,
      answer: { type: 'choice', backend: 'jev', choice: 'supports', confidence: 0.9, probabilities: { supports: 0.9, contradicts: 0.05, unrelated: 0.05 } },
    });
    const backend = createReplayBackend(dir);
    await expect(
      backend.call({ key: 'p1', state: 's', questions: { a1: stanceQuestion, a2: otherQuestion } }),
    ).rejects.toThrow();
  });
});
