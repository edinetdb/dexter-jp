import { describe, test, expect } from 'bun:test';
import { extractSectionHtml, sectionsForForm, TEN_K_SECTIONS, TEN_Q_SECTIONS } from './sec-edgar-sections.js';

describe('extractSectionHtml', () => {
  test('extracts the section between start and end markers', () => {
    const html = `
      <p>Item 1A. Risk Factors</p>
      <p>Some risk content here.</p>
      <p>Item 1B. Unresolved Staff Comments</p>
      <p>Unrelated content.</p>
    `;
    const result = extractSectionHtml(html, TEN_K_SECTIONS.risk_factors);
    expect(result).not.toBeNull();
    expect(result).toContain('Some risk content here.');
    expect(result).not.toContain('Unrelated content.');
  });

  test('uses the last occurrence of the start marker (skips table-of-contents entries)', () => {
    // 目次に1回、本文に1回登場する典型的な10-Kの構造を再現
    const html = `
      <p>Item 1A. Risk Factors ... 15</p>
      <p>(table of contents, no real content here)</p>
      <p>Item 1A. Risk Factors</p>
      <p>Actual risk factor content.</p>
      <p>Item 1B.</p>
    `;
    const result = extractSectionHtml(html, TEN_K_SECTIONS.risk_factors);
    expect(result).toContain('Actual risk factor content.');
    expect(result).not.toContain('table of contents');
  });

  test('returns null when the start marker is not found', () => {
    const html = '<p>This document has no Item headers at all.</p>';
    const result = extractSectionHtml(html, TEN_K_SECTIONS.risk_factors);
    expect(result).toBeNull();
  });

  test('falls back to end of document when the end marker is missing', () => {
    const html = '<p>Item 1A. Risk Factors</p><p>Content with no end marker.</p>';
    const result = extractSectionHtml(html, TEN_K_SECTIONS.risk_factors);
    expect(result).not.toBeNull();
    expect(result).toContain('Content with no end marker.');
  });

  test('caps section length to avoid runaway extraction', () => {
    const hugeContent = 'x'.repeat(600_000);
    const html = `Item 1A. Risk Factors ${hugeContent} Item 1B.`;
    const result = extractSectionHtml(html, TEN_K_SECTIONS.risk_factors);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(500_000);
  });
});

describe('sectionsForForm', () => {
  test('returns 10-K sections (including business) for "10-K"', () => {
    const sections = sectionsForForm('10-K');
    expect(sections).toBe(TEN_K_SECTIONS);
    expect(Object.keys(sections)).toContain('business');
  });

  test('returns 10-Q sections (no business section) for "10-Q"', () => {
    const sections = sectionsForForm('10-Q');
    expect(sections).toBe(TEN_Q_SECTIONS);
    expect(Object.keys(sections)).not.toContain('business');
  });

  test('is case-insensitive', () => {
    expect(sectionsForForm('10-q')).toBe(TEN_Q_SECTIONS);
    expect(sectionsForForm('10-k')).toBe(TEN_K_SECTIONS);
  });

  test('defaults to 10-K sections for unknown form types', () => {
    expect(sectionsForForm('8-K')).toBe(TEN_K_SECTIONS);
  });
});
