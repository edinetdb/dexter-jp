/**
 * `TYPESAFE_API_KEY` が環境にあっても、この judge テスト群は実 API に一切出ない。
 * jev バックエンドは常に `fetchImpl` を注入して呼ぶ（jev.test.ts 全体がその実例）。
 * ここでは念のため、global fetch を「呼ばれたら即エラー」に差し替えたうえで、
 * resolveJudgeBackend() が TYPESAFE_API_KEY を見て jev を選ぶところまでは
 * ネットワークに触らないこと、かつ実際に .call() すれば（fetchImpl 未注入なら）
 * 差し替えた global fetch を経由することを確認する。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resolveJudgeBackend } from './backends/select.js';
import type { ChoiceQuestion } from './types.js';

const stanceQuestion: ChoiceQuestion = {
  type: 'choice',
  instructions: 'i',
  criteria: { supports: 's', contradicts: 'c', unrelated: 'u' },
};

describe('no-network guarantee', () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TYPESAFE_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
  });

  test('resolving a backend (construction only) never touches the network', () => {
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      throw new Error('network access attempted in tests');
    }) as unknown as typeof fetch;

    process.env.TYPESAFE_API_KEY = 'fake-key-for-test';
    const backend = resolveJudgeBackend();
    expect(backend.name).toBe('jev');
    expect(called).toBe(false);
  });

  test('every other judge test that exercises the jev backend injects its own fetchImpl (this file proves the global is otherwise poisoned)', async () => {
    globalThis.fetch = (() => {
      throw new Error('network access attempted in tests');
    }) as unknown as typeof fetch;
    process.env.TYPESAFE_API_KEY = 'fake-key-for-test';

    const backend = resolveJudgeBackend();
    // .call() を注入なしで叩けば、差し替えた global fetch を経由して失敗する
    // = 本物の TypeSafe API には絶対に届かないことの直接証拠。
    await expect(
      backend.call({ key: 'p1', state: 's', questions: { a1: stanceQuestion } }),
    ).rejects.toThrow(/network access attempted in tests/);
  });
});
