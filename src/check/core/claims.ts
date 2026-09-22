/**
 * Pure post-processing of claims after the LLM has split a hypothesis into
 * them. Nothing here calls a model or a judge — it only takes the model's
 * raw claim output (or, for resolveClaim, the judge's verdicts) and applies
 * the rules design-v0.md §4.2 requires:
 *
 *   - 主張の分解は仮説を別の命題に変えない（否定はフラグで持ち、判定は肯定形→コードが反転）
 *   - 「A だけ」は「A が寄与した」+「A 以外は寄与していない」の2主張に分け、
 *     後者が段落から確かめられなければ未判定
 *   - 「主因」「一過性」など程度を含む語は外さない
 *   - 期間と会社名は主張に明示。意味を保てない主張は未判定
 *   - 因果を含む主張は数値部分と文章部分に分ける
 */

import type {
  Claim,
  ClaimKind,
  FinancialBasis,
  NumericClaim,
  NumericOperator,
  RawClaimFromModel,
  Verdict,
} from './types.js';

// ---------------------------------------------------------------------------
// Negation: judging always happens in positive form; this is the only place
// a verdict gets flipped for a negated claim. `unrelated` never flips.
// ---------------------------------------------------------------------------

export function applyNegation(negated: boolean, verdict: Verdict): Verdict {
  if (!negated) return verdict;
  if (verdict === 'supports') return 'contradicts';
  if (verdict === 'contradicts') return 'supports';
  return verdict; // 'unrelated' is not a direction, so negation does not touch it
}

export interface ParagraphJudgment {
  paragraphId: string;
  verdict: Verdict;
  confidence: number;
}

export interface ClaimResolution {
  status: 'confirmed' | 'unresolved';
  /** Only set when every confirming paragraph agrees on one direction. */
  verdict?: 'supports' | 'contradicts';
  supportingParagraphIds: string[];
  contradictingParagraphIds: string[];
}

export const DEFAULT_CONFIRMATION_THRESHOLD = 0.8;

/**
 * Aggregates per-paragraph judge verdicts for one claim into a final
 * resolution, applying negation and the threshold. This is the general rule
 * behind 判定不能 condition (2): "裏付け・食い違いと確定した段落が0" — and it
 * is also what makes an exclusivity claim ("A 以外は寄与していない") resolve
 * to 未判定 when no paragraph confirms or denies it: it is judged with the
 * same rule as any other claim, nothing exclusivity-specific is needed here.
 */
export function resolveClaim(
  claim: Pick<Claim, 'negated'>,
  judgments: ParagraphJudgment[],
  threshold = DEFAULT_CONFIRMATION_THRESHOLD
): ClaimResolution {
  const supportingParagraphIds: string[] = [];
  const contradictingParagraphIds: string[] = [];
  for (const j of judgments) {
    if (j.confidence < threshold) continue;
    const applied = applyNegation(claim.negated, j.verdict);
    if (applied === 'supports') supportingParagraphIds.push(j.paragraphId);
    else if (applied === 'contradicts') contradictingParagraphIds.push(j.paragraphId);
  }
  if (supportingParagraphIds.length === 0 && contradictingParagraphIds.length === 0) {
    return { status: 'unresolved', supportingParagraphIds, contradictingParagraphIds };
  }
  const verdict: ClaimResolution['verdict'] =
    contradictingParagraphIds.length > 0 && supportingParagraphIds.length === 0
      ? 'contradicts'
      : supportingParagraphIds.length > 0 && contradictingParagraphIds.length === 0
        ? 'supports'
        : undefined; // mixed evidence — caller shows both lists rather than one verdict
  return { status: 'confirmed', verdict, supportingParagraphIds, contradictingParagraphIds };
}

// ---------------------------------------------------------------------------
// Degree / hedge words — must survive normalization untouched.
// ---------------------------------------------------------------------------

export const DEGREE_WORDS = [
  '主因',
  '主たる要因',
  '主要因',
  '一因',
  '一過性',
  '一時的',
  '大幅',
  '継続的',
  '構造的',
  'ほぼ全て',
  '大部分',
] as const;

export function extractDegreeWords(text: string): string[] {
  return DEGREE_WORDS.filter((w) => text.includes(w));
}

/**
 * Whitespace-only normalization. Must never remove content — degree words in
 * particular must survive this unchanged (design: "程度を含む語は外さない").
 */
function normalizeClaimText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Base claim construction
// ---------------------------------------------------------------------------

function buildBaseClaim(raw: RawClaimFromModel, id: string, kind: ClaimKind = 'qualitative'): Claim {
  return {
    id,
    quote: raw.quote,
    text: normalizeClaimText(raw.text),
    negated: raw.negated ?? false,
    kind,
    company: raw.company,
    period: raw.period,
    degreeWords: extractDegreeWords(raw.text),
  };
}

// ---------------------------------------------------------------------------
// "A だけ" splitting
// ---------------------------------------------------------------------------

const ONLY_PATTERN = /^(.*?)(だけ|のみ)(.*)$/;
const TRAILING_PARTICLES = /[はがのにでを、,\s]+$/u;

/**
 * Splits a claim containing "だけ"/"のみ" into the contribution claim ("A が
 * 寄与した") and the exclusivity claim ("A 以外は寄与していない"). If "だけ"
 * is not present, returns the single unsplit claim.
 */
export function splitOnlyClaim(raw: RawClaimFromModel, idPrefix: string): Claim[] {
  const base = buildBaseClaim(raw, `${idPrefix}-1`);
  const match = raw.text.match(ONLY_PATTERN);
  if (!match) return [base];

  const [, before, , after] = match;
  const factor = before.trim().replace(TRAILING_PARTICLES, '');
  if (!factor) return [base]; // nothing identifiable to split on — leave as-is

  const contribution: Claim = {
    ...base,
    id: `${idPrefix}-only-contribution`,
    text: normalizeClaimText(`${factor}が寄与した${after.trim()}`),
  };
  const exclusivity: Claim = {
    ...base,
    id: `${idPrefix}-only-exclusivity`,
    text: `${factor}以外の要因は寄与していない`,
    exclusivity: true,
    derivedFrom: contribution.id,
  };
  return [contribution, exclusivity];
}

// ---------------------------------------------------------------------------
// Explicit scope requirement (company + period)
// ---------------------------------------------------------------------------

export function requireExplicitScope(claim: Claim): Claim {
  if (claim.unresolvable) return claim;
  if (!claim.company) return { ...claim, unresolvable: { reason: 'missing_company' } };
  if (!claim.period) return { ...claim, unresolvable: { reason: 'missing_period' } };
  return claim;
}

/**
 * Full pipeline for one raw model claim: split "だけ" claims, then require
 * explicit company + period on every resulting claim.
 */
export function extractClaims(raw: RawClaimFromModel, idPrefix: string): Claim[] {
  return splitOnlyClaim(raw, idPrefix).map(requireExplicitScope);
}

// ---------------------------------------------------------------------------
// Numeric claim construction — validates a structured numeric claim the
// model attempted; does not parse free Japanese prose into numbers itself.
// A claim that cannot be fully mapped to {company, metric, period, 連結/単体,
// 単位, 演算子, 値, 出典} stays qualitative / falls back to 検算不能 upstream.
// ---------------------------------------------------------------------------

export interface RawNumericFields {
  company?: string;
  metric?: string;
  period?: string;
  basis?: string;
  unit?: string;
  operator?: string;
  value?: number | string;
  source?: string;
}

const FULLWIDTH_DIGITS = '０１２３４５６７８９';

function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (ch) => String(FULLWIDTH_DIGITS.indexOf(ch)));
}

export function parseJapaneseNumber(raw: string): number {
  return parseFloat(toHalfWidthDigits(raw).replace(/[,，]/g, ''));
}

const OPERATOR_ALIASES: Record<string, NumericOperator> = {
  eq: 'eq',
  '=': 'eq',
  一致: 'eq',
  gt: 'gt',
  '>': 'gt',
  超: 'gt',
  上回る: 'gt',
  gte: 'gte',
  '>=': 'gte',
  以上: 'gte',
  lt: 'lt',
  '<': 'lt',
  未満: 'lt',
  下回る: 'lt',
  lte: 'lte',
  '<=': 'lte',
  以下: 'lte',
  yoy_increase: 'yoy_increase',
  増加: 'yoy_increase',
  増益: 'yoy_increase',
  増収: 'yoy_increase',
  yoy_decrease: 'yoy_decrease',
  減少: 'yoy_decrease',
  減益: 'yoy_decrease',
  減収: 'yoy_decrease',
};

function normalizeOperator(op: string | undefined): NumericOperator | null {
  if (!op) return null;
  return OPERATOR_ALIASES[op] ?? null;
}

function normalizeBasis(basis: string | undefined): FinancialBasis | null {
  if (basis === 'consolidated' || basis === '連結') return 'consolidated';
  if (basis === 'standalone' || basis === '単体') return 'standalone';
  return null;
}

/**
 * Attempts to build a fully-structured NumericClaim from whatever fields the
 * model supplied. Returns null — never a partially-filled claim — when any
 * of the required fields (会社/指標/期間/連結・単体/単位/演算子/値) is
 * missing or unparseable. A null result means: leave this as a qualitative
 * claim, do not attempt numeric verification.
 */
export function tryBuildNumericClaim(raw: RawNumericFields, id: string): NumericClaim | null {
  const basis = normalizeBasis(raw.basis);
  const operator = normalizeOperator(raw.operator);
  const value =
    typeof raw.value === 'number'
      ? raw.value
      : typeof raw.value === 'string'
        ? parseJapaneseNumber(raw.value)
        : null;

  if (
    !raw.company ||
    !raw.metric ||
    !raw.period ||
    !basis ||
    !raw.unit ||
    !operator ||
    value == null ||
    Number.isNaN(value)
  ) {
    return null;
  }

  return {
    kind: 'numeric',
    id,
    company: raw.company,
    metric: raw.metric,
    period: raw.period,
    basis,
    unit: raw.unit,
    operator,
    value,
    source: raw.source,
  };
}

// ---------------------------------------------------------------------------
// Causal claim splitting — a claim that argues cause-and-effect and also
// carries an embedded number is split into a textual (qualitative/causal)
// claim and, if it maps cleanly, a numeric claim.
// ---------------------------------------------------------------------------

export interface RawCausalClaimFromModel extends RawClaimFromModel {
  numeric?: RawNumericFields;
}

export interface CausalSplit {
  textual: Claim;
  numeric?: NumericClaim;
}

export function splitCausalClaim(raw: RawCausalClaimFromModel, idPrefix: string): CausalSplit {
  const textual = requireExplicitScope(buildBaseClaim(raw, `${idPrefix}-causal`, 'causal'));
  if (!raw.numeric) return { textual };

  const numeric = tryBuildNumericClaim(
    { company: raw.company, ...raw.numeric },
    `${idPrefix}-numeric`
  );
  return numeric ? { textual, numeric: { ...numeric, derivedFrom: textual.id } } : { textual };
}
