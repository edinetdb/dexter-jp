/**
 * EDINET DB の応答の読み取り。**録画した実応答**（`__fixtures__/`）で回す = 外部通信ゼロ。
 *
 * ここは推測で書いてはいけない層で、実際に **5 つ**間違えていた（2026-09-23 に実応答で判明）:
 *   1. 節は `data.mda` のようなキーではなく、`data` が `{section, text}` の**配列**で、
 *      節名は**日本語**（「経営者による分析」等、18 節）
 *   2. `full=true` を付けないと各節は **2,000 字の要約版**（`meta.truncated: true`）。
 *      要約を有報の逐語として引用すると出典表記と中身が食い違う
 *   3. `sec_code` は **5 桁**（トヨタ = `72030`）
 *   4. `/v1/events` は `since` を省くと**直近 7 日**しか見ない = 年 1 回の有報は必ず 0 件
 *   5. 日付範囲は**最大 366 日**（超えると 400）。しかも 1 年より前の有報 ID を当てると、
 *      本文（最新期）と出典が食い違う = トヨタは第121期 `S100VWVY` ではなく第122期 `S100Y8NY`
 */
import { describe, expect, test } from 'bun:test';
import {
  extractSections, isTruncated, latestYuhouDocId, companyHeader, yuhouWindow, EVIDENCE_SECTIONS,
  fetchDisclosureWith, TRUNCATED_DISCLOSURE_MESSAGE, type ApiGet,
} from './ports.js';
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
    // 第122期（2025/04-2026/03、提出 2026-06-10）= text-blocks が返す本文と同じ期
    expect(latestYuhouDocId(events)).toBe('S100Y8NY');
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

describe('★ 日付窓（実応答で 2 回間違えた）', () => {
  test('`since` を省くと直近 7 日しか見ない → 有報は年 1 回なので必ず 0 件になる', () => {
    // 実測: ?edinet_code=E02144&event_type=yuhou&limit=5 は total 0
    // だから窓を必ず付ける。付け忘れると doc_id が空のまま通ってしまう
    const w = yuhouWindow(new Date('2026-09-23T00:00:00Z'));
    expect(w.until).toBe('2026-09-23');
    expect(w.since).toBe('2025-09-23');
  });

  test('★ 窓は 366 日を超えない（超えると 400 invalid_param: Range too large）', () => {
    const w = yuhouWindow(new Date('2026-09-23T00:00:00Z'));
    const days = (Date.parse(w.until) - Date.parse(w.since)) / 86_400_000;
    expect(days).toBeLessThanOrEqual(366);
    expect(days).toBeGreaterThanOrEqual(364);
  });

  test('うるう年をまたいでも 366 日以内', () => {
    for (const d of ['2028-03-01', '2028-02-29', '2027-01-01']) {
      const w = yuhouWindow(new Date(`${d}T00:00:00Z`));
      const days = (Date.parse(w.until) - Date.parse(w.since)) / 86_400_000;
      expect({ d, ok: days <= 366 }).toEqual({ d, ok: true });
    }
  });

  test('★ 見つからなければ null（古い期の書類 ID を当てない）', () => {
    // 本文は最新期なので、1 年より前の有報 ID を出典にすると本文と出典が食い違う
    expect(latestYuhouDocId({ data: [] })).toBeNull();
  });
});

describe('★ fetchDisclosure が api.get の実際の形で段落まで届く（常に判定不能の型、T9 後の自己点検）', () => {
  // api.get は応答の JSON 本体を `data` に入れて返す。以前は本体をもう一度 { data: 本体 } に包んで
  // 読んでいたので、実応答では節 0・段落 0・社名も期も取れず、本番の /check は常に判定不能だった。
  // fixture は 2026-09-23 に EDINET DB から取った実応答の本体。
  const fakeGet: ApiGet = async (endpoint) => {
    const body = endpoint.endsWith('/text-blocks') ? textBlocks : endpoint === '/events' ? events : company;
    return { data: body as Record<string, unknown>, url: `https://edinetdb.jp/v1${endpoint}` };
  };
  const deps = { get: fakeGet, resolve: async () => 'E02144' };

  test('節 3・段落あり・社名・期・書類 ID が全部取れる', async () => {
    const d = await fetchDisclosureWith('7203', deps);
    expect(d.sections).toEqual(['mda', 'risks', 'policy']);
    expect(d.paragraphs.length).toBeGreaterThan(10);
    expect(d.company.name).not.toBe('E02144'); // 社名が取れず銘柄コードに落ちていない
    expect(d.company.name).toContain('トヨタ');
    expect(d.fiscalYear).toBeGreaterThan(2000);
    expect(d.paragraphs[0].docId).toBe('S100Y8NY');
  });

  test('★ 要約版（meta.truncated: true）が返ったら段落を作らずに止める（review T9 M5）', async () => {
    const truncatedGet: ApiGet = async (endpoint, params, options) => {
      const r = await fakeGet(endpoint, params, options);
      if (!endpoint.endsWith('/text-blocks')) return r;
      return { ...r, data: { ...(r.data as object), meta: { ...(textBlocks as { meta: object }).meta, truncated: true } } };
    };
    await expect(fetchDisclosureWith('7203', { ...deps, get: truncatedGet })).rejects.toThrow(TRUNCATED_DISCLOSURE_MESSAGE);
  });
});
