import { describe, expect, test } from 'bun:test';
import { previousFiscalPeriod, verifyNumericClaim } from './numeric-check.js';
import type { FinancialSeries, NumericClaim } from './types.js';

function claim(overrides: Partial<NumericClaim> = {}): NumericClaim {
  return {
    kind: 'numeric',
    id: 'n1',
    company: 'トヨタ自動車株式会社',
    metric: 'operating_income',
    period: 'FY2026',
    basis: 'consolidated',
    unit: '億円',
    operator: 'eq',
    value: 37662,
    ...overrides,
  };
}

describe('previousFiscalPeriod', () => {
  test('decrements the fiscal year', () => {
    expect(previousFiscalPeriod('FY2026')).toBe('FY2025');
  });

  test('returns null for an unparseable period', () => {
    expect(previousFiscalPeriod('Q4 FY2026')).toBeNull();
  });
});

describe('verifyNumericClaim — basic match/mismatch', () => {
  test('matches when the fact equals the claimed value within tolerance', () => {
    const series: FinancialSeries = [
      { company: 'トヨタ自動車株式会社', metric: 'operating_income', period: 'FY2026', basis: 'consolidated', unit: '億円', value: 37662 },
    ];
    expect(verifyNumericClaim(claim(), series).result).toBe('match');
  });

  test('mismatches when the fact differs from the claimed value', () => {
    const series: FinancialSeries = [
      { company: 'トヨタ自動車株式会社', metric: 'operating_income', period: 'FY2026', basis: 'consolidated', unit: '億円', value: 10000 },
    ];
    expect(verifyNumericClaim(claim(), series).result).toBe('mismatch');
  });

  test('unverifiable when no fact matches at all', () => {
    const result = verifyNumericClaim(claim(), []);
    expect(result.result).toBe('unverifiable');
    expect(result.reason).toBe('no_matching_fact');
  });
});

describe('★ NULL is not read as 0', () => {
  test('a fact on record as null resolves to unverifiable, not to a comparison against 0', () => {
    const series: FinancialSeries = [
      { company: 'トヨタ自動車株式会社', metric: 'operating_income', period: 'FY2026', basis: 'consolidated', unit: '億円', value: null },
    ];
    const result = verifyNumericClaim(claim({ operator: 'eq', value: 0 }), series);
    expect(result.result).toBe('unverifiable');
    expect(result.reason).toBe('fact_value_is_null');
  });
});

describe('★ period mismatch resolves to unverifiable, never to the wrong period\'s fact', () => {
  // The FY2026 fact is listed FIRST on purpose: Array.prototype.find returns
  // the first match, so if `period` were ever dropped from the lookup
  // predicate, "first company+metric+basis match" would silently resolve to
  // the FY2026 fact (37662) here — a different value from what the FY2025
  // claim asserts (47955) — flipping the result from match to mismatch.
  // Putting the correct-period fact second means this test only passes when
  // the lookup genuinely filters on period, regardless of array order.
  const series: FinancialSeries = [
    { company: 'トヨタ自動車株式会社', metric: 'operating_income', period: 'FY2026', basis: 'consolidated', unit: '億円', value: 37662 },
    { company: 'トヨタ自動車株式会社', metric: 'operating_income', period: 'FY2025', basis: 'consolidated', unit: '億円', value: 47955 },
  ];

  test('a claim about FY2025 matches the FY2025 fact, not the FY2026 one listed first', () => {
    const result = verifyNumericClaim(claim({ period: 'FY2025', value: 47955 }), series);
    expect(result.result).toBe('match');
    expect(result.matchedFact?.period).toBe('FY2025');
  });

  test('a claim about a period with no fact at all is unverifiable, not matched to a neighboring period', () => {
    const result = verifyNumericClaim(claim({ period: 'FY2024', value: 47955 }), series);
    expect(result.result).toBe('unverifiable');
    expect(result.reason).toBe('no_matching_fact');
  });
});

describe('★ basis (連結/単体) mismatch resolves to unverifiable, never crosses basis', () => {
  test('a consolidated claim does not match against the standalone fact', () => {
    const series: FinancialSeries = [
      { company: 'トヨタ自動車株式会社', metric: 'operating_income', period: 'FY2026', basis: 'standalone', unit: '億円', value: 37662 },
    ];
    // Only a standalone fact exists; the claim asks for consolidated. There
    // is no consolidated fact to compare against, so this must be
    // unverifiable — not a match found by ignoring basis.
    const result = verifyNumericClaim(claim({ basis: 'consolidated', value: 37662 }), series);
    expect(result.result).toBe('unverifiable');
    expect(result.reason).toBe('no_matching_fact');
  });

  test('consolidated and standalone facts for the same period can disagree, and the right one is picked', () => {
    const series: FinancialSeries = [
      { company: 'トヨタ自動車株式会社', metric: 'operating_income', period: 'FY2026', basis: 'consolidated', unit: '億円', value: 37662 },
      { company: 'トヨタ自動車株式会社', metric: 'operating_income', period: 'FY2026', basis: 'standalone', unit: '億円', value: 9000 },
    ];
    const result = verifyNumericClaim(claim({ basis: 'standalone', value: 9000 }), series);
    expect(result.result).toBe('match');
    expect(result.matchedFact?.basis).toBe('standalone');
  });
});

describe('★ unit mismatch is converted, never compared as raw numbers', () => {
  test('100億円 (fact) equals 10,000百万円 (claim) after conversion', () => {
    const series: FinancialSeries = [
      { company: 'トヨタ自動車株式会社', metric: 'operating_income', period: 'FY2026', basis: 'consolidated', unit: '億円', value: 100 },
    ];
    // Raw numbers 100 vs 10000 look wildly different; only after converting
    // both to the same base unit do they agree (100億円 = 10,000百万円).
    const result = verifyNumericClaim(claim({ unit: '百万円', value: 10000 }), series);
    expect(result.result).toBe('match');
  });

  test('an unrecognized unit is unverifiable rather than compared as a raw number', () => {
    const series: FinancialSeries = [
      { company: 'トヨタ自動車株式会社', metric: 'operating_income', period: 'FY2026', basis: 'consolidated', unit: 'USD', value: 100 },
    ];
    const result = verifyNumericClaim(claim({ unit: '億円', value: 100 }), series);
    expect(result.result).toBe('unverifiable');
    expect(result.reason).toBe('unit_not_comparable');
  });
});

describe('yoy_increase / yoy_decrease operators', () => {
  const series: FinancialSeries = [
    { company: 'トヨタ自動車株式会社', metric: 'operating_income', period: 'FY2025', basis: 'consolidated', unit: '億円', value: 47955 },
    { company: 'トヨタ自動車株式会社', metric: 'operating_income', period: 'FY2026', basis: 'consolidated', unit: '億円', value: 37662 },
  ];

  test('matches yoy_decrease when the current period fact is lower than the prior period', () => {
    const result = verifyNumericClaim(claim({ operator: 'yoy_decrease', value: 0, unit: '億円' }), series);
    expect(result.result).toBe('match');
    expect(result.comparisonFact?.period).toBe('FY2025');
  });

  test('mismatches yoy_increase for the same data (actual direction is a decrease)', () => {
    const result = verifyNumericClaim(claim({ operator: 'yoy_increase', value: 0, unit: '億円' }), series);
    expect(result.result).toBe('mismatch');
  });

  test('unverifiable when there is no prior-period fact', () => {
    const onlyCurrent: FinancialSeries = [series[1]];
    const result = verifyNumericClaim(claim({ operator: 'yoy_decrease', value: 0, unit: '億円' }), onlyCurrent);
    expect(result.result).toBe('unverifiable');
    expect(result.reason).toBe('no_prior_period_fact');
  });
});
