/**
 * `DEXTER_SKIP_BROWSER=1` のとき postinstall が Chromium を落とさないことを固定する。
 * `runInstall` を差し替えて、実際に playwright を起動せずに分岐だけを検証する。
 */
import { describe, expect, test } from 'bun:test';
import { isBrowserInstallSkipped, runPostinstall } from './postinstall.ts';

describe('isBrowserInstallSkipped', () => {
  test('DEXTER_SKIP_BROWSER=1 は true', () => {
    expect(isBrowserInstallSkipped({ DEXTER_SKIP_BROWSER: '1' })).toBe(true);
  });

  test('未設定は false', () => {
    expect(isBrowserInstallSkipped({})).toBe(false);
  });

  test('"0" や "true" 等 "1" 以外の値は false（厳密一致）', () => {
    expect(isBrowserInstallSkipped({ DEXTER_SKIP_BROWSER: '0' })).toBe(false);
    expect(isBrowserInstallSkipped({ DEXTER_SKIP_BROWSER: 'true' })).toBe(false);
    expect(isBrowserInstallSkipped({ DEXTER_SKIP_BROWSER: '' })).toBe(false);
  });
});

describe('runPostinstall', () => {
  test('DEXTER_SKIP_BROWSER=1 のとき playwright install を呼ばない', () => {
    let calls = 0;
    const runInstall = () => {
      calls += 1;
      return { status: 0 };
    };
    const code = runPostinstall({ DEXTER_SKIP_BROWSER: '1' }, runInstall);
    expect(calls).toBe(0);
    expect(code).toBe(0);
  });

  test('未設定のとき playwright install を呼ぶ（従来どおり走る）', () => {
    let calls = 0;
    const runInstall = () => {
      calls += 1;
      return { status: 0 };
    };
    const code = runPostinstall({}, runInstall);
    expect(calls).toBe(1);
    expect(code).toBe(0);
  });

  test('install の exit code をそのまま伝播する', () => {
    const runInstall = () => ({ status: 1 });
    const code = runPostinstall({}, runInstall);
    expect(code).toBe(1);
  });

  /**
   * 旧: 「status が null のときは 0 として扱う」（= 成功扱い）。
   * 新: 非 0 を返す。
   * 理由: `status: null` は「プロセスを起動できなかった」で、Chromium は落ちていない。
   *   0 を返すと `bun install` が成功したように見えるのに browser ツールだけ後で壊れる。
   *   元の `postinstall: playwright install chromium` なら install ごと失敗していたので、
   *   0 に丸めるのは**この便が持ち込んだ退行**だった。新しい線は下の describe で正面から固定する。
   */
});

describe('起動できなかったときに黙って成功にしない', () => {
  test('★ status=null（playwright が PATH に無い）で非 0 を返す', () => {
    const rc = runPostinstall({} as NodeJS.ProcessEnv, () => ({
      status: null,
      error: new Error('spawn playwright ENOENT'),
    }));
    expect(rc).not.toBe(0);
  });

  test('スキップ時は 0（こちらは成功でよい）', () => {
    expect(runPostinstall({ DEXTER_SKIP_BROWSER: '1' } as NodeJS.ProcessEnv, () => ({ status: null }))).toBe(0);
  });

  test('playwright が非 0 で終わったらその値を返す（0 に丸めない）', () => {
    expect(runPostinstall({} as NodeJS.ProcessEnv, () => ({ status: 3 }))).toBe(3);
  });
});
