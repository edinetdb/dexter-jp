import { describe, test, expect, afterEach, mock } from 'bun:test';
import { getRecentFilings } from './sec-edgar-client.js';

// resolveTickerToCikはモジュール内キャッシュ(tickerMapPromise)を持ち、テスト間で
// 共有されてしまうため、ここではgetRecentFilings(独立した関数、キャッシュ無し)
// のみをテストする。
//
// globalThis.fetchはテストファイル間・実行順序に依存せず確実に元へ戻す必要が
// あるため、spyOn(globalThis, 'fetch')の重ね掛け(mockRestoreが正しく効かない
// ケースがある)ではなく、元の参照を保存した上で直接代入・afterEachで復元する
// 方式にする。
const originalFetch = globalThis.fetch;

function mockFetchJson(payload: unknown, ok = true, status = 200): void {
  globalThis.fetch = mock(async () => {
    return new Response(JSON.stringify(payload), {
      status,
      statusText: ok ? 'OK' : 'Error',
    });
  }) as unknown as typeof fetch;
}

describe('getRecentFilings', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('finds a form even when it is not among the first 200 entries', () => {
    // 2026-08-12に実際に発覚したバグの回帰テスト: JPMのような大企業は
    // 8-K/Form4/424B2等の頻出書類に埋もれ、10-Kが200件目より後ろに
    // しか出現しないことがある。全件走査すれば見つかることを確認する。
    const noise = Array.from({ length: 300 }, (_, i) => ({
      form: '8-K',
      filingDate: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      accessionNumber: `0000000000-26-${String(i).padStart(6, '0')}`,
      primaryDocument: `noise-${i}.htm`,
    }));
    const tenK = {
      form: '10-K',
      filingDate: '2026-02-13',
      accessionNumber: '0001628280-26-008131',
      primaryDocument: 'jpm-20251231.htm',
    };
    const all = [...noise, tenK]; // 10-Kが301番目(index=300)に位置する

    const payload = {
      filings: {
        recent: {
          form: all.map((f) => f.form),
          filingDate: all.map((f) => f.filingDate),
          accessionNumber: all.map((f) => f.accessionNumber),
          primaryDocument: all.map((f) => f.primaryDocument),
        },
      },
    };
    mockFetchJson(payload);

    return getRecentFilings('0000019617', ['10-K'], 1).then((result) => {
      expect(result).toHaveLength(1);
      expect(result[0].form).toBe('10-K');
      expect(result[0].filingDate).toBe('2026-02-13');
      expect(result[0].documentUrl).toBe(
        'https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm',
      );
    });
  });

  test('respects the limit parameter', () => {
    const filings = Array.from({ length: 5 }, (_, i) => ({
      form: '10-Q',
      filingDate: `2026-0${i + 1}-01`,
      accessionNumber: `0001628280-26-00${i}`,
      primaryDocument: `doc-${i}.htm`,
    }));
    const payload = {
      filings: {
        recent: {
          form: filings.map((f) => f.form),
          filingDate: filings.map((f) => f.filingDate),
          accessionNumber: filings.map((f) => f.accessionNumber),
          primaryDocument: filings.map((f) => f.primaryDocument),
        },
      },
    };
    mockFetchJson(payload);

    return getRecentFilings('0000019617', ['10-Q'], 2).then((result) => {
      expect(result).toHaveLength(2);
    });
  });

  test('returns an empty array when no matching form is found', () => {
    const payload = {
      filings: {
        recent: {
          form: ['8-K', '4'],
          filingDate: ['2026-01-01', '2026-01-02'],
          accessionNumber: ['0001-26-000001', '0001-26-000002'],
          primaryDocument: ['a.htm', 'b.htm'],
        },
      },
    };
    mockFetchJson(payload);

    return getRecentFilings('0000019617', ['10-K'], 5).then((result) => {
      expect(result).toEqual([]);
    });
  });

  test('strips leading zeros from CIK in the document URL but keeps them in the accession number path', () => {
    const payload = {
      filings: {
        recent: {
          form: ['10-K'],
          filingDate: ['2025-10-31'],
          accessionNumber: ['0000320193-25-000079'],
          primaryDocument: ['aapl-20250927.htm'],
        },
      },
    };
    mockFetchJson(payload);

    return getRecentFilings('0000320193', ['10-K'], 1).then((result) => {
      expect(result[0].documentUrl).toBe(
        'https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm',
      );
    });
  });

  test('throws a descriptive error when the submissions fetch fails', () => {
    globalThis.fetch = mock(async () => {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }) as unknown as typeof fetch;

    return expect(getRecentFilings('0000000000', ['10-K'], 1)).rejects.toThrow(
      /submissions fetch failed: 404/,
    );
  });
});
