/**
 * EDINET DB の応答の読み取り。**録画した実応答**（`__fixtures__/`）で回す = 外部通信ゼロ。
 *
 * ここは推測で書いてはいけない層で、実際に 3 つ間違えていた（2026-09-23 に実応答で判明）:
 *   1. 節は `data.mda` のようなキーではなく、`data` が `{section, text}` の**配列**で、
 *      節名は**日本語**（「経営者による分析」等、18 節）
 *   2. `full=true` を付けないと各節は **2,000 字の要約版**（`meta.truncated: true`）。
 *      要約を有報の逐語として引用すると出典表記と中身が食い違う
 *   3. `sec_code` は **5 桁**（トヨタ = `72030`）
 */
import { describe, expect, test } from 'bun:test';
import { extractSections, isTruncated, latestYuhouDocId, companyHeader, EVIDENCE_SECTIONS } from './ports.js';
import textBlocks from './__fixtures__/text-blocks-E02144.json';
import events from './__fixtures__/events-yuhou-E02144.json';
import company from './__fixtures__/company-E02144.json';

describe('text-blocks の節の取り出し', () => {
  test('★ 節名は日本語で、配列から拾う（`data.mda` のようなキーではない）', () => {
    const sections = extractSections(textBlocks);
    expect(sections.map(s => s.key)).toEqual(['mda', 'risks', 'policy']);
    expect(sections.map(s => s.sectionName)).toEqual([
      '経営者による分析',
      '事業等のリスク',
      '事業方針・経営環境',
    ]);
    for (const s of sections) expect(s.text.length).toBeGreaterThan(200);
  });

  test('対応表が 3 節で、内部の呼び名と応答の節名が 1 対 1', () => {
    expect(EVIDENCE_SECTIONS).toHaveLength(3);
    expect(new Set(EVIDENCE_SECTIONS.map(s => s.sectionName)).size).toBe(3);
  });

  test('★ 形が違う応答（オブジェクト形）では 0 節を返す（黙って通さない）', () => {
    // 旧実装はこの形を前提にしていた。0 節 = `/check` は「判定不能」で止まる
    expect(extractSections({ data: { mda: 'x', risks: 'y' } })).toEqual([]);
    expect(extractSections({})).toEqual([]);
    expect(extractSections(null)).toEqual([]);
  });

  test('対象外の節（役員の状況・沿革 等）は拾わない', () => {
    const sections = extractSections({
      data: [
        { section: '役員の状況', text: 'x'.repeat(500) },
        { section: '事業等のリスク', text: 'y'.repeat(500) },
      ],
    });
    expect(sections.map(s => s.key)).toEqual(['risks']);
  });
});

describe('★ 要約版のまま使わない（full=true の取り違え）', () => {
  test('録画した応答は全文（`truncated: false`）', () => {
    expect(isTruncated(textBlocks)).toBe(false);
  });

  test('`truncated: true` を検出できる（要約版だと分かる）', () => {
    expect(isTruncated({ meta: { truncated: true } })).toBe(true);
  });
});

describe('有報の書類 ID', () => {
  test('★ `event_type=yuhou` の `source_id` が取れる（出所メタの doc_id）', () => {
    expect(latestYuhouDocId(events)).toBe('S100VWVY');
  });

  test('複数あれば新しい方', () => {
    expect(
      latestYuhouDocId({
        data: [
          { event_type: 'yuhou', source_id: 'OLD', event_date: '2024-06-18' },
          { event_type: 'yuhou', source_id: 'NEW', event_date: '2025-06-18' },
        ],
      }),
    ).toBe('NEW');
  });

  test('有報でないイベントは拾わない', () => {
    expect(
      latestYuhouDocId({ data: [{ event_type: 'large_holding_report', source_id: 'X', event_date: '2025-06-20' }] }),
    ).toBeNull();
  });
});

describe('会社の見出し', () => {
  test('★ 実応答から 社名・5 桁 sec_code・年度 が取れる', () => {
    expect(companyHeader(company)).toEqual({
      name: 'トヨタ自動車株式会社',
      secCode: '72030',
      fiscalYear: 2026,
    });
  });

  test('無い項目は落とす（undefined を詰めない）', () => {
    expect(companyHeader({ data: { name: 'X' } })).toEqual({ name: 'X' });
  });
});
