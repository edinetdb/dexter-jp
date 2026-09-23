/**
 * 補完の一覧と、`cli.ts` の配線が噛み合っているか。
 *
 * review r2 L1: `cli.ts` の `switch` は完全一致で、`SLASH_COMMANDS`（補完の一覧）とは
 * 別に持たれている。**一覧に出るのに `switch` に無いコマンド**は、選んだ瞬間に
 * 黙って何も起きない（エラーも出ない）。ここで両者を突き合わせる。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SLASH_COMMANDS, matchCommands } from './index.js';

const CLI = readFileSync(join(import.meta.dir, '..', 'cli.ts'), 'utf-8');

/**
 * コメントを外した「コードだけ」の cli.ts。
 *
 * 旧経路が残っていないことを素の文字列検索で見ると、**旧経路を説明したコメント**に
 * 当たって赤になる（`critical-change-review.md` §E-2 =「文字列がどこかにあれば」で
 * 判定しない、と同じ形の誤り）。検査はコードにアンカーする。
 */
const CLI_CODE = CLI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('補完の一覧と cli.ts の switch が一致している', () => {
  test('★ 一覧に出る全コマンドに case がある（無いと選んでも何も起きない）', () => {
    const missing = SLASH_COMMANDS.filter(c => !CLI_CODE.includes(`case '${c.name}':`)).map(c => c.name);
    expect(missing).toEqual([]);
  });

  test('`/check` と `/watch` が一覧にある', () => {
    const names = SLASH_COMMANDS.map(c => c.name);
    expect(names).toContain('check');
    expect(names).toContain('watch');
  });

  test('`/che` で check が補完される', () => {
    expect(matchCommands('/che').map(c => c.name)).toEqual(['check']);
  });
});

describe('cli.ts が引数を落とさない', () => {
  test('★ 入力全体を toLowerCase して switch に渡す旧経路が残っていない', () => {
    // 旧: `query.slice(1).trim().toLowerCase()` を handleSlashCommand に丸ごと渡していた
    //     = 引数つきは case に当たらず黙って無視され、仮説の本文も小文字化されていた
    expect(CLI_CODE).not.toContain('query.slice(1).trim().toLowerCase()');
    // コメントを外す処理自体が効いていることの対（外していなければこの行が赤になる）
    expect(CLI).toContain('query.slice(1).trim().toLowerCase()'); // = 説明コメントには残っている
  });

  test('parseSlashCommand を通している', () => {
    expect(CLI_CODE).toContain('parseSlashCommand(query)');
    expect(CLI_CODE).toContain('handleSlashCommand(parsed.name, parsed.rest)');
  });
});
