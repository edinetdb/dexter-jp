/**
 * 同梱データの build ゲート（G-C1・G-C2・G-D1、go-decision-v0.md §9.2）。
 * CLI からは `bun run check:data`。
 *
 * `checkMaterialsDir` は純関数（fs 読み取りだけで、プロセスを止めない）なので
 * テストから直接呼べる。CLI エントリ（`import.meta.main`）はその結果を
 * 出力して exit code を決めるだけ。
 *
 * G-C3（MIT からの除外・LICENSE-DATA との対応）は build 時の全件走査ではなく
 * 静的な対応関係なので `license.test.ts` で別途固定する。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPersonNames } from './person-names.js';
import { validateMaterial, type MaterialValidationError } from './schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 実データを置く場所。運用ルールは `materials/README.md`。 */
export const DEFAULT_MATERIALS_DIR = join(__dirname, 'materials');

export interface MaterialCheckIssue {
  /** 例: 'toyota-s100y8ny.json' または 配列内なら 'toyota-s100y8ny.json[0]' */
  location: string;
  /** 'G-C1' | 'G-C2' | 'G-D1' | その他（invalid_json 等）。 */
  code: string;
  message: string;
}

export interface MaterialCheckResult {
  ok: boolean;
  fileCount: number;
  materialCount: number;
  issues: MaterialCheckIssue[];
}

/**
 * ディレクトリ直下の `*.json` を読み、全件を検証する。サブディレクトリ
 * （`__fixtures__` 等）は `readdirSync` が非再帰なので自動的に対象外。
 * ディレクトリが存在しない場合は「素材 0 件」として ok を返す
 * （実データがまだ投入されていない段階を build 失敗にしない）。
 */
export function checkMaterialsDir(dir: string): MaterialCheckResult {
  if (!existsSync(dir)) {
    return { ok: true, fileCount: 0, materialCount: 0, issues: [] };
  }

  const issues: MaterialCheckIssue[] = [];
  let materialCount = 0;

  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort();

  for (const file of files) {
    const full = join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(full, 'utf-8'));
    } catch (e) {
      issues.push({ location: file, code: 'invalid_json', message: `${file}: JSON 解析エラー: ${(e as Error).message}` });
      continue;
    }

    const items = Array.isArray(parsed) ? parsed : [parsed];
    items.forEach((item, i) => {
      materialCount++;
      const location = items.length > 1 ? `${file}[${i}]` : file;

      const schemaErrors: MaterialValidationError[] = validateMaterial(item, location);
      for (const err of schemaErrors) {
        issues.push({ location, code: err.code, message: err.message });
      }

      const text = typeof item === 'object' && item !== null ? (item as Record<string, unknown>).text : undefined;
      if (typeof text === 'string') {
        const names = detectPersonNames(text);
        if (names.length > 0) {
          issues.push({
            location,
            code: 'G-D1',
            message: `${location}: 個人名らしき表現を検出しました（${names.map((n) => n.matchedText).join(', ')}）。demo・自社ベンチの素材に個人名を含む段落は同梱できません`,
          });
        }
      }
    });
  }

  return { ok: issues.length === 0, fileCount: files.length, materialCount, issues };
}

function printReport(result: MaterialCheckResult): void {
  console.log(`[check:data] ${result.fileCount} ファイル / ${result.materialCount} 件の素材を検査しました`);
  if (result.issues.length === 0) {
    console.log('[check:data] OK');
    return;
  }
  console.error(`[check:data] ${result.issues.length} 件のエラー:`);
  for (const issue of result.issues) {
    console.error(`  - [${issue.code}] ${issue.message}`);
  }
}

if (import.meta.main) {
  const dir = process.argv[2] ?? DEFAULT_MATERIALS_DIR;
  const result = checkMaterialsDir(dir);
  printReport(result);
  process.exit(result.ok ? 0 : 1);
}
