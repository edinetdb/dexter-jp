#!/usr/bin/env bun
/**
 * postinstall フック。
 *
 * `playwright install chromium` は無条件だと数分・130MB 超かかり、
 * 初回体験（`bun install` 直後）の最大の脱落点になる
 * （design v0 §3「脱落の手当て」）。
 * `DEXTER_SKIP_BROWSER=1` を立てたときは何も落とさず終了する。
 * `browser` ツールは初回使用時に Chromium の不在を検知して案内する
 * （`src/tools/browser/browser.ts` の `ensureBrowser`）。
 */
import { spawnSync } from 'node:child_process';

/** `DEXTER_SKIP_BROWSER` が立っているかを判定する（`'1'` のみ真）。 */
export function isBrowserInstallSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEXTER_SKIP_BROWSER === '1';
}

const SKIP_MESSAGE = [
  '[dexter-jp] DEXTER_SKIP_BROWSER=1 — Chromium のダウンロードをスキップしました。',
  '[dexter-jp] browser ツールを使う時は: DEXTER_SKIP_BROWSER を外して bun install し直すか、playwright install chromium を実行してください。',
].join('\n');

export type InstallRunner = () => { status: number | null; error?: Error };

const defaultRunner: InstallRunner = () => spawnSync('playwright', ['install', 'chromium'], { stdio: 'inherit' });

/**
 * postinstall の本体。`runInstall` を差し替えられるようにして、実際に
 * playwright を起動せずに分岐だけをテストできるようにしてある。
 */
export function runPostinstall(env: NodeJS.ProcessEnv = process.env, runInstall: InstallRunner = defaultRunner): number {
  if (isBrowserInstallSkipped(env)) {
    console.log(SKIP_MESSAGE);
    return 0;
  }
  const result = runInstall();
  // `status: null` は「プロセスを起動できなかった」= playwright が PATH に無い等。
  // ここで 0 を返すと install が成功したように見えるが、Chromium は落ちていない
  // （元の `playwright install chromium` なら install ごと失敗していた挙動）。
  // 黙って成功にせず、理由を出して非 0 で終える。
  if (result.status === null) {
    console.error(
      '[dexter-jp] playwright を起動できませんでした' +
        (result.error ? `: ${result.error.message}` : '') +
        '。Chromium を使わないなら DEXTER_SKIP_BROWSER=1 を付けて bun install してください。',
    );
    return 1;
  }
  return result.status;
}

if (import.meta.main) {
  process.exit(runPostinstall());
}
