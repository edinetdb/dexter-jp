import { describe, expect, test } from 'bun:test';
import {
  applyNegation,
  extractClaims,
  extractDegreeWords,
  requireExplicitScope,
  resolveClaim,
  splitCausalClaim,
  splitOnlyClaim,
  tryBuildNumericClaim,
  type ParagraphJudgment,
} from './claims.js';
import type { Claim, RawClaimFromModel } from './types.js';

function rawClaim(overrides: Partial<RawClaimFromModel> = {}): RawClaimFromModel {
  return {
    quote: '米国関税の影響だけが営業利益減少の要因である',
    text: '米国関税の影響だけが営業利益減少の要因である',
    company: 'トヨタ自動車株式会社',
    period: 'FY2026',
    ...overrides,
  };
}

describe('applyNegation', () => {
  test('flips supports to contradicts when the claim is negated', () => {
    expect(applyNegation(true, 'supports')).toBe('contradicts');
  });

  test('flips contradicts to supports when the claim is negated', () => {
    expect(applyNegation(true, 'contradicts')).toBe('supports');
  });

  test('never flips unrelated', () => {
    expect(applyNegation(true, 'unrelated')).toBe('unrelated');
  });

  test('passes verdicts through unchanged when not negated', () => {
    expect(applyNegation(false, 'supports')).toBe('supports');
    expect(applyNegation(false, 'contradicts')).toBe('contradicts');
    expect(applyNegation(false, 'unrelated')).toBe('unrelated');
  });
});

describe('resolveClaim (negation applied through aggregation)', () => {
  const judgments: ParagraphJudgment[] = [{ paragraphId: 'p1', verdict: 'supports', confidence: 0.9 }];

  test('a negated claim confirmed by a supporting paragraph resolves to contradicts', () => {
    const res = resolveClaim({ negated: true }, judgments);
    expect(res.status).toBe('confirmed');
    expect(res.verdict).toBe('contradicts');
  });

  test('a non-negated claim confirmed by a supporting paragraph resolves to supports', () => {
    const res = resolveClaim({ negated: false }, judgments);
    expect(res.verdict).toBe('supports');
  });

  test('below-threshold judgments do not confirm anything (判定不能)', () => {
    const res = resolveClaim({ negated: false }, [{ paragraphId: 'p1', verdict: 'supports', confidence: 0.5 }]);
    expect(res.status).toBe('unresolved');
  });

  test('zero judgments resolve to unresolved', () => {
    const res = resolveClaim({ negated: false }, []);
    expect(res.status).toBe('unresolved');
  });
});

describe('splitOnlyClaim — "A だけ"', () => {
  test('splits into a contribution claim and an exclusivity claim', () => {
    const claims = splitOnlyClaim(rawClaim(), 'c1');
    expect(claims).toHaveLength(2);
    expect(claims[0].exclusivity).toBeFalsy();
    expect(claims[0].text).toContain('米国関税の影響が寄与した');
    expect(claims[1].exclusivity).toBe(true);
    expect(claims[1].text).toContain('以外の要因は寄与していない');
    expect(claims[1].derivedFrom).toBe(claims[0].id);
  });

  test('both halves preserve the original quote for display alongside the original text', () => {
    const claims = splitOnlyClaim(rawClaim(), 'c1');
    for (const c of claims) expect(c.quote).toBe(rawClaim().quote);
  });

  test('leaves a claim without "だけ"/"のみ" as a single claim', () => {
    const claims = splitOnlyClaim(rawClaim({ text: '営業利益は米国関税の影響で減少した', quote: '営業利益は米国関税の影響で減少した' }), 'c2');
    expect(claims).toHaveLength(1);
  });

  test('also splits on "のみ"', () => {
    const claims = splitOnlyClaim(
      rawClaim({ text: '為替のみが増収要因である', quote: '為替のみが増収要因である' }),
      'c3'
    );
    expect(claims).toHaveLength(2);
    expect(claims[1].exclusivity).toBe(true);
  });
});

describe('degree words are preserved, never stripped', () => {
  test('主因 survives into the claim text and the degreeWords list', () => {
    const claim = splitOnlyClaim(
      rawClaim({
        text: '米国関税の影響が営業利益減少の主因である',
        quote: '米国関税の影響が営業利益減少の主因である',
      }),
      'c4'
    )[0];
    expect(claim.text).toContain('主因');
    expect(extractDegreeWords(claim.text)).toContain('主因');
  });

  test('一過性 is preserved', () => {
    const words = extractDegreeWords('この減益は一過性のものである');
    expect(words).toContain('一過性');
  });
});

describe('requireExplicitScope — company and period must be explicit', () => {
  function claimWith(overrides: Partial<Claim>): Claim {
    return {
      id: 'x',
      quote: 'q',
      text: 't',
      negated: false,
      kind: 'qualitative',
      degreeWords: [],
      company: 'トヨタ自動車株式会社',
      period: 'FY2026',
      ...overrides,
    };
  }

  test('a claim with both company and period stays resolvable', () => {
    const claim = requireExplicitScope(claimWith({}));
    expect(claim.unresolvable).toBeUndefined();
  });

  test('missing company marks unresolvable', () => {
    const claim = requireExplicitScope(claimWith({ company: undefined }));
    expect(claim.unresolvable?.reason).toBe('missing_company');
  });

  test('missing period marks unresolvable', () => {
    const claim = requireExplicitScope(claimWith({ period: undefined }));
    expect(claim.unresolvable?.reason).toBe('missing_period');
  });

  test('extractClaims end-to-end marks the unscoped half of a だけ split unresolvable if scope is missing', () => {
    const claims = extractClaims(rawClaim({ company: undefined }), 'c5');
    expect(claims).toHaveLength(2);
    for (const c of claims) expect(c.unresolvable?.reason).toBe('missing_company');
  });
});

describe('tryBuildNumericClaim', () => {
  test('builds a numeric claim when all required fields are present', () => {
    const claim = tryBuildNumericClaim(
      {
        company: 'トヨタ自動車株式会社',
        metric: 'operating_income',
        period: 'FY2026',
        basis: '連結',
        unit: '億円',
        operator: '減益',
        // "３兆7,662億円" as disclosed in the 有報 equals 37,662億円; the
        // model is expected to have already canonicalized to a single
        // {値, 単位} pair before this code sees it (see the module doc —
        // this function validates a structured claim, it does not parse
        // compound Japanese numerals like "３兆7,662" out of prose).
        value: '37,662',
      },
      'n1'
    );
    expect(claim).not.toBeNull();
    expect(claim?.basis).toBe('consolidated');
    expect(claim?.operator).toBe('yoy_decrease');
    expect(claim?.value).toBeCloseTo(37662);
  });

  test('returns null when a required field is missing (falls back to qualitative)', () => {
    const claim = tryBuildNumericClaim(
      { company: 'トヨタ自動車株式会社', metric: 'operating_income', period: 'FY2026', unit: '億円', operator: '減益', value: 100 },
      'n2'
    );
    expect(claim).toBeNull();
  });

  test('returns null for an unrecognized operator rather than guessing', () => {
    const claim = tryBuildNumericClaim(
      {
        company: 'トヨタ自動車株式会社',
        metric: 'operating_income',
        period: 'FY2026',
        basis: '連結',
        unit: '億円',
        operator: 'なんとなく減った',
        value: 100,
      },
      'n3'
    );
    expect(claim).toBeNull();
  });
});

describe('splitCausalClaim — 因果を含む主張は数値部分と文章部分に分ける', () => {
  test('splits into a causal textual claim and a numeric claim when the numeric part maps cleanly', () => {
    const { textual, numeric } = splitCausalClaim(
      {
        quote: '米国関税の影響1兆3,800億円が営業利益減少の主因である',
        text: '米国関税の影響が営業利益減少の主因である',
        company: 'トヨタ自動車株式会社',
        period: 'FY2026',
        numeric: {
          metric: 'us_tariff_impact',
          period: 'FY2026',
          basis: '連結',
          unit: '億円',
          operator: 'eq',
          value: '13800',
        },
      },
      'c6'
    );
    expect(textual.kind).toBe('causal');
    expect(textual.text).toContain('主因');
    expect(numeric).toBeDefined();
    expect(numeric?.value).toBe(13800);
    expect(numeric?.derivedFrom).toBe(textual.id);
  });

  test('keeps only the textual claim when no numeric fragment was given', () => {
    const { textual, numeric } = splitCausalClaim(
      {
        quote: '需要の弱さが減益の主因である',
        text: '需要の弱さが減益の主因である',
        company: 'トヨタ自動車株式会社',
        period: 'FY2026',
      },
      'c7'
    );
    expect(numeric).toBeUndefined();
    expect(textual.kind).toBe('causal');
  });

  test('drops to textual-only when the numeric fragment cannot be fully mapped', () => {
    const { numeric } = splitCausalClaim(
      {
        quote: '諸経費の増加が営業利益減少の主因である',
        text: '諸経費の増加が営業利益減少の主因である',
        company: 'トヨタ自動車株式会社',
        period: 'FY2026',
        numeric: { metric: 'misc_expenses', unit: '億円', operator: 'eq', value: '20300' }, // no period/basis
      },
      'c8'
    );
    expect(numeric).toBeUndefined();
  });
});
