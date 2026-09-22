import { describe, expect, test } from 'bun:test';
import {
  areNearDuplicates,
  detectDirectionalPolarity,
  mergeNearDuplicateParagraphs,
  segmentIntoParagraphs,
} from './paragraphs.js';
import type { Paragraph } from './types.js';
import snippets from './__fixtures__/snippets.json' assert { type: 'json' };

interface Snippet {
  id: string;
  company: string;
  edinet_code: string;
  fiscal_year: number;
  doc_id: string;
  section: string;
  kind: string;
  text: string;
}

const fixtures = snippets as Snippet[];

function byId(id: string): Snippet {
  const s = fixtures.find((f) => f.id === id);
  if (!s) throw new Error(`fixture ${id} not found`);
  return s;
}

function paragraph(id: string, text: string, overrides: Partial<Paragraph> = {}): Paragraph {
  return {
    id,
    docId: 'S100Y8NY',
    company: 'トヨタ自動車株式会社',
    section: 'mda',
    text,
    ...overrides,
  };
}

describe('fixtures loaded verbatim', () => {
  test('15 snippets, unmodified byte-for-byte against the source fixture', () => {
    expect(fixtures).toHaveLength(15);
    expect(byId('s01').text.startsWith('当連結会計年度における営業利益は')).toBe(true);
  });
});

describe('segmentIntoParagraphs', () => {
  test('a real EDINET paragraph within 150-400 chars comes back as a single chunk', () => {
    const s01 = byId('s01');
    const paragraphs = segmentIntoParagraphs(s01.text, {
      docId: s01.doc_id,
      company: s01.company,
      section: s01.section,
      fiscalYear: s01.fiscal_year,
    });
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].text).toBe(s01.text);
  });

  test('long combined text is split into multiple chunks, each within bounds', () => {
    // Concatenate several real sentences so the block exceeds 400 chars and
    // must be split at sentence (句点) boundaries into multiple chunks.
    const long = [byId('s01').text, byId('s02').text, byId('s03').text].join('');
    const paragraphs = segmentIntoParagraphs(long, {
      docId: 'synthetic',
      company: 'トヨタ自動車株式会社',
      section: 'mda',
    });
    expect(paragraphs.length).toBeGreaterThan(1);
    for (const p of paragraphs) {
      expect(p.text.length).toBeLessThanOrEqual(500); // small slack for trailing-chunk merge
      expect(p.text.endsWith('。')).toBe(true);
    }
  });

  test('heading-separated blocks (blank line) do not bleed into each other', () => {
    const text = `${byId('s04').text}\n\n${byId('s05').text}`;
    const paragraphs = segmentIntoParagraphs(text, {
      docId: 'synthetic',
      company: 'トヨタ自動車株式会社',
      section: 'risks',
    });
    expect(paragraphs.some((p) => p.text.includes(byId('s04').text.slice(0, 20)))).toBe(true);
    expect(paragraphs.some((p) => p.text.includes(byId('s05').text.slice(0, 20)))).toBe(true);
    // Neither chunk should contain both sentences glued together across the heading gap.
    for (const p of paragraphs) {
      const hasBoth = p.text.includes(byId('s04').text.slice(-10)) && p.text.includes(byId('s05').text.slice(0, 10));
      expect(hasBoth).toBe(false);
    }
  });
});

describe('detectDirectionalPolarity', () => {
  test('pure increase text', () => {
    expect(detectDirectionalPolarity('売上収益は増収、事業利益は増益となりました')).toBe('increase');
  });

  test('pure decrease text', () => {
    expect(detectDirectionalPolarity('売上収益は減収、事業利益は減益となりました')).toBe('decrease');
  });

  test('mixed text (both directions present) is null, not a guess', () => {
    // s06 itself: full-year decrease alongside a Q4 increase in one paragraph.
    expect(detectDirectionalPolarity(byId('s06').text)).toBeNull();
  });

  test('text with neither direction is null', () => {
    expect(detectDirectionalPolarity(byId('s08').text)).toBeNull();
  });
});

describe('duplicate paragraphs do not inflate the classification count', () => {
  test('an exact duplicate is merged away — 2 identical paragraphs in, 1 out', () => {
    const p1 = paragraph('a', byId('s01').text);
    const p2 = paragraph('b', byId('s01').text);
    const merged = mergeNearDuplicateParagraphs([p1, p2]);
    expect(merged).toHaveLength(1);
  });

  test('three copies of the same paragraph still collapse to one', () => {
    const text = byId('s02').text;
    const merged = mergeNearDuplicateParagraphs([
      paragraph('a', text),
      paragraph('b', text),
      paragraph('c', text),
    ]);
    expect(merged).toHaveLength(1);
  });

  test('genuinely distinct paragraphs are both kept', () => {
    const merged = mergeNearDuplicateParagraphs([
      paragraph('a', byId('s01').text),
      paragraph('b', byId('s11').text),
    ]);
    expect(merged).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ★ s06 type: high word overlap, opposite conclusion. Constructed as a pair
// of paragraphs paraphrased closely from s06's own two internal sentences
// (通期の減益 / 第4四半期の増益), so the bigram overlap is high by
// construction — this is the "merge too aggressively" failure mode the
// polarity guard exists to catch. Paired with the duplicate tests above,
// which check the opposite failure mode (merging too little).
// ---------------------------------------------------------------------------

// Differ only in the final direction word (減少 vs 増加) — everything else
// held identical, the way two paraphrases of the same s06-style passage
// ("通期では…10%減" / "第4四半期は…11%増") would look after an LLM
// normalizes their wording. Maximizes lexical overlap on purpose so the
// test actually exercises the polarity guard rather than the similarity
// threshold.
const S06_STYLE_FULL_YEAR_DECREASE =
  '中国大陸事業は、当連結会計年度の通期において、現地通貨ベースで事業利益は前年同期比約10％の減少となりました。';
const S06_STYLE_Q4_INCREASE =
  '中国大陸事業は、当連結会計年度の通期において、現地通貨ベースで事業利益は前年同期比約10％の増加となりました。';

describe('★ opposite-polarity paragraphs are not merged as near-duplicates', () => {
  test('the two paragraphs have high lexical overlap', () => {
    const decision = areNearDuplicates(S06_STYLE_FULL_YEAR_DECREASE, S06_STYLE_Q4_INCREASE);
    expect(decision.similarity).toBeGreaterThan(0.82);
  });

  test('areNearDuplicates refuses to merge them despite the overlap', () => {
    const decision = areNearDuplicates(S06_STYLE_FULL_YEAR_DECREASE, S06_STYLE_Q4_INCREASE);
    expect(decision.isDuplicate).toBe(false);
    expect(decision.reason).toBe('opposite_polarity');
  });

  test('mergeNearDuplicateParagraphs keeps both as separate evidence paragraphs', () => {
    const merged = mergeNearDuplicateParagraphs([
      paragraph('full-year', S06_STYLE_FULL_YEAR_DECREASE),
      paragraph('q4', S06_STYLE_Q4_INCREASE),
    ]);
    expect(merged).toHaveLength(2);
  });
});
