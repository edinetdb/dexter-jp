/**
 * Pure types for the /check "answer matching" pipeline post-processing.
 *
 * Nothing in src/check/core/ does network or file I/O. LLM calls (the judge
 * that assigns supports/contradicts/unrelated to a claim×paragraph pair) live
 * outside this directory; these types describe what goes in and out of that
 * step so the post-processing here can stay pure and unit-testable.
 *
 * See design-v0.md §4.2 for the source of truth these types encode.
 */

/** A judge verdict for one claim against one paragraph, before negation is applied. */
export type Verdict = 'supports' | 'contradicts' | 'unrelated';

/** The three-way result of checking a numeric claim against financial data. */
export type NumericCheckResult = 'match' | 'mismatch' | 'unverifiable';

export type ClaimKind = 'qualitative' | 'numeric' | 'causal';

/**
 * What the model returns when it splits a hypothesis into claims. This is the
 * *input* to this module's post-processing — the raw, possibly sloppy output
 * of an LLM call, not yet safe to act on.
 */
export interface RawClaimFromModel {
  /** Verbatim excerpt of the hypothesis text this claim was derived from. */
  quote: string;
  /**
   * The claim as the model phrased it. May be negative ("減益は一時的では
   * ない"). Post-processing does not rewrite this into positive form — it
   * records the negation separately via `negated` and leaves `text` as the
   * model gave it, phrased however makes the positive-form judging clean.
   */
  text: string;
  /** True if the model marked this as an inherently negative assertion. */
  negated?: boolean;
  /** Company name, if the model captured one explicitly in the claim. */
  company?: string;
  /** Fiscal period, if the model captured one explicitly in the claim. */
  period?: string;
  /**
   * Set by the caller (not the model) when `quote` was not found verbatim in the
   * hypothesis and was replaced by the whole hypothesis (Codex T9 M2).
   */
  quoteNotVerbatim?: boolean;
}

/** Why a claim could not be carried forward to judging. */
export interface UnresolvableReason {
  reason:
    | 'missing_company'
    | 'missing_period'
    | 'exclusivity_unconfirmed'
    | 'meaning_not_preserved';
  detail?: string;
}

/**
 * A claim ready to be judged against paragraphs (or already found
 * unresolvable during post-processing, in which case it must not be sent to
 * a judge at all — it goes straight to "未判定").
 */
export interface Claim {
  id: string;
  /** Verbatim excerpt of the hypothesis text this claim was derived from. */
  quote: string;
  /** The claim, phrased positively; judging happens in positive form. */
  text: string;
  /** True if the source assertion was negative; judge verdicts must flip. */
  negated: boolean;
  kind: ClaimKind;
  company?: string;
  period?: string;
  /**
   * Degree / hedge words preserved verbatim from the source (主因, 一過性,
   * 大幅, etc.) — these must never be stripped out during normalization.
   */
  degreeWords: string[];
  /** id of the parent claim, if this claim was produced by splitting one. */
  derivedFrom?: string;
  /**
   * True for the second half of an "A だけ" split: the claim that "nothing
   * else contributed." This half is unresolvable unless a paragraph
   * affirmatively rules out other causes — see resolveExclusivityClaim.
   */
  exclusivity?: boolean;
  unresolvable?: UnresolvableReason;
}

export type NumericOperator =
  | 'eq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'yoy_increase'
  | 'yoy_decrease';

export type FinancialBasis = 'consolidated' | 'standalone';

/** The structured shape a numeric claim must reach before it can be checked. */
export interface NumericClaim {
  kind: 'numeric';
  id: string;
  company: string;
  metric: string;
  period: string;
  basis: FinancialBasis;
  unit: string;
  operator: NumericOperator;
  value: number;
  source?: string;
  derivedFrom?: string;
}

/**
 * One fact from financial data, passed in by the caller (T3 wires this to
 * get_financial_statements). This module never fetches data itself.
 */
export interface FinancialFact {
  company: string;
  edinetCode?: string;
  /** Canonical metric key, e.g. 'operating_income'. */
  metric: string;
  /** Fiscal period identifier, e.g. 'FY2026'. */
  period: string;
  basis: FinancialBasis;
  unit: string;
  /**
   * null means: the fact is on record as "not disclosed / not applicable"
   * for this company×metric×period×basis, distinct from "no such fact at
   * all" (which is simply absent from the array). Both cases must resolve
   * to 'unverifiable', never to a comparison against 0.
   */
  value: number | null;
}

export type FinancialSeries = FinancialFact[];

/** A segment of 有報 text, ready to be shown/judged as one evidence unit. */
export interface Paragraph {
  id: string;
  docId: string;
  /** 提出者 (filer name as it appears in the 有報), defaults to `company` if omitted upstream. */
  filer?: string;
  company: string;
  edinetCode?: string;
  /** 書類種別, e.g. '有価証券報告書'. */
  docType?: string;
  /** e.g. 'mda' | 'risks' | 'policy' */
  section: string;
  fiscalYear?: number;
  text: string;
}

export interface DuplicateDecision {
  isDuplicate: boolean;
  similarity: number;
  reason?: 'opposite_polarity' | 'below_threshold';
}
