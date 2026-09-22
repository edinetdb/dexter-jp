/**
 * Pure numeric claim verification against financial data supplied by the
 * caller (T3 wires this to get_financial_statements — this module never
 * fetches anything itself).
 *
 * design-v0.md §4.2: "数値の主張は {会社, 指標, 期間, 連結/単体, 単位,
 * 演算子, 値, 出典} に落とせたものだけ検算する… 結果は一致 / 不一致 /
 * 検算不能"
 *
 * Three-way result, never two: a claim whose company/metric/period/basis
 * does not resolve to exactly one fact, or whose fact is on record as null
 * (disclosed as not applicable / not available), is 検算不能 — never
 * silently treated as 0 and never silently matched to the wrong period,
 * basis, or unit.
 */

import type { FinancialBasis, FinancialFact, FinancialSeries, NumericClaim, NumericCheckResult } from './types.js';

export interface NumericVerification {
  result: NumericCheckResult;
  claimId: string;
  matchedFact?: FinancialFact;
  /** The prior-period fact used for yoy_increase / yoy_decrease claims. */
  comparisonFact?: FinancialFact;
  reason?:
    | 'no_matching_fact'
    | 'fact_value_is_null'
    | 'unit_not_comparable'
    | 'period_not_parseable'
    | 'no_prior_period_fact'
    | 'flat'
    | 'unsupported_operator';
}

// ---------------------------------------------------------------------------
// Unit conversion — yen-denominated units only need a scale; percent is
// compared directly. An unrecognized unit is 検算不能, never assumed equal.
// ---------------------------------------------------------------------------

const YEN_UNIT_SCALE: Record<string, number> = {
  円: 1,
  千円: 1e3,
  百万円: 1e6,
  億円: 1e8,
  兆円: 1e12,
};

const PERCENT_UNITS = new Set(['%', '％']);

function toComparableValue(value: number, unit: string): number | null {
  if (PERCENT_UNITS.has(unit)) return value;
  const scale = YEN_UNIT_SCALE[unit];
  if (scale == null) return null;
  return value * scale;
}

// ---------------------------------------------------------------------------
// Fact lookup — every dimension (company, metric, period, basis) must match
// exactly. Dropping any one of these from the lookup is exactly the kind of
// mistake that silently pairs a claim with the wrong fact.
// ---------------------------------------------------------------------------

function findFact(
  series: FinancialSeries,
  company: string,
  metric: string,
  period: string,
  basis: FinancialBasis
): FinancialFact | undefined {
  return series.find(
    (f) => f.company === company && f.metric === metric && f.period === period && f.basis === basis
  );
}

const FISCAL_YEAR_PATTERN = /^FY(\d{4})$/;

export function previousFiscalPeriod(period: string): string | null {
  const m = period.match(FISCAL_YEAR_PATTERN);
  if (!m) return null;
  return `FY${Number(m[1]) - 1}`;
}

/** Relative tolerance for rounding noise between a claim's stated figure and
 * the underlying fact (有報 prose rounds to the nearest 億円 etc.). */
const TOLERANCE_RATIO = 0.005;

export function verifyNumericClaim(claim: NumericClaim, series: FinancialSeries): NumericVerification {
  const fact = findFact(series, claim.company, claim.metric, claim.period, claim.basis);
  if (!fact) {
    return { result: 'unverifiable', claimId: claim.id, reason: 'no_matching_fact' };
  }
  if (fact.value == null) {
    // Disclosed-as-null must never be read as 0.
    return { result: 'unverifiable', claimId: claim.id, matchedFact: fact, reason: 'fact_value_is_null' };
  }
  const rawFactValue: number = fact.value;

  if (claim.operator === 'yoy_increase' || claim.operator === 'yoy_decrease') {
    return verifyYoyClaim(claim, series, fact, rawFactValue);
  }

  const claimValue = toComparableValue(claim.value, claim.unit);
  const factValue = toComparableValue(rawFactValue, fact.unit);
  if (claimValue == null || factValue == null) {
    return { result: 'unverifiable', claimId: claim.id, matchedFact: fact, reason: 'unit_not_comparable' };
  }

  const tolerance = Math.max(Math.abs(factValue) * TOLERANCE_RATIO, Number.EPSILON);
  let matched: boolean;
  switch (claim.operator) {
    case 'eq':
      matched = Math.abs(claimValue - factValue) <= tolerance;
      break;
    case 'gt':
      matched = factValue > claimValue;
      break;
    case 'gte':
      matched = factValue >= claimValue;
      break;
    case 'lt':
      matched = factValue < claimValue;
      break;
    case 'lte':
      matched = factValue <= claimValue;
      break;
    default:
      return { result: 'unverifiable', claimId: claim.id, matchedFact: fact, reason: 'unsupported_operator' };
  }
  return { result: matched ? 'match' : 'mismatch', claimId: claim.id, matchedFact: fact };
}

function verifyYoyClaim(
  claim: NumericClaim,
  series: FinancialSeries,
  fact: FinancialFact,
  factValue: number
): NumericVerification {
  const prevPeriod = previousFiscalPeriod(claim.period);
  if (!prevPeriod) {
    return { result: 'unverifiable', claimId: claim.id, matchedFact: fact, reason: 'period_not_parseable' };
  }
  const prevFact = findFact(series, claim.company, claim.metric, prevPeriod, claim.basis);
  if (!prevFact || prevFact.value == null) {
    return { result: 'unverifiable', claimId: claim.id, matchedFact: fact, reason: 'no_prior_period_fact' };
  }
  const prevValue: number = prevFact.value;

  const direction: 'yoy_increase' | 'yoy_decrease' | null =
    factValue > prevValue ? 'yoy_increase' : factValue < prevValue ? 'yoy_decrease' : null;

  if (direction == null) {
    return {
      result: 'mismatch',
      claimId: claim.id,
      matchedFact: fact,
      comparisonFact: prevFact,
      reason: 'flat',
    };
  }
  return {
    result: direction === claim.operator ? 'match' : 'mismatch',
    claimId: claim.id,
    matchedFact: fact,
    comparisonFact: prevFact,
  };
}
