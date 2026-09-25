/**
 * 秘密パスの floor を **bash 以外のツールにも**掛ける（review r2 H2 / M3、design §4.3）。
 *
 * これを書くまでの実態: `evaluatePermission` は bash だけを `evaluateBash`（→ `builtinDeny`）へ
 * 送り、`write_file` / `edit_file` は ask、**それ以外は無条件に allow** だった。
 * `read_file` はサンドボックスの根の下なら何でも読めるので、`.env` も
 * `.dexter/credentials/` も読めた。subagent の read-only ツール一覧にも `read_file` が入る。
 *
 * `.dexter/checks/` も同じ floor に入れる。`/check` の記録は利用者の仮説（= その人の
 * 投資スタンス）が平文で残るので、ここをエージェントに開けると、入口ガードも出力 linter も
 * 通さずに「さっきの判定を踏まえて」の自由質問で判定結果が使われる。
 */
import { describe, expect, test } from 'bun:test';
import { evaluatePermission } from './engine.js';
import { SUBAGENT_TYPES } from '../tools/subagent/types.js';

const read = (path: string) => evaluatePermission({ tool: 'read_file', args: { path } });

describe('秘密パスの floor — read_file', () => {
  test.each([
    '.dexter/credentials/tradingview.json',
    '.dexter/credentials/',
    '.env',
    '.env.local',
    '.dexter/checks/2026-09-22T10-00-00.json',
    '.ssh/id_ed25519',
    'secrets/credentials.yml',
  ])('deny: %s', (path) => {
    expect(read(path).mode).toBe('deny');
  });

  test.each([
    'README.md',
    'src/cli.ts',
    '.dexter/cache/abc.json',
    '.dexter/RULES.md',
    'docs/checks.md',
  ])('allow: %s', (path) => {
    expect(read(path).mode).toBe('allow');
  });
});

describe('秘密パスの floor — 書き込み系にも同じ線', () => {
  test('write_file / edit_file も deny（ask に落ちない）', () => {
    for (const tool of ['write_file', 'edit_file']) {
      expect({ tool, mode: evaluatePermission({ tool, args: { path: '.env' } }).mode })
        .toEqual({ tool, mode: 'deny' });
      expect({ tool, mode: evaluatePermission({ tool, args: { path: '.dexter/checks/x.json' } }).mode })
        .toEqual({ tool, mode: 'deny' });
    }
  });

  test('普通のパスへの write_file は従来どおり ask（allow にしていない）', () => {
    expect(evaluatePermission({ tool: 'write_file', args: { path: 'notes.md' } }).mode).toBe('ask');
  });

  test('bash は従来どおり deny（この変更で壊れていない）', () => {
    expect(evaluatePermission({ tool: 'bash', args: { command: 'cat .env' } }).mode).toBe('deny');
    expect(evaluatePermission({ tool: 'bash', args: { command: 'cat .dexter/checks/x.json' } }).mode)
      .toBe('deny');
  });
});

describe('秘密パスの floor — 経路と広さ', () => {
  test('subagent は read_file を持つので、同じ floor が効く必要がある', () => {
    // subagent は Agent.create → 同じ AgentToolExecutor → 同じ evaluatePermission を通る。
    // ここでは「subagent が read_file を持っている」という前提が崩れていないことを固定する。
    expect(SUBAGENT_TYPES['general-purpose'].tools).toContain('read_file');
    expect(read('.dexter/credentials/tradingview.json').mode).toBe('deny');
  });

  test('パス引数の名前が違うツールも覆う（per-tool の名指しにしていない）', () => {
    for (const key of ['file_path', 'filePath', 'dir', 'directory']) {
      expect({ key, mode: evaluatePermission({ tool: 'some_future_tool', args: { [key]: '.env' } }).mode })
        .toEqual({ key, mode: 'deny' });
    }
  });

  test('パスでない引数は走査しない（検索語に .env が入っても止めない）', () => {
    expect(evaluatePermission({ tool: 'web_search', args: { query: 'how does .env work' } }).mode)
      .toBe('allow');
  });
});

describe('秘密パスの綴りの変異（review T9 M1）', () => {
  // read_file は後段で正規化してから実際に読む。生の文字列だけを照合すると素通りした
  const variants = [
    '.dexter/./checks/x.json',
    '.dexter//checks/x.json',
    './.dexter/checks/',
    '.dexter/checks/../checks/x.json',
    'sub/../.dexter/checks/x.json',
  ];

  test('★ read_file: `./` 挿入・`//`・`..`・末尾スラッシュでも deny', () => {
    for (const p of variants) expect({ p, mode: read(p).mode }).toEqual({ p, mode: 'deny' });
  });

  test('★ bash: `cat .dexter/./checks/x.json` も deny', () => {
    const mode = evaluatePermission({ tool: 'bash', args: { command: 'cat .dexter/./checks/x.json' } }).mode;
    expect(mode).toBe('deny');
  });

  test('正規化で無関係なパスを秘密扱いにしない（対照）', () => {
    expect(read('src/checks/./x.ts').mode).not.toBe('deny');
  });
});

describe('ファイルツールのパス展開と同じ形で見る（Codex T9 H1）', () => {
  test('★ `@.env` / `@.env.local` / `@.dexter/checks/x` / `~/.ssh/id_rsa` は deny', () => {
    for (const p of ['@.env', '@.env.local', '@.dexter/checks/x.json', '~/.ssh/id_rsa', '@~/.aws/credentials']) {
      expect({ p, mode: read(p).mode }).toEqual({ p, mode: 'deny' });
    }
  });

  test('`@src/checks/x.ts` は秘密扱いにしない（対照）', () => {
    expect(read('@src/checks/x.ts').mode).not.toBe('deny');
  });
});
