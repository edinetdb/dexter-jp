/**
 * `fetchEvents` のテスト。実 API には一切出ない（fetchImpl を必ず注入する。
 * judge/no-network.test.ts と同じ作法で、最後に global fetch を毒キリして
 * 「注入なしで呼べば絶対に実 API へ届かない」ことも証明する）。
 *
 * fixture の値は T0b の実測記録（`~/Desktop/tmp/dexter-kotae/T0b-events-api.md` §2・§4）を
 * 手で切り詰めたもの（実測のキー集合・応答形はそのまま、値はテスト用に短くしてある）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_PAGES,
  fetchEvents,
  type EdinetDbEvent,
  type EventsQuery,
} from './events.js';

function makeEvent(overrides: Partial<EdinetDbEvent> = {}): EdinetDbEvent {
  return {
    event_id: 'e-' + Math.random().toString(36).slice(2),
    event_date: '2026-09-20',
    event_type: 'earnings_summary',
    event_category: 'financial',
    severity: 'high',
    edinet_code: 'E02144',
    sec_code: '7203',
    filer_name: 'テスト株式会社',
    title: 'テストタイトル',
    detected_at: '2026-09-20T01:00:00.000000Z',
    event_timestamp: null,
    fiscal_year: 2026,
    quarter: null,
    source: 'edinet',
    source_id: null,
    corrects_event_id: null,
    summary: null,
    metadata: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

describe('fetchEvents', () => {
  const originalKey = process.env.EDINETDB_API_KEY;
  afterEach(() => {
    if (originalKey === undefined) delete process.env.EDINETDB_API_KEY;
    else process.env.EDINETDB_API_KEY = originalKey;
  });

  test('single page: returns events, not truncated, total recorded', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    const calls: string[] = [];
    const evs = [makeEvent(), makeEvent()];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return jsonResponse({
        data: evs,
        meta: { pagination: { limit: MAX_PAGE_LIMIT, offset: 0, next_offset: 2, total: 2 } },
      });
    };

    const result = await fetchEvents({ since: '2026-09-15', until: '2026-09-22' }, { fetchImpl });

    expect(result.events).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.limitClamped).toBe(false);
    expect(result.pagesFetched).toBe(1);
    expect(result.total).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('since=2026-09-15');
    expect(calls[0]).toContain('until=2026-09-22');
    expect(calls[0]).toContain(`limit=${DEFAULT_PAGE_LIMIT}`);
    expect(calls[0]).toContain('offset=0');
  });

  test('multiple pages: offsets advance via offset + received >= total, not via next_offset alone', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    const page1 = [makeEvent({ event_id: 'a' }), makeEvent({ event_id: 'b' })];
    const page2 = [makeEvent({ event_id: 'c' })];
    const offsetsSeen: number[] = [];
    const fetchImpl = async (url: string) => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset'));
      offsetsSeen.push(offset);
      if (offset === 0) {
        return jsonResponse({
          data: page1,
          meta: { pagination: { limit: 2, offset: 0, next_offset: 2, total: 3 } },
        });
      }
      return jsonResponse({
        data: page2,
        meta: { pagination: { limit: 2, offset: 2, next_offset: 4, total: 3 } },
      });
    };

    const result = await fetchEvents({ limit: 2 }, { fetchImpl });

    expect(offsetsSeen).toEqual([0, 2]);
    expect(result.events.map((e) => e.event_id)).toEqual(['a', 'b', 'c']);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
  });

  test('★ truncated: true when maxPages is hit before total is reached ("未取得あり")', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    // total は毎回 1000 件と報告するが、1 ページ 1 件しか返さない = 絶対に取り切れない。
    const fetchImpl = async (url: string) => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset'));
      return jsonResponse({
        data: [makeEvent({ event_id: `p${offset}` })],
        meta: { pagination: { limit: 1, offset, next_offset: offset + 1, total: 1000 } },
      });
    };

    const result = await fetchEvents({ limit: 1 }, { fetchImpl, maxPages: 3 });

    expect(result.pagesFetched).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.events).toHaveLength(3);
  });

  test('does not report truncated when the last page exactly finishes the total', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    const fetchImpl = async (url: string) => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset'));
      const total = 6;
      const remaining = total - offset;
      const pageSize = Math.min(2, remaining);
      const data = Array.from({ length: pageSize }, (_, i) => makeEvent({ event_id: `x${offset + i}` }));
      return jsonResponse({
        data,
        meta: { pagination: { limit: 2, offset, next_offset: offset + 2, total } },
      });
    };

    const result = await fetchEvents({ limit: 2 }, { fetchImpl, maxPages: 3 });

    expect(result.events).toHaveLength(6);
    expect(result.pagesFetched).toBe(3);
    expect(result.truncated).toBe(false);
  });

  test('limitClamped: detects when the server echoes a limit different from what was requested (T0b §1/§8)', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    // Client requests 500 (within bounds); server echoes back 100 (e.g. a plan-level cap
    // below MAX_PAGE_LIMIT). The client itself pre-clamps to MAX_PAGE_LIMIT before sending,
    // so the only way to observe a real clamp is via a server-side mismatch like this one.
    const fetchImpl = async () =>
      jsonResponse({
        data: [],
        meta: { pagination: { limit: 100, offset: 0, next_offset: 0, total: 0 } },
      });

    const result = await fetchEvents({ limit: 500 }, { fetchImpl });
    expect(result.limitClamped).toBe(true);
  });

  test('the client itself pre-clamps a request above MAX_PAGE_LIMIT before sending (never sends >1000)', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    let seenUrl = '';
    const fetchImpl = async (url: string) => {
      seenUrl = url;
      return jsonResponse({
        data: [],
        meta: { pagination: { limit: MAX_PAGE_LIMIT, offset: 0, next_offset: 0, total: 0 } },
      });
    };
    const result = await fetchEvents({ limit: 5000 }, { fetchImpl });
    const u = new URL(seenUrl);
    expect(u.searchParams.get('limit')).toBe(String(MAX_PAGE_LIMIT));
    expect(result.limitClamped).toBe(false);
  });

  test('limitClamped is false when the server echoes the requested limit', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    const fetchImpl = async () =>
      jsonResponse({
        data: [],
        meta: { pagination: { limit: 500, offset: 0, next_offset: 0, total: 0 } },
      });

    const result = await fetchEvents({ limit: 500 }, { fetchImpl });
    expect(result.limitClamped).toBe(false);
  });

  test('empty result set: complete, not truncated', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    const fetchImpl = async () =>
      jsonResponse({ data: [], meta: { pagination: { limit: MAX_PAGE_LIMIT, offset: 0, next_offset: 0, total: 0 } } });

    const result = await fetchEvents({}, { fetchImpl });
    expect(result.events).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(result.pagesFetched).toBe(1);
  });

  test('event_type and severity are sent as repeated query params (T0b §1: comma-joined confirmed only for these two)', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    let seenUrl = '';
    const fetchImpl = async (url: string) => {
      seenUrl = url;
      return jsonResponse({ data: [], meta: { pagination: { limit: MAX_PAGE_LIMIT, offset: 0, next_offset: 0, total: 0 } } });
    };

    await fetchEvents({ event_type: ['a', 'b'], severity: ['high', 'critical'] }, { fetchImpl });

    const u = new URL(seenUrl);
    expect(u.searchParams.getAll('event_type')).toEqual(['a', 'b']);
    expect(u.searchParams.getAll('severity')).toEqual(['high', 'critical']);
  });

  test('never sends sec_code or edinet_code, even if a caller forces extra fields past the type system (design B)', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    let seenUrl = '';
    const fetchImpl = async (url: string) => {
      seenUrl = url;
      return jsonResponse({ data: [], meta: { pagination: { limit: MAX_PAGE_LIMIT, offset: 0, next_offset: 0, total: 0 } } });
    };

    const query = { sec_code: '7203', edinet_code: 'E02144', since: '2026-09-01' } as unknown as EventsQuery;
    await fetchEvents(query, { fetchImpl });

    expect(seenUrl).not.toContain('sec_code');
    expect(seenUrl).not.toContain('edinet_code');
    expect(seenUrl).not.toContain('7203');
    expect(seenUrl).not.toContain('E02144');
  });

  test('detected_since is forwarded verbatim', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    let seenUrl = '';
    const fetchImpl = async (url: string) => {
      seenUrl = url;
      return jsonResponse({ data: [], meta: { pagination: { limit: MAX_PAGE_LIMIT, offset: 0, next_offset: 0, total: 0 } } });
    };
    await fetchEvents({ detected_since: '2026-09-21T00:39:49Z' }, { fetchImpl });
    expect(seenUrl).toContain('detected_since=2026-09-21T00%3A39%3A49Z');
  });

  test('non-ok response throws with status detail', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    const fetchImpl = async () => jsonResponse({ error: { code: 'invalid_param' } }, { status: 400, ok: false });
    await expect(fetchEvents({}, { fetchImpl })).rejects.toThrow(/400/);
  });

  test('network error is wrapped with a descriptive message', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    const fetchImpl = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(fetchEvents({}, { fetchImpl })).rejects.toThrow(/ECONNRESET/);
  });

  test('MAX_PAGES constant matches design (10 pages)', () => {
    expect(MAX_PAGES).toBe(10);
  });
});

describe('fetchEvents no-network guarantee', () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.EDINETDB_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.EDINETDB_API_KEY;
    else process.env.EDINETDB_API_KEY = originalKey;
  });

  test('without an injected fetchImpl, calls go through (and are stoppable via) global fetch only', async () => {
    globalThis.fetch = (() => {
      throw new Error('network access attempted in tests');
    }) as unknown as typeof fetch;
    process.env.EDINETDB_API_KEY = 'test-key';

    await expect(fetchEvents({})).rejects.toThrow(/network access attempted in tests/);
  });
});
