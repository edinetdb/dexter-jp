import { describe, expect, test } from 'bun:test';
import { advanceState, dateOnlyMinusDays, isoMinusDays } from './state.js';
import type { EdinetDbEvent } from '../tools/finance/events.js';
import type { WatchState } from './types.js';

function ev(id: string, detectedAt: string, overrides: Partial<EdinetDbEvent> = {}): EdinetDbEvent {
  return {
    event_id: id,
    event_date: detectedAt.slice(0, 10),
    event_type: 'earnings_summary',
    event_category: 'financial',
    severity: 'low',
    edinet_code: 'E00001',
    sec_code: '7203',
    filer_name: 'テスト',
    title: 't',
    detected_at: detectedAt,
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

describe('isoMinusDays / dateOnlyMinusDays', () => {
  test('isoMinusDays subtracts whole days and stays ISO', () => {
    expect(isoMinusDays('2026-09-22T00:00:00.000Z', 1)).toBe('2026-09-21T00:00:00.000Z');
  });

  test('dateOnlyMinusDays returns a YYYY-MM-DD string', () => {
    expect(dateOnlyMinusDays(new Date('2026-09-22T12:00:00.000Z'), 7)).toBe('2026-09-15');
  });
});

describe('advanceState', () => {
  test('first run (no prev state): advances to the max detected_at, seenEventIds within overlap window', () => {
    const events = [ev('a', '2026-09-20T01:00:00.000Z'), ev('b', '2026-09-21T23:00:00.000Z')];
    const { next, newEvents } = advanceState(undefined, events, { complete: true, overlapDays: 1 });

    expect(newEvents.map((e) => e.event_id)).toEqual(['a', 'b']);
    expect(next.lastDetectedAt).toBe('2026-09-21T23:00:00.000Z');
    // floor = maxDetectedAt - 1 day = 2026-09-20T23:00:00.000Z; 'a' (09-20T01:00) is before the
    // floor and is correctly dropped from seenEventIds (it can never reappear: the next window's
    // `since`/`detected_since` starts at the floor, which is already after 'a').
    expect(next.seenEventIds).toEqual(['b']);
  });

  test('dedup: events already in prev.seenEventIds are excluded from newEvents', () => {
    const prev: WatchState = { lastDetectedAt: '2026-09-20T00:00:00.000Z', seenEventIds: ['a'] };
    const events = [ev('a', '2026-09-21T00:00:00.000Z'), ev('b', '2026-09-21T01:00:00.000Z')];
    const { newEvents } = advanceState(prev, events, { complete: true, overlapDays: 1 });
    expect(newEvents.map((e) => e.event_id)).toEqual(['b']);
  });

  test('dedup within the same batch (server returning the same id twice)', () => {
    const events = [ev('a', '2026-09-21T00:00:00.000Z'), ev('a', '2026-09-21T00:00:00.000Z')];
    const { newEvents } = advanceState(undefined, events, { complete: true, overlapDays: 1 });
    expect(newEvents).toHaveLength(1);
  });

  test('★ incomplete fetch (complete: false) does not advance lastDetectedAt — mutating this to always-advance breaks the "only advance on a complete window" invariant', () => {
    const prev: WatchState = { lastDetectedAt: '2026-09-10T00:00:00.000Z', seenEventIds: ['x'] };
    const events = [ev('y', '2026-09-21T00:00:00.000Z')];
    const { next } = advanceState(prev, events, { complete: false, overlapDays: 1 });
    expect(next).toEqual(prev);
  });

  test('★ incomplete fetch still surfaces newEvents for display (best-effort), even though state is untouched', () => {
    const events = [ev('y', '2026-09-21T00:00:00.000Z')];
    const { next, newEvents } = advanceState(undefined, events, { complete: false, overlapDays: 1 });
    expect(newEvents.map((e) => e.event_id)).toEqual(['y']);
    expect(next).toEqual({ seenEventIds: [] });
  });

  test('empty fetch (no events) with complete:true leaves lastDetectedAt untouched', () => {
    const prev: WatchState = { lastDetectedAt: '2026-09-10T00:00:00.000Z', seenEventIds: ['a'] };
    const { next, newEvents } = advanceState(prev, [], { complete: true, overlapDays: 1 });
    expect(next).toEqual(prev);
    expect(newEvents).toEqual([]);
  });

  test('empty fetch with no prev state at all: stays as fresh empty state', () => {
    const { next } = advanceState(undefined, [], { complete: true, overlapDays: 1 });
    expect(next).toEqual({ seenEventIds: [] });
  });

  test('overlapping windows: the same event near the boundary is deduped across two successive runs', () => {
    // Run 1: events at day 20 and day 21.
    const run1Events = [ev('a', '2026-09-20T10:00:00.000Z'), ev('b', '2026-09-21T10:00:00.000Z')];
    const step1 = advanceState(undefined, run1Events, { complete: true, overlapDays: 1 });
    expect(step1.next.lastDetectedAt).toBe('2026-09-21T10:00:00.000Z');

    // Run 2: window overlaps by 1 day, so the server returns 'b' again (still within the
    // overlap) plus a genuinely new event 'c'.
    const run2Events = [ev('b', '2026-09-21T10:00:00.000Z'), ev('c', '2026-09-22T05:00:00.000Z')];
    const step2 = advanceState(step1.next, run2Events, { complete: true, overlapDays: 1 });
    expect(step2.newEvents.map((e) => e.event_id)).toEqual(['c']);
  });
});
