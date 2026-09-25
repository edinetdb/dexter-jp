import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readWatchState, writeWatchState } from './state-store.js';
import type { WatchState } from './types.js';

describe('watch state store', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmpPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dexter-watch-state-'));
    dirs.push(dir);
    return join(dir, 'nested', 'watch-state.json');
  }

  test('readWatchState returns undefined when the file does not exist (first run)', () => {
    expect(readWatchState(tmpPath())).toBeUndefined();
  });

  test('write then read round-trips exactly', () => {
    const path = tmpPath();
    const state: WatchState = { lastDetectedAt: '2026-09-20T00:00:00.000Z', seenEventIds: ['a', 'b'] };
    writeWatchState(state, path);
    expect(readWatchState(path)).toEqual(state);
  });

  test('writeWatchState creates missing parent directories', () => {
    const path = tmpPath();
    writeWatchState({ seenEventIds: [] }, path);
    expect(readWatchState(path)).toEqual({ seenEventIds: [] });
  });

  test('readWatchState treats a corrupt file as first run (does not throw)', () => {
    const path = tmpPath();
    writeWatchState({ seenEventIds: [] }, path);
    // Overwrite with garbage
    require('node:fs').writeFileSync(path, 'not json{{{');
    expect(readWatchState(path)).toBeUndefined();
  });

  test('readWatchState treats an unexpected shape as first run (e.g. someone hand-edited in a ticker field)', () => {
    const path = tmpPath();
    require('node:fs').mkdirSync(require('node:path').dirname(path), { recursive: true });
    require('node:fs').writeFileSync(path, JSON.stringify({ seenEventIds: 'not-an-array' }));
    expect(readWatchState(path)).toBeUndefined();
  });

  test('★ persisted state never contains a 4-digit ticker code (design: state must not carry watchlist tickers)', () => {
    const path = tmpPath();
    const watchlistTickers = ['7203', '9432', '6758'];
    const state: WatchState = {
      lastDetectedAt: '2026-09-20T00:00:00.000Z',
      seenEventIds: ['a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'],
    };
    writeWatchState(state, path);
    const raw = require('node:fs').readFileSync(path, 'utf8');
    for (const ticker of watchlistTickers) {
      expect(raw.includes(ticker)).toBe(false);
    }
  });
});
