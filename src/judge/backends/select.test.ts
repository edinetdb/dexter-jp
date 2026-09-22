import { describe, expect, test } from 'bun:test';
import { resolveJudgeBackend } from './select.js';

describe('resolveJudgeBackend', () => {
  test('picks replay when DEXTER_JUDGE_REPLAY is set, even if TYPESAFE_API_KEY is also present', () => {
    const backend = resolveJudgeBackend({
      env: { DEXTER_JUDGE_REPLAY: '/tmp/some-dir', TYPESAFE_API_KEY: 'key' },
    });
    expect(backend.name).toBe('replay');
  });

  test('picks jev when TYPESAFE_API_KEY is set and no replay dir', () => {
    const backend = resolveJudgeBackend({ env: { TYPESAFE_API_KEY: 'key' } });
    expect(backend.name).toBe('jev');
  });

  test('falls back to llm when neither is set', () => {
    const backend = resolveJudgeBackend({ env: {} });
    expect(backend.name).toBe('llm');
  });

  test('constructing a backend does not perform any I/O by itself', () => {
    // jev バックエンドの生成自体は fetch を呼ばない（呼ぶのは .call() の中だけ）。
    const backend = resolveJudgeBackend({ env: { TYPESAFE_API_KEY: 'key' } });
    expect(typeof backend.call).toBe('function');
  });
});
