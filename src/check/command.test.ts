/**
 * CLI の `/check` がどの失敗でも例外を返さず、画面に出す文に落ちること（review T9 H6）。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheckCommand, JUDGE_UNAVAILABLE_AT_RUN, CHECK_FAILED_PREFIX } from './command.js';
import type { CheckPorts } from './index.js';
import type { JudgeBackend } from '../judge/index.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function voteOk(): JudgeBackend {
  return {
    name: 'replay',
    call: async () => ({
      answers: { advice: { type: 'noul', backend: 'jev', noul: 0.01, probabilities: { true: 0.01, false: 0.99 } } },
      inputTokens: 1,
    }),
  };
}

function ports(over: Partial<CheckPorts>): CheckPorts {
  const recordDir = mkdtempSync(join(tmpdir(), 'dexter-cmd-'));
  dirs.push(recordDir);
  return {
    judge: voteOk(),
    decompose: async () => [],
    fetchDisclosure: async () => { throw new Error('unreachable'); },
    recordDir,
    ...over,
  };
}

const HYP = '9983 第 4 四半期は増益だったと会社は説明している';

describe('runCheckCommand はどの失敗でも rejected にならない', () => {
  test('★ EDINET DB の取得失敗（401 等）→ 1 行の日本語 + 記録していない', async () => {
    const p = ports({ fetchDisclosure: async () => { throw new Error('EDINET DB 401 Unauthorized\n  at stack…'); } });
    const out = await runCheckCommand(HYP, p);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain(CHECK_FAILED_PREFIX);
    expect(out[0].text).toContain('401');
    expect(out[0].text).toContain('記録はしていません');
    expect(out[0].text).not.toContain('at stack'); // スタックは出さない
    expect(readdirSync(p.recordDir!)).toHaveLength(0);
  });

  test('★ 分解（LLM）が throw しても落ちない', async () => {
    const p = ports({
      fetchDisclosure: async () => ({ company: { name: 'X' }, fiscalYear: 2025, sections: ['mda'], paragraphs: [] }),
      decompose: async () => { throw new Error('LLM timeout'); },
    });
    const out = await runCheckCommand(HYP, p);
    expect(out[0].text).toContain(CHECK_FAILED_PREFIX);
  });

  test('★ 判定層が走行中に使えなくなったら（JudgeUnavailableError）preflight と同系の案内', async () => {
    const broken: JudgeBackend = { name: 'replay', call: async () => { throw new Error('429'); } };
    const out = await runCheckCommand('9983 この会社のリスク記述は去年から変わった？', ports({ judge: broken }));
    expect(out).toEqual([{ text: JUDGE_UNAVAILABLE_AT_RUN, muted: true }]);
  });

  test('案内文は出力 linter を通る（当社生成）', async () => {
    const { lintOutput } = await import('../guard/output-linter.js');
    expect(lintOutput(JUDGE_UNAVAILABLE_AT_RUN, '$').findings).toEqual([]);
    expect(lintOutput(CHECK_FAILED_PREFIX, '$').findings).toEqual([]);
  });

  test('引数不足は使い方（従来どおり）', async () => {
    const out = await runCheckCommand('9983', ports({}));
    expect(out[0].text).toContain('使い方');
  });

  test('★ cli.ts の `/check` は runCheckCommand を通る（runCheck を直接呼ばない）', async () => {
    const src = await Bun.file(new URL('../cli.ts', import.meta.url)).text();
    expect(src).toContain('runCheckCommand(rest, productionPorts()');
    expect(src).not.toMatch(/\bawait runCheck\(/);
  });
});
