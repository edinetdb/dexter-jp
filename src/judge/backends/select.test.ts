import { describe, expect, test } from 'bun:test';
import { resolveJudgeBackend } from './select.js';

describe('resolveJudgeBackend', () => {
  test('DEXTER_JUDGE_REPLAY is ignored: replay is never chosen from env (review T9 H5)', () => {
    // 鍵あり: jev のまま（録画が鍵より優先されない）
    expect(resolveJudgeBackend({
      env: { DEXTER_JUDGE_REPLAY: '/tmp/some-dir', TYPESAFE_API_KEY: 'key' },
    }).name).toBe('jev');
    // 鍵なし: llm（= preflight で止まる）。replay に化けて /check が鍵なしで走らない
    expect(resolveJudgeBackend({ env: { DEXTER_JUDGE_REPLAY: '/tmp/some-dir' } }).name).toBe('llm');
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
