/**
 * ベンチ結果の直列化と出力先パス。
 *
 * 出力は 2 か所:
 *   1. 生ログ — `.dexter/bench/judge-<ts>.json`（gitignore 済み、実行のたびにタイムスタンプ付きで残す）
 *   2. 公開版 — `src/evals/judge/results/latest.json`（git 管理下。README・RELEASE-NOTES の数値は
 *      "この" ファイルから書く契約。G-E1 のハードコード禁止テスト（hardcode-guard.ts）が既定で
 *      参照する先でもある。`--no-publish` で書き込みを止められる）
 */
import path from 'node:path';
import type { BenchRunResult } from './bench.js';
import { assertNoForbiddenBenchWords } from './output-words.js';

export const DEFAULT_RAW_OUT_DIR = '.dexter/bench';
export const DEFAULT_PUBLISH_PATH = 'src/evals/judge/results/latest.json';

/** JSON 直列化 + 禁止語チェック（値・キーのどちらに紛れ込んでも検出する）。 */
export function formatBenchOutput(result: BenchRunResult): string {
  const serialized = JSON.stringify(result, null, 2);
  assertNoForbiddenBenchWords(serialized);
  return serialized;
}

/** `judge-<ISO タイムスタンプ>.json`。コロン・ドットはファイル名に使えないので `-` に置換する。 */
export function timestampedFileName(date: Date = new Date()): string {
  return `judge-${date.toISOString().replace(/[:.]/g, '-')}.json`;
}

export function defaultRawOutPath(baseDir: string = DEFAULT_RAW_OUT_DIR, date: Date = new Date()): string {
  return path.join(baseDir, timestampedFileName(date));
}
