/**
 * 入力ガード × 判定層の接続（go-decision G-A1 改定版 2026-09-22）。
 *
 * 判定層の `voteAdvice`（`src/judge/vote.ts`）を、ガードの `vote` として使う。
 * ここで固定するのは 3 つ:
 *   1. Jev（確率つき）と LLM 代行（確率なし）の**どちらでも同じ判定に到達する**
 *   2. 票が取れないときは `null`（= 素通り）ではなく **`JudgeUnavailableError` を投げ、
 *      それが `guardInput` を通り抜ける**（呼び出し側が `/check` を止められる）
 *   3. 語彙・構造で止まった入力は、票が取れなくても refuse で終わる
 *      （= 決定論の層は判定層に依存していない）
 *
 * なぜ 2 が要るか: 票を `null` にして素通りさせると、判定層が落ちている間だけ
 * ガードが決定論の 18/30 に薄くなり、しかも誰も気づかない。
 */
import { describe, expect, test } from 'bun:test';
import { guardInput } from './input-guard.js';
import { voteAdvice, ADVICE_GUARD_QUESTION } from '../judge/vote.js';
import { JudgeUnavailableError, RetryableJudgeError } from '../judge/errors.js';
import type { JudgeBackend, JudgeBackendCallResult } from '../judge/types.js';

const noSleep = async (): Promise<void> => {};

function backend(answers: JudgeBackendCallResult['answers'], name: 'jev' | 'llm' = 'jev'): JudgeBackend {
  return { name, call: async () => ({ answers, inputTokens: 10 }) };
}

function throwingBackend(e: Error): JudgeBackend {
  return {
    name: 'jev',
    call: async () => {
      throw e;
    },
  };
}

/** `voteAdvice` を guard の `vote` の形に束ねる（`/check` の組み立てと同じ使い方）。 */
const voteWith = (b: JudgeBackend) => (input: string) =>
  voteAdvice(input, { backend: b, sleep: noSleep });

describe('追加票の問い（design §5）', () => {
  test('価値系まで criteria に入っている', () => {
    expect(ADVICE_GUARD_QUESTION.type).toBe('noul');
    expect(ADVICE_GUARD_QUESTION.instructions).toContain('割安か割高か');
    expect(ADVICE_GUARD_QUESTION.instructions).toContain('妥当な株価の水準');
    expect(ADVICE_GUARD_QUESTION.criteria.true).toContain('割安か割高か');
  });
});

describe('Jev（確率つき）— ガードまで到達する', () => {
  test('noul が高いと judge で refuse', async () => {
    const vote = voteWith(
      backend({ advice: { type: 'noul', backend: 'jev', noul: 0.97, probabilities: { true: 0.97, false: 0.03 } } }),
    );
    const verdict = await guardInput('この会社のリスク記述は去年から変わった？', { interactive: true, vote });
    expect(verdict.decision).toBe('refuse');
    expect(verdict.decision === 'refuse' && verdict.by).toBe('judge');
    expect(verdict.decision === 'refuse' && verdict.probability).toBe(0.97);
  });

  test('noul が低ければ通る', async () => {
    const vote = voteWith(
      backend({ advice: { type: 'noul', backend: 'jev', noul: 0.02, probabilities: { true: 0.02, false: 0.98 } } }),
    );
    expect(await guardInput('この会社のリスク記述は去年から変わった？', { interactive: true, vote }))
      .toEqual({ decision: 'proceed' });
  });
});

describe('LLM 代行（確率なし）— 同じ判定に到達する', () => {
  test('label=true で refuse。確率は捏造せず 1/0', async () => {
    const vote = voteWith(backend({ advice: { type: 'noul', backend: 'llm', label: 'true' } }, 'llm'));
    const verdict = await guardInput('この会社のリスク記述は去年から変わった？', { interactive: true, vote });
    expect(verdict.decision).toBe('refuse');
    expect(verdict.decision === 'refuse' && verdict.by).toBe('judge');
    expect(verdict.decision === 'refuse' && verdict.probability).toBe(1);
  });

  test('label=false で通る', async () => {
    const vote = voteWith(backend({ advice: { type: 'noul', backend: 'llm', label: 'false' } }, 'llm'));
    expect(await guardInput('この会社のリスク記述は去年から変わった？', { interactive: true, vote }))
      .toEqual({ decision: 'proceed' });
  });
});

describe('★ 票が取れないときは素通りせず投げる（fail-close）', () => {
  test.each([
    ['回答が欠けている', backend({})],
    ['エラー回答（録画不在など）', backend({ advice: { error: 'no recording', code: 'replay_miss' } })],
    ['バックエンドが落ちている', throwingBackend(new Error('boom'))],
    ['再試行しても直らない', throwingBackend(new RetryableJudgeError('429'))],
  ])('%s → JudgeUnavailableError', async (_label, b) => {
    await expect(voteWith(b)('x')).rejects.toBeInstanceOf(JudgeUnavailableError);
  });

  test('★ その例外は guardInput を通り抜ける（/check が止められる）', async () => {
    const vote = voteWith(throwingBackend(new Error('boom')));
    await expect(
      guardInput('この会社のリスク記述は去年から変わった？', { interactive: true, vote }),
    ).rejects.toBeInstanceOf(JudgeUnavailableError);
  });

  test('原因は cause に残る（握り潰していない）', async () => {
    const original = new Error('boom');
    try {
      await voteWith(throwingBackend(original))('x');
      throw new Error('unreachable');
    } catch (e) {
      expect(e).toBeInstanceOf(JudgeUnavailableError);
      expect((e as Error & { cause?: unknown }).cause).toBe(original);
    }
  });
});

describe('決定論の層は判定層に依存していない', () => {
  test('語彙で止まった入力は、判定層が落ちていても refuse で終わる', async () => {
    const vote = voteWith(throwingBackend(new Error('boom')));
    const verdict = await guardInput('トヨタは今買いですか？', { interactive: true, vote });
    expect(verdict.decision).toBe('refuse');
    expect(verdict.decision === 'refuse' && verdict.by).toBe('vocabulary');
  });

  test('構造で止まった入力も、判定層が落ちていても refuse で終わる', async () => {
    const vote = voteWith(throwingBackend(new Error('boom')));
    const verdict = await guardInput('そろそろ入ってもよさそう？', { interactive: true, vote });
    expect(verdict.decision).toBe('refuse');
    expect(verdict.decision === 'refuse' && verdict.by).toBe('intent');
  });
});
