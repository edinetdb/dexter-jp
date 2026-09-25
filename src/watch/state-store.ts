/**
 * `.dexter/watch-state.json` の読み書き。I/O のみ（純粋ロジックは `state.ts`）。
 * `src/gateway/sessions/store.ts` と同じ作法: パスを明示的に渡す（テストしやすい）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dexterPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import type { WatchState } from './types.js';

export function resolveWatchStatePath(): string {
  return dexterPath('watch-state.json');
}

function isValidState(value: unknown): value is WatchState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.lastDetectedAt !== undefined && typeof v.lastDetectedAt !== 'string') return false;
  if (!Array.isArray(v.seenEventIds)) return false;
  return v.seenEventIds.every((id) => typeof id === 'string');
}

/** ファイルが無ければ undefined（= 初回）。壊れていれば警告して undefined 扱い（初回として再開）。 */
export function readWatchState(path: string = resolveWatchStatePath()): WatchState | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isValidState(parsed)) {
      logger.warn(`[watch] state file has an unexpected shape, treating as first run: ${path}`);
      return undefined;
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[watch] failed to read state file, treating as first run: ${message}`);
    return undefined;
  }
}

export function writeWatchState(state: WatchState, path: string = resolveWatchStatePath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
