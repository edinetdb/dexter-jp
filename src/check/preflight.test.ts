/**
 * `/check` は判定層が Jev（か その録画）のときだけ走る。
 * 小池裁定 B（2026-09-22、親 = ED グロース HQ 第22代 経由）の機械ゲート。
 */
import { describe, expect, test } from 'bun:test';
import { preflightCheck, VOTE_CAPABLE_BACKENDS } from './preflight.js';
import { resolveJudgeBackend } from '../judge/index.js';
import type { JudgeBackend } from '../judge/index.js';

const fake = (name: JudgeBackend['name']): JudgeBackend => ({
  name,
  call: async () => ({ answers: {}, inputTokens: 0 }),
});

describe('/check の事前判定', () => {
  test('★ backend が llm（LLM 代行）なら走らせない', () => {
    const got = preflightCheck(fake('llm'));
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.reason).toBe('no_vote_capable_judge');
    expect(got.ok === false && got.backendName).toBe('llm');
  });

  test('backend が jev なら走る', () => {
    expect(preflightCheck(fake('jev')).ok).toBe(true);
  });

  test('backend が replay なら走る（demo と端から端までのテスト）', () => {
    expect(preflightCheck(fake('replay')).ok).toBe(true);
  });

  test('許可リストに llm が入っていない（リストそのものを固定する）', () => {
    expect([...VOTE_CAPABLE_BACKENDS]).toEqual(['jev', 'replay']);
    expect(VOTE_CAPABLE_BACKENDS as readonly string[]).not.toContain('llm');
  });
});

describe('止まるときの案内（利用者が次に何をすればよいか分かる）', () => {
  const stopped = preflightCheck(fake('llm'));
  const message = stopped.ok === false ? stopped.message : '';

  test('TYPESAFE_API_KEY と demo の 2 つを案内する', () => {
    expect(message).toContain('TYPESAFE_API_KEY');
    expect(message).toContain('bun run demo');
  });

  test('止まる理由を数字つきで書いている（「使えません」だけで終わらせない）', () => {
    expect(message).toContain('30 本のうち 8 本');
  });

  test('案内文は出力 linter を通る（当社生成の文字列）', async () => {
    const { lintOutput } = await import('../guard/output-linter.js');
    expect(lintOutput(message, '$.preflight').findings).toEqual([]);
  });
});

describe('env からの解決（実際の既定経路）', () => {
  test('鍵が 1 つも無い env は llm に落ち、/check は止まる', () => {
    const backend = resolveJudgeBackend({ env: {} });
    expect(backend.name).toBe('llm');
    expect(preflightCheck(backend).ok).toBe(false);
  });

  test('TYPESAFE_API_KEY があれば jev で走る', () => {
    const backend = resolveJudgeBackend({ env: { TYPESAFE_API_KEY: 'x' } });
    expect(backend.name).toBe('jev');
    expect(preflightCheck(backend).ok).toBe(true);
  });

  test('DEXTER_JUDGE_REPLAY を置いても鍵なしでは /check は走らない（review T9 H5）', () => {
    // 以前は replay が最優先 = 利用者の録画が入口ガードの票になり、鍵なしで走った
    const noKey = resolveJudgeBackend({ env: { DEXTER_JUDGE_REPLAY: '/tmp/rec' } });
    expect(noKey.name).toBe('llm');
    expect(preflightCheck(noKey).ok).toBe(false);
    // 鍵があっても録画には化けない
    const withKey = resolveJudgeBackend({ env: { DEXTER_JUDGE_REPLAY: '/tmp/rec', TYPESAFE_API_KEY: 'x' } });
    expect(withKey.name).toBe('jev');
  });

  test('CLI の本番ポートは判定層を注入しない = env 以外から replay が入る口が無い', async () => {
    const { productionPorts } = await import('./ports.js');
    expect(productionPorts().judge).toBeUndefined();
  });
});
