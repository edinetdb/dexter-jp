/**
 * `runWatch` の統合テスト。fetch は必ず注入する（judge/no-network.test.ts と同じ作法。
 * 最後に注入なしで実 API に出ないことも確認する）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runWatch, readWatchState, writeWatchlist, DEFAULT_INITIAL_LOOKBACK_DAYS } from './index.js';
import type { EdinetDbEvent } from '../tools/finance/events.js';
import type { Watchlist } from './types.js';

function ev(overrides: Partial<EdinetDbEvent> = {}): EdinetDbEvent {
  return {
    event_id: 'e-' + Math.random().toString(36).slice(2),
    event_date: '2026-09-20',
    event_type: 'officer_change',
    event_category: 'governance',
    severity: 'high',
    edinet_code: 'E02144',
    sec_code: '7203',
    filer_name: 'トヨタ自動車',
    title: '役員の異動に関するお知らせ',
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

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

describe('runWatch', () => {
  const dirs: string[] = [];
  const originalKey = process.env.EDINETDB_API_KEY;

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (originalKey === undefined) delete process.env.EDINETDB_API_KEY;
    else process.env.EDINETDB_API_KEY = originalKey;
  });

  function tmpFiles(): { watchStatePath: string; watchlistPath: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'dexter-watch-run-'));
    dirs.push(dir);
    return {
      dir,
      watchStatePath: join(dir, 'watch-state.json'),
      watchlistPath: join(dir, 'watchlist.json'),
    };
  }

  function setWatchlist(path: string, wl: Watchlist): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(wl));
  }

  test('first run: no state file, looks back DEFAULT_INITIAL_LOOKBACK_DAYS, advances and persists state', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    const { watchStatePath, watchlistPath } = tmpFiles();
    setWatchlist(watchlistPath, { entries: [{ label: 'トヨタ', secCode: '7203', edinetCode: 'E02144' }] });

    const captured: { since: string | null } = { since: null };
    const fetchImpl = async (url: string) => {
      const u = new URL(url);
      captured.since = u.searchParams.get('since');
      return jsonResponse({
        data: [ev()],
        meta: { pagination: { limit: 1000, offset: 0, next_offset: 1, total: 1 } },
      });
    };

    const now = () => new Date('2026-09-22T00:00:00.000Z');
    const result = await runWatch({ watchStatePath, watchlistPath, fetchImpl, now });

    expect(captured.since).not.toBeNull();
    // since = today - DEFAULT_INITIAL_LOOKBACK_DAYS
    const expected = new Date(
      new Date('2026-09-22T00:00:00.000Z').getTime() - DEFAULT_INITIAL_LOOKBACK_DAYS * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    expect(captured.since).toBe(expected);
    expect(result.stateAdvanced).toBe(true);
    expect(result.panel.groups[1].count).toBe(1); // officer_change -> group 1
    expect(result.text).toContain('役員の異動');

    const persisted = readWatchState(watchStatePath);
    expect(persisted?.lastDetectedAt).toBe('2026-09-20T01:00:00.000000Z');
  });

  test('second run: uses detected_since cursor from persisted state, not since/until', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    const { watchStatePath, watchlistPath } = tmpFiles();
    setWatchlist(watchlistPath, { entries: [{ label: 'トヨタ', secCode: '7203', edinetCode: 'E02144' }] });
    writeFileSync(watchStatePath, JSON.stringify({ lastDetectedAt: '2026-09-20T00:00:00.000Z', seenEventIds: [] }));

    let seenParams: URLSearchParams | null = null;
    const fetchImpl = async (url: string) => {
      seenParams = new URL(url).searchParams;
      return jsonResponse({ data: [], meta: { pagination: { limit: 1000, offset: 0, next_offset: 0, total: 0 } } });
    };

    await runWatch({ watchStatePath, watchlistPath, fetchImpl });

    expect(seenParams!.has('detected_since')).toBe(true);
    expect(seenParams!.has('since')).toBe(false);
  });

  test('★ truncated fetch (hits maxPages): panel.incomplete is true, and state is NOT advanced (next run will retry the same window)', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    const { watchStatePath, watchlistPath } = tmpFiles();
    setWatchlist(watchlistPath, { entries: [{ label: 'トヨタ', secCode: '7203', edinetCode: 'E02144' }] });

    const fetchImpl = async (url: string) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      return jsonResponse({
        data: [ev({ event_id: `p${offset}` })],
        meta: { pagination: { limit: 1, offset, next_offset: offset + 1, total: 1000 } },
      });
    };

    const result = await runWatch({ watchStatePath, watchlistPath, fetchImpl, maxPages: 2 });

    expect(result.panel.incomplete).toBe(true);
    expect(result.stateAdvanced).toBe(false);
    expect(readWatchState(watchStatePath)).toBeUndefined();
    expect(result.text).toContain('未取得あり');
  });

  test('unmatched watchlist entries produce empty groups but no crash, and the watchlist-missing issue surfaces', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    const { watchStatePath, watchlistPath } = tmpFiles();
    // watchlistPath left unset (no file written) -> loadWatchlist reports an issue.

    const fetchImpl = async () =>
      jsonResponse({ data: [], meta: { pagination: { limit: 1000, offset: 0, next_offset: 0, total: 0 } } });

    const result = await runWatch({ watchStatePath, watchlistPath, fetchImpl });
    expect(result.panel.watchlistIssues.length).toBeGreaterThan(0);
    expect(result.panel.groups.every((g) => g.count === 0)).toBe(true);
  });

  test('★ end-to-end: the persisted watch-state.json never contains a watchlist ticker code, after a full runWatch cycle', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    const { watchStatePath, watchlistPath } = tmpFiles();
    setWatchlist(watchlistPath, { entries: [{ label: 'トヨタ', secCode: '7203', edinetCode: 'E02144' }] });

    const fetchImpl = async () =>
      jsonResponse({
        data: [ev({ sec_code: '7203', edinet_code: 'E02144' })],
        meta: { pagination: { limit: 1000, offset: 0, next_offset: 1, total: 1 } },
      });

    await runWatch({ watchStatePath, watchlistPath, fetchImpl });

    const raw = readFileSync(watchStatePath, 'utf8');
    expect(raw.includes('7203')).toBe(false);
    expect(raw.includes('E02144')).toBe(false);
  });

  test('/watch all expands the low-priority group in the rendered text', async () => {
    process.env.EDINETDB_API_KEY = 'test-key';
    const { watchStatePath, watchlistPath } = tmpFiles();
    setWatchlist(watchlistPath, { entries: [{ label: 'トヨタ', secCode: '7203', edinetCode: 'E02144' }] });

    const fetchImpl = async () =>
      jsonResponse({
        data: [ev({ event_type: 'earnings_summary', title: '決算短信のお知らせ' })],
        meta: { pagination: { limit: 1000, offset: 0, next_offset: 1, total: 1 } },
      });

    const collapsed = await runWatch({ watchStatePath, watchlistPath, fetchImpl, all: false });
    expect(collapsed.text).not.toContain('決算短信のお知らせ');

    // Fresh state dir for the `all: true` run so it also sees the same window as "new".
    const { watchStatePath: p2, watchlistPath: wl2 } = tmpFiles();
    setWatchlist(wl2, { entries: [{ label: 'トヨタ', secCode: '7203', edinetCode: 'E02144' }] });
    const expanded = await runWatch({ watchStatePath: p2, watchlistPath: wl2, fetchImpl, all: true });
    expect(expanded.text).toContain('決算短信のお知らせ');
  });
});

describe('runWatch no-network guarantee', () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.EDINETDB_API_KEY;
  const dirs: string[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (originalKey === undefined) delete process.env.EDINETDB_API_KEY;
    else process.env.EDINETDB_API_KEY = originalKey;
  });

  test('without an injected fetchImpl, runWatch only ever reaches the network through global fetch', async () => {
    globalThis.fetch = (() => {
      throw new Error('network access attempted in tests');
    }) as unknown as typeof fetch;
    process.env.EDINETDB_API_KEY = 'test-key';

    const dir = mkdtempSync(join(tmpdir(), 'dexter-watch-nonetwork-'));
    dirs.push(dir);
    const watchlistPath = join(dir, 'watchlist.json');
    mkdirSync(dirname(watchlistPath), { recursive: true });
    writeFileSync(watchlistPath, JSON.stringify({ entries: [{ secCode: '7203' }] }));

    await expect(
      runWatch({ watchStatePath: join(dir, 'watch-state.json'), watchlistPath }),
    ).rejects.toThrow(/network access attempted in tests/);
  });
});
