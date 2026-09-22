/**
 * ウォッチリスト（`.dexter/watchlist.json`、ローカルファイル）の読み込みと突合。
 * design §4.2「ウォッチリストはローカルファイル」。TradingView 接続は本便では作らない
 * （T5、design §4.3、β = R1 から外れている）。
 *
 * 形式（例）:
 * {
 *   "entries": [
 *     { "label": "トヨタ自動車", "secCode": "7203", "edinetCode": "E02144" },
 *     { "label": "非上場の例", "edinetCode": "E99999" }
 *   ]
 * }
 *
 * `secCode` / `edinetCode` の少なくとも一方が要る。両方持たせておくと
 * `matchWatchlist` の取りこぼしが減る（T0b §4: サンプルの 39/66 で sec_code が null、
 * 52/66 で edinet_code が null = 片方だけだと取りこぼす）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dexterPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import type { EdinetDbEvent } from '../tools/finance/events.js';
import type { Watchlist, WatchlistEntry } from './types.js';

export function resolveWatchlistPath(): string {
  return dexterPath('watchlist.json');
}

export interface LoadWatchlistResult {
  watchlist: Watchlist;
  /** 読み込み中に見つかった問題（ファイル不在・不正なエントリの除外 等）。fail-close ではなく「使えるものだけ使う」。 */
  issues: string[];
}

function isValidEntry(value: unknown): value is WatchlistEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.label !== undefined && typeof v.label !== 'string') return false;
  if (v.secCode !== undefined && typeof v.secCode !== 'string') return false;
  if (v.edinetCode !== undefined && typeof v.edinetCode !== 'string') return false;
  return typeof v.secCode === 'string' || typeof v.edinetCode === 'string';
}

/** ファイルが無ければ空のウォッチリスト + 作成案内を issues に返す（例外にしない）。 */
export function loadWatchlist(path: string = resolveWatchlistPath()): LoadWatchlistResult {
  if (!existsSync(path)) {
    return {
      watchlist: { entries: [] },
      issues: [`ウォッチリストが見つかりません（${path}）。まず銘柄を登録してください。`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { watchlist: { entries: [] }, issues: [`ウォッチリストの読み込みに失敗しました: ${message}`] };
  }

  const rawEntries = Array.isArray((parsed as { entries?: unknown })?.entries)
    ? ((parsed as { entries: unknown[] }).entries)
    : [];

  const entries: WatchlistEntry[] = [];
  const issues: string[] = [];
  for (const [i, raw] of rawEntries.entries()) {
    if (isValidEntry(raw)) {
      entries.push(raw);
    } else {
      issues.push(`ウォッチリストの ${i} 番目のエントリを無視しました（secCode か edinetCode が要ります）。`);
    }
  }

  if (entries.length === 0 && issues.length === 0) {
    issues.push('ウォッチリストは空です。');
  }

  return { watchlist: { entries }, issues };
}

export function writeWatchlist(watchlist: Watchlist, path: string = resolveWatchlistPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(watchlist, null, 2)}\n`, 'utf8');
  logger.debug(`[watch] wrote watchlist (${watchlist.entries.length} entries) to ${path}`);
}

/**
 * イベントに一致するウォッチリストのエントリを全部返す（sec_code と edinet_code の
 * 両方で当てる。design §4.2「両方で当てる」、T0b §4 の根拠は上のコメント）。
 * 通常は 0〜1 件だが、ウォッチリストに重複登録があれば複数返りうる。
 */
export function matchWatchlist(event: EdinetDbEvent, watchlist: Watchlist): WatchlistEntry[] {
  return watchlist.entries.filter((entry) => {
    if (entry.secCode && event.sec_code && entry.secCode === event.sec_code) return true;
    if (entry.edinetCode && event.edinet_code && entry.edinetCode === event.edinet_code) return true;
    return false;
  });
}

export function watchlistEntryLabel(entry: WatchlistEntry): string {
  return entry.label ?? entry.secCode ?? entry.edinetCode ?? '(不明な銘柄)';
}
