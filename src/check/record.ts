/**
 * `/check` の記録（design §4.0「端末内の保存」）。
 *
 * `.dexter/checks/<ts>.json` に残す。**端末内にだけ残る**（当社のサーバーには届かない）。
 * 利用者の仮説 = その人の投資スタンスが平文で残るので:
 *   - `src/permissions/` の floor で `.dexter/checks/` は `read_file` / `bash` から deny
 *     （エージェントが「さっきの判定を踏まえて」で読めないようにする。review r2 M3）
 *   - README の「出さないもの」に「記録は端末内に残る。`.dexter/checks` を消せば消える」
 *
 * 記録 JSON の**当社生成フィールド**は出力 linter を通す（G-A2）。逐語は `{kind:'quote'}` の
 * ままなので走査されない。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dexterPath } from '../utils/paths.js';
import { assertOutputClean } from '../guard/output-linter.js';
import type { CheckPanel } from './panel.js';

export const CHECKS_DIR = dexterPath('checks');

export interface CheckRecord {
  version: 1;
  createdAt: string;
  /** どのバックエンドで判定したか（jev / replay。llm では `/check` は走らない） */
  judgeBackend: string;
  panel: CheckPanel;
}

/** ファイル名に使える形の時刻（`2026-09-22T23-30-00-000Z`）。 */
export function recordFileName(at: Date): string {
  return `${at.toISOString().replace(/[:.]/g, '-')}.json`;
}

export function buildCheckRecord(panel: CheckPanel, judgeBackend: string, at: Date): CheckRecord {
  const record: CheckRecord = {
    version: 1,
    createdAt: at.toISOString(),
    judgeBackend,
    panel,
  };
  // 書き出す前に検査する。逐語は `{kind:'quote'}` なので走査されない。
  assertOutputClean(record, 'check.record');
  return record;
}

export interface WriteCheckRecordOptions {
  /** テスト用。既定は `.dexter/checks/` */
  dir?: string;
  at?: Date;
}

/** @returns 書き出したパス */
export function writeCheckRecord(
  panel: CheckPanel,
  judgeBackend: string,
  options: WriteCheckRecordOptions = {},
): string {
  const at = options.at ?? new Date();
  const record = buildCheckRecord(panel, judgeBackend, at);
  const path = join(options.dir ?? CHECKS_DIR, recordFileName(at));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  return path;
}
