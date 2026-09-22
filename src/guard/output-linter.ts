/**
 * 出力側 linter（go-decision G-A2 / G-A4 / G-A5 / G-A6）。
 *
 * **1 つの関数で `/check` と `/watch` の両方に掛ける**（review r2 M13）。
 *
 * 走査するのは **当社が生成した文字列だけ**: 見出し・群の名前・ラベル・件数文・
 * LLM の要約・記録 JSON の当社生成フィールド。
 * 走査しないもの: `{kind:'quote'}` で包まれた逐語（有報の原文、upstream の開示タイトル）。
 *
 * なぜ分けるか（review r2 H3）: 有報の「事業等のリスク」「MD&A」には「割高」「下値」「配分」が
 * 普通に出る。パネル全体を対象にすると、機能の芯である証拠段落そのものが捨てられる。
 * かといって実装者の裁量で除外すると線が緩む。だから**型で**分ける。
 */
import { findVocabularyHits, OUTPUT_LISTS, type VocabularyHit } from './vocabulary.js';

/**
 * 逐語引用。linter はこの形の値の中身を**走査しない**。
 * 有報の段落と upstream（EDINET DB）の開示タイトルの両方をこの形で持つ。
 */
export interface QuotedText {
  kind: 'quote';
  /** 逐語。編集・要約してはいけない（したら当社生成 = 走査対象になる） */
  text: string;
  /** 有報の場合の書類 ID */
  doc_id?: string;
  /** どこから来た逐語か（'edinet' | 'edinetdb-events' など） */
  source?: string;
}

export function quote(text: string, meta?: { doc_id?: string; source?: string }): QuotedText {
  return { kind: 'quote', text, ...meta };
}

export function isQuoted(value: unknown): value is QuotedText {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'quote' &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}

export interface LintFinding extends VocabularyHit {
  /** 値の在処（`panel.summary`、`groups[0].name` など） */
  path: string;
  /** 一致の前後 20 字 */
  excerpt: string;
}

export interface LintResult {
  clean: boolean;
  findings: LintFinding[];
}

/**
 * 当社生成の出力（パネルのノード配列・記録 JSON・1 本の文字列）を走査する。
 *
 * @param value 走査対象。`{kind:'quote'}` の値は中身ごと飛ばす
 * @param path  在処のラベル（再帰で伸びる）
 */
export function lintOutput(value: unknown, path = '$'): LintResult {
  const findings: LintFinding[] = [];
  walk(value, path, findings);
  return { clean: findings.length === 0, findings };
}

function walk(value: unknown, path: string, out: LintFinding[]): void {
  if (isQuoted(value)) {
    // 逐語引用は走査しない。ただし逐語に添えた当社生成のメタ（source 等）は文字列なので
    // ここで止めてよい（doc_id / source は当社の固定語彙で、利用者に見せる散文ではない）。
    return;
  }
  if (typeof value === 'string') {
    for (const hit of findVocabularyHits(value, OUTPUT_LISTS)) {
      out.push({
        ...hit,
        path,
        excerpt: value.slice(Math.max(0, hit.index - 20), hit.index + hit.term.length + 20),
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, out));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      walk(child, `${path}.${key}`, out);
    }
  }
}

/**
 * LLM の要約に禁止語が出たら**要約を捨てる**（design §4.2）。
 * パネル本体（原文と段落）は残す = 芯の証拠は捨てない。
 *
 * @returns 採用してよい要約、または捨てた理由
 */
export function acceptSummary(
  summary: string | null | undefined,
): { accepted: string } | { accepted: null; droppedBecause: LintFinding[] } {
  if (!summary) return { accepted: null, droppedBecause: [] };
  const result = lintOutput(summary, '$.summary');
  if (result.clean) return { accepted: summary };
  return { accepted: null, droppedBecause: result.findings };
}

/**
 * テスト・CI 用。当社生成の出力に禁止語があれば投げる。
 * 呼び出し側（パネル組み立ての最後・記録の書き出し前）で使う。
 */
export function assertOutputClean(value: unknown, label: string): void {
  const result = lintOutput(value, label);
  if (!result.clean) {
    const detail = result.findings
      .map(f => `${f.path}: 「${f.term}」(${f.list}) … ${f.excerpt}`)
      .join(' / ');
    throw new Error(`出力に使えない語が含まれています（${label}）: ${detail}`);
  }
}
