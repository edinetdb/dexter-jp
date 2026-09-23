/**
 * Pure paragraphing of 有報 section text into evidence units, per
 * design-v0.md §4.2:
 *
 *   - 段落化は見出しと句点で150〜400字
 *   - ほぼ同文は1本に寄せる（ただし寄せすぎない — 語彙が近くても結論が
 *     逆の段落は別物として残す）
 *
 * No network/file I/O. Callers pass in already-fetched section text.
 */

import type { DuplicateDecision, Paragraph } from './types.js';

const MIN_LEN = 150;
const MAX_LEN = 400;

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

/** Heading boundaries: blank-line-delimited blocks. A no-op on our flat,
 * single-block EDINET fixtures, but keeps multi-heading source text from
 * bleeding across sections when it does contain headings. */
function splitOnHeadings(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Splits after each 。while keeping the mark attached to the sentence.
 * Deliberately does NOT trim each piece: inter-sentence whitespace in the
 * source (EDINET 有報 text commonly has a stray space after 。) stays
 * attached to the following sentence, so re-joining split pieces reproduces
 * the source text exactly when no chunk boundary falls between them.
 */
function splitSentences(text: string): string[] {
  return text.split(/(?<=。)/).filter((s) => s.length > 0);
}

function chunkBySentence(block: string): string[] {
  const sentences = splitSentences(block);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > MAX_LEN) {
      chunks.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) chunks.push(current);
  return mergeShortTrailingChunk(chunks);
}

/** A trailing chunk under MIN_LEN (e.g. one short closing sentence) is
 * folded into the previous chunk rather than shipped as its own paragraph,
 * as long as doing so does not blow past MAX_LEN too badly. */
function mergeShortTrailingChunk(chunks: string[]): string[] {
  if (chunks.length < 2) return chunks;
  const last = chunks[chunks.length - 1];
  if (last.length >= MIN_LEN) return chunks;
  const prev = chunks[chunks.length - 2];
  const merged = prev + last;
  return [...chunks.slice(0, -2), merged];
}

export type ParagraphMeta = Omit<Paragraph, 'id' | 'text'>;

/** Segments raw section text into 150〜400-char paragraphs at heading and
 * sentence (句点) boundaries. */
export function segmentIntoParagraphs(text: string, meta: ParagraphMeta): Paragraph[] {
  const blocks = splitOnHeadings(text);
  const chunks = blocks.flatMap(chunkBySentence);
  return chunks.map((chunkText, i) => ({
    ...meta,
    id: `${meta.docId}-${meta.section}-${i + 1}`,
    text: chunkText,
  }));
}

// ---------------------------------------------------------------------------
// Near-duplicate detection and merge
// ---------------------------------------------------------------------------

const DEFAULT_SIMILARITY_THRESHOLD = 0.82;

function bigrams(text: string): Set<string> {
  const clean = text.replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) grams.add(clean.slice(i, i + 2));
  return grams;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const g of a) if (b.has(g)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Deliberately narrow to financial-result vocabulary. Broader words like
// 拡大/縮小 show up constantly in strategic narrative ("ブランドの拡大")
// with no relation to a reported increase/decrease and would false-positive.
const INCREASE_WORDS = ['増益', '増収', '増加', '上昇', '伸長', '改善', '増'];
const DECREASE_WORDS = ['減益', '減収', '減少', '低下', '悪化', '減'];

/**
 * Coarse directional polarity of a paragraph. Returns null when the text is
 * mixed (contains both directions, like a single paragraph that reports a
 * full-year decrease alongside a Q4 increase) or has no directional
 * language at all — null means "not enough signal to block a merge on
 * polarity," it does not mean "safe to merge."
 */
export function detectDirectionalPolarity(text: string): 'increase' | 'decrease' | null {
  const hasIncrease = INCREASE_WORDS.some((w) => text.includes(w));
  const hasDecrease = DECREASE_WORDS.some((w) => text.includes(w));
  if (hasIncrease && !hasDecrease) return 'increase';
  if (hasDecrease && !hasIncrease) return 'decrease';
  return null;
}

/**
 * Decides whether two paragraph texts are near-duplicates that should be
 * merged into one. High lexical overlap is necessary but not sufficient:
 * two paragraphs that share most of their vocabulary but assert opposite
 * directions (e.g. "通期は減益" vs. "第4四半期は増益", worded very
 * similarly) must NOT be merged — merging them would silently drop one of
 * two opposite conclusions from the evidence set.
 */
export function areNearDuplicates(
  a: string,
  b: string,
  threshold = DEFAULT_SIMILARITY_THRESHOLD
): DuplicateDecision {
  const similarity = jaccardSimilarity(bigrams(a), bigrams(b));
  if (similarity < threshold) {
    return { isDuplicate: false, similarity, reason: 'below_threshold' };
  }
  const polarityA = detectDirectionalPolarity(a);
  const polarityB = detectDirectionalPolarity(b);
  if (polarityA && polarityB && polarityA !== polarityB) {
    return { isDuplicate: false, similarity, reason: 'opposite_polarity' };
  }
  return { isDuplicate: true, similarity };
}

/**
 * Merges near-duplicate paragraphs, keeping the first occurrence of each
 * distinct paragraph. Paragraphs with high overlap but opposing polarity
 * (see areNearDuplicates) are both kept.
 */
export function mergeNearDuplicateParagraphs(
  paragraphs: Paragraph[],
  threshold = DEFAULT_SIMILARITY_THRESHOLD
): Paragraph[] {
  const kept: Paragraph[] = [];
  for (const p of paragraphs) {
    const isDup = kept.some((k) => areNearDuplicates(k.text, p.text, threshold).isDuplicate);
    if (!isDup) kept.push(p);
  }
  return kept;
}
