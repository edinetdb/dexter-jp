/**
 * G-E1: 「README・RELEASE-NOTES・告知の文面に、bench 出力に無い数値が直接書かれていたら赤」。
 *
 * 設計選択（team-lead 発注「形は任せます」を受けての判断、報告に理由を書く）:
 *   - README・RELEASE-NOTES には ROE・PBR・配当利回りのようなスクリーニング例の数値も出る
 *     （実測: README.md / README.en.md に "15%以上" 等が多数）。これは判定層ベンチとは無関係の
 *     プロダクト説明であり、無差別に「数値+単位」を全文検査すると常に赤になって使い物にならない。
 *   - そこでベンチ数値の主張は `<!-- BENCH:JUDGE:START -->` 〜 `<!-- BENCH:JUDGE:END -->` の
 *     マーカーで囲んだブロックの中だけに書く契約にし、このテストはブロックの中だけを検査する。
 *     マーカーが無いファイルは「まだベンチ数値の主張をしていない」= 違反ゼロ（免除ではなく無関係）。
 *   - 一方、**対象ファイル（README*.md / RELEASE-NOTES*.md）が 1 つも無い場合は skip ではなく
 *     違反として fail する**（T8 発注の明示要求）。
 *   - bench 結果ファイル（既定 `src/evals/judge/results/latest.json`）が無い・壊れている場合は
 *     「照合できる数値ゼロ」として扱う — マーカーブロック内に数値主張があれば必ず赤になる
 *     （fail-close。黙って通すより安全側）。
 *
 * 「告知」（hq/approved-text 等）はこのリポジトリの外にあり、このテスト（このリポジトリの
 * `bun test`）の対象範囲外。マーカー運用を告知にも適用するかは運用側の判断。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface HardcodeViolation {
  file: string;
  match: string;
  context: string;
  reason: string;
}

export interface HardcodeGuardOptions {
  /** README・RELEASE-NOTES を探すディレクトリ。既定: リポジトリ直下。 */
  scanDir: string;
  /** 対象ファイル名の判定。既定: README(.xx)?.md / RELEASE-NOTES*.md。 */
  isTargetFile?: (fileName: string) => boolean;
  /** 数値の照合元。既定: `src/evals/judge/results/latest.json`（scanDir 相対）。 */
  benchResultPath?: string;
  // fs アクセスをテストで差し替えるためのフック。
  readDirSync?: (dir: string) => string[];
  readFileSync?: (filePath: string) => string;
  existsSync?: (filePath: string) => boolean;
}

const DEFAULT_IS_TARGET_FILE = (name: string): boolean =>
  /^README(\.[a-zA-Z]{2})?\.md$/.test(name) || /^RELEASE-NOTES.*\.md$/i.test(name);

const MARKER_START = '<!-- BENCH:JUDGE:START -->';
const MARKER_END = '<!-- BENCH:JUDGE:END -->';

const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;
const UNIT_WORDS = ['秒', 'ミリ秒', 'ms', '円', 'ドル', 'トークン', 'リクエスト', '問い', '再試行', '件', 'パーセント', '回'];
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const UNIT_ALTERNATION = UNIT_WORDS.map(escapeRegExp).join('|');
const NUMBER_UNIT_RE = new RegExp(`(${NUMBER})\\s*(?:${UNIT_ALTERNATION}|%)`, 'g');
const CURRENCY_NUMBER_RE = new RegExp(`[¥$]\\s*(${NUMBER})`, 'g');

export interface NumberClaim {
  raw: string;
  index: number;
}

/** テキストから「数値+単位」または「¥/$ + 数値」の形の主張を全部拾う。 */
export function findNumberClaims(text: string): NumberClaim[] {
  const results: NumberClaim[] = [];
  for (const m of text.matchAll(NUMBER_UNIT_RE)) {
    if (m.index === undefined) continue;
    results.push({ raw: m[1], index: m.index });
  }
  for (const m of text.matchAll(CURRENCY_NUMBER_RE)) {
    if (m.index === undefined) continue;
    const offset = m[0].indexOf(m[1]);
    results.push({ raw: m[1], index: m.index + (offset === -1 ? 0 : offset) });
  }
  return results.sort((a, b) => a.index - b.index);
}

/** `<!-- BENCH:JUDGE:START -->` 〜 `<!-- BENCH:JUDGE:END -->` の中身だけを連結して返す。 */
export function extractMarkedBlocks(text: string): string[] {
  const blocks: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf(MARKER_START, searchFrom);
    if (start === -1) break;
    const contentStart = start + MARKER_START.length;
    const end = text.indexOf(MARKER_END, contentStart);
    if (end === -1) break;
    blocks.push(text.slice(contentStart, end));
    searchFrom = end + MARKER_END.length;
  }
  return blocks;
}

function decimalPlaces(numStr: string): number {
  const dot = numStr.indexOf('.');
  return dot === -1 ? 0 : numStr.length - dot - 1;
}

function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectNumbers(v, out);
  }
  return out;
}

/** `rawNumStr`（README 側の表記、カンマ区切り可）が `allowedNumbers` のどれかと、表示桁数で丸めて一致するか。 */
export function isSourcedFromBench(rawNumStr: string, allowedNumbers: readonly number[]): boolean {
  const cleaned = rawNumStr.replace(/,/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return false;
  const places = decimalPlaces(cleaned);
  const factor = 10 ** places;
  const roundedClaim = Math.round(value * factor) / factor;
  return allowedNumbers.some((n) => Math.round(n * factor) / factor === roundedClaim);
}

function loadAllowedNumbers(
  benchResultPath: string,
  existsSync: (p: string) => boolean,
  readFileSync: (p: string) => string,
): number[] {
  if (!existsSync(benchResultPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(benchResultPath));
    return collectNumbers(parsed);
  } catch {
    return [];
  }
}

/**
 * README*.md / RELEASE-NOTES*.md の `<!-- BENCH:JUDGE:START/END -->` ブロック内にある
 * 「数値+単位」主張のうち、bench 結果ファイルの数値で説明できないものを違反として返す。
 * 違反が 1 件でもあれば長さ > 0 の配列（呼び出し側は `.length === 0` で判定する）。
 */
export function findHardcodedBenchNumbers(opts: HardcodeGuardOptions): HardcodeViolation[] {
  const readDirSync = opts.readDirSync ?? ((dir: string) => fs.readdirSync(dir));
  const readFileSync = opts.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const existsSync = opts.existsSync ?? ((p: string) => fs.existsSync(p));
  const isTargetFile = opts.isTargetFile ?? DEFAULT_IS_TARGET_FILE;
  const benchResultPath = opts.benchResultPath ?? path.join(opts.scanDir, 'src/evals/judge/results/latest.json');

  let entries: string[];
  try {
    entries = readDirSync(opts.scanDir);
  } catch {
    entries = [];
  }
  const targetFiles = entries.filter(isTargetFile).sort();

  if (targetFiles.length === 0) {
    return [
      {
        file: '(none)',
        match: '',
        context: '',
        reason: `no target files matched under ${opts.scanDir} (expected README*.md / RELEASE-NOTES*.md) — this must fail, not be skipped`,
      },
    ];
  }

  const allowedNumbers = loadAllowedNumbers(benchResultPath, existsSync, readFileSync);

  const violations: HardcodeViolation[] = [];
  for (const file of targetFiles) {
    const fullPath = path.join(opts.scanDir, file);
    const text = readFileSync(fullPath);
    for (const unmarked of findUnmarkedBenchClaims(text)) {
      violations.push({
        file,
        match: unmarked.number,
        context: unmarked.line.slice(0, 80),
        reason: `ベンチの数値の主張がマーカーの外にある（「${unmarked.vocab}」の行）。`
          + `${MARKER_START} 〜 ${MARKER_END} で囲んで、bench 出力から生成すること`,
      });
    }
    for (const block of extractMarkedBlocks(text)) {
      for (const claim of findNumberClaims(block)) {
        if (!isSourcedFromBench(claim.raw, allowedNumbers)) {
          violations.push({
            file,
            match: claim.raw,
            context: block.slice(Math.max(0, claim.index - 24), claim.index + claim.raw.length + 24).trim(),
            reason: `no number in ${benchResultPath} matches "${claim.raw}" at the displayed rounding`,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * 判定層ベンチの数値だと分かる言い回し。
 *
 * マーカーの中だけを検査する設計には**抜け道**がある: マーカーを付けずに本文へ
 * 「判定にかかった時間は 0.55 秒」と書けば、この検査は 1 件も見ない。
 * そこで「ベンチの話をしている語 + 数値」がマーカーの**外**に出ていたら違反にする。
 * これは「マーカーを付けろ」という指示であって、数値そのものの禁止ではない。
 */
const BENCH_VOCAB = [
  '判定にかかった',
  '判定リクエスト',
  '判定だけ',
  '端から端まで',
  '1 リクエストあたり',
  '1リクエストあたり',
  'リクエストあたり',
  '中央値',
  'ベンチ',
];

/** マーカーの外側だけを連結して返す。 */
export function extractOutsideBlocks(text: string): string {
  const parts: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf(MARKER_START, searchFrom);
    if (start === -1) {
      parts.push(text.slice(searchFrom));
      break;
    }
    parts.push(text.slice(searchFrom, start));
    const end = text.indexOf(MARKER_END, start + MARKER_START.length);
    if (end === -1) break;
    searchFrom = end + MARKER_END.length;
  }
  return parts.join('\n');
}

/**
 * マーカーの外に「ベンチの語 + 数値」が同じ行にあるものを拾う。
 * 行単位で見る（ファイル全体で見ると、無関係な行の数値と語が結び付いて誤検知する）。
 */
export function findUnmarkedBenchClaims(text: string): { line: string; vocab: string; number: string }[] {
  const out: { line: string; vocab: string; number: string }[] = [];
  for (const line of extractOutsideBlocks(text).split('\n')) {
    const vocab = BENCH_VOCAB.find((v) => line.includes(v));
    if (!vocab) continue;
    const claim = findNumberClaims(line)[0];
    if (claim) out.push({ line: line.trim(), vocab, number: claim.raw });
  }
  return out;
}

export { MARKER_START as BENCH_JUDGE_MARKER_START, MARKER_END as BENCH_JUDGE_MARKER_END, BENCH_VOCAB };
