import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWatchlist, matchWatchlist, watchlistEntryLabel, writeWatchlist } from './watchlist.js';
import type { EdinetDbEvent } from '../tools/finance/events.js';
import type { Watchlist } from './types.js';

function ev(overrides: Partial<EdinetDbEvent> = {}): EdinetDbEvent {
  return {
    event_id: 'e1',
    event_date: '2026-09-20',
    event_type: 'earnings_summary',
    event_category: 'financial',
    severity: 'low',
    edinet_code: null,
    sec_code: null,
    filer_name: 'X',
    title: 't',
    detected_at: '2026-09-20T00:00:00.000Z',
    event_timestamp: null,
    fiscal_year: null,
    quarter: null,
    source: null,
    source_id: null,
    corrects_event_id: null,
    summary: null,
    metadata: null,
    ...overrides,
  };
}

describe('loadWatchlist', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmpPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dexter-watchlist-'));
    dirs.push(dir);
    return join(dir, 'watchlist.json');
  }

  test('missing file: empty watchlist + an issue explaining how to fix it', () => {
    const { watchlist, issues } = loadWatchlist(tmpPath());
    expect(watchlist.entries).toEqual([]);
    expect(issues.length).toBeGreaterThan(0);
  });

  test('valid file: loads entries with both secCode and edinetCode', () => {
    const path = tmpPath();
    const wl: Watchlist = { entries: [{ label: 'トヨタ', secCode: '7203', edinetCode: 'E02144' }] };
    writeWatchlist(wl, path);
    const { watchlist, issues } = loadWatchlist(path);
    expect(watchlist.entries).toEqual(wl.entries);
    expect(issues).toEqual([]);
  });

  test('entries missing both secCode and edinetCode are dropped with an issue, valid ones kept', () => {
    const path = tmpPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ entries: [{ label: 'bad, no codes' }, { label: 'good', secCode: '1234' }] }),
    );
    const { watchlist, issues } = loadWatchlist(path);
    expect(watchlist.entries).toEqual([{ label: 'good', secCode: '1234' }]);
    expect(issues.length).toBe(1);
  });

  test('malformed JSON: empty watchlist + an issue, does not throw', () => {
    const path = tmpPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not json');
    const { watchlist, issues } = loadWatchlist(path);
    expect(watchlist.entries).toEqual([]);
    expect(issues.length).toBe(1);
  });
});

describe('matchWatchlist', () => {
  const watchlist: Watchlist = {
    entries: [
      { label: 'トヨタ', secCode: '7203', edinetCode: 'E02144' },
      { label: '非上場例', edinetCode: 'E99999' },
    ],
  };

  test('matches by secCode', () => {
    const matches = matchWatchlist(ev({ sec_code: '7203', edinet_code: null }), watchlist);
    expect(matches.map((e) => e.label)).toEqual(['トヨタ']);
  });

  test('matches by edinetCode when secCode is null (T0b: 39/66 samples had null sec_code)', () => {
    const matches = matchWatchlist(ev({ sec_code: null, edinet_code: 'E99999' }), watchlist);
    expect(matches.map((e) => e.label)).toEqual(['非上場例']);
  });

  test('matches by edinetCode even when the entry also has a secCode (both fields checked, T0b §4)', () => {
    const matches = matchWatchlist(ev({ sec_code: null, edinet_code: 'E02144' }), watchlist);
    expect(matches.map((e) => e.label)).toEqual(['トヨタ']);
  });

  test('no match: unrelated ticker', () => {
    const matches = matchWatchlist(ev({ sec_code: '9999', edinet_code: 'E00000' }), watchlist);
    expect(matches).toEqual([]);
  });

  test('no match: both event fields null', () => {
    const matches = matchWatchlist(ev({ sec_code: null, edinet_code: null }), watchlist);
    expect(matches).toEqual([]);
  });
});

describe('watchlistEntryLabel', () => {
  test('prefers label, then secCode, then edinetCode', () => {
    expect(watchlistEntryLabel({ label: 'L', secCode: 'S', edinetCode: 'E' })).toBe('L');
    expect(watchlistEntryLabel({ secCode: 'S', edinetCode: 'E' })).toBe('S');
    expect(watchlistEntryLabel({ edinetCode: 'E' })).toBe('E');
  });
});
