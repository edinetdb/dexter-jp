/**
 * `/watch` の公開 API。design §4.2「`/watch`: ウォッチリスト → 4 桁コード →
 * `get_events` を日付窓で引き、取り切るまでページを送る（上限 10 ページ、届かなければ
 * 『未取得あり』）。窓は前回と 1 日重ねてイベント ID で重複除去、取り切れた窓だけ
 * 前回位置を進める。基本の表示は開示の種別 + 公表時刻。Judge は開示の性質で 4 群に分ける…
 * どの群も捨てない（経過の報告は件数 + `/watch all`）」。
 *
 * `runWatch()` がこのファイル全体の配線: ウォッチリスト読み込み → 前回位置読み込み →
 * `/v1/events` 取得（`fetchEvents`）→ 前回位置の更新（`advanceState`、取り切れた時だけ
 * 永続化）→ パネル組み立て（`buildWatchPanel`）→ 出力 linter → 表示テキスト。
 */
import { assertOutputClean } from '../guard/output-linter.js';
import { fetchEvents, type EventsQuery, type FetchEventsOptions } from '../tools/finance/events.js';
import { buildWatchPanel, renderWatchPanel, type WatchPanel } from './panel.js';
import { dateOnlyMinusDays, isoMinusDays, advanceState } from './state.js';
import { readWatchState, writeWatchState, resolveWatchStatePath } from './state-store.js';
import { loadWatchlist, resolveWatchlistPath } from './watchlist.js';
import type { EventClassifier } from './types.js';

export * from './types.js';
export * from './classify.js';
export * from './state.js';
export * from './state-store.js';
export * from './watchlist.js';
export * from './panel.js';

/** 初回（前回位置が無い）ときに遡る日数。design「新規銘柄は初回だけ N 日遡る」の N。 */
export const DEFAULT_INITIAL_LOOKBACK_DAYS = 7;

/** 前回位置との重なり日数。design「窓は前回と 1 日重ねて」。 */
export const DEFAULT_OVERLAP_DAYS = 1;

export interface RunWatchOptions {
  /** `/watch all`。既定 false。 */
  all?: boolean;
  classifier?: EventClassifier;
  fetchImpl?: FetchEventsOptions['fetchImpl'];
  /** テスト注入用の時計。省略時は `Date`。 */
  now?: () => Date;
  watchStatePath?: string;
  watchlistPath?: string;
  initialLookbackDays?: number;
  overlapDays?: number;
  /** `fetchEvents` に渡す上限ページ数の上書き（テスト用）。 */
  maxPages?: number;
}

export interface RunWatchResult {
  panel: WatchPanel;
  text: string;
  /** 前回位置を実際に進めて永続化したか（取り切れたときだけ true）。 */
  stateAdvanced: boolean;
}

export async function runWatch(opts: RunWatchOptions = {}): Promise<RunWatchResult> {
  const overlapDays = opts.overlapDays ?? DEFAULT_OVERLAP_DAYS;
  const initialLookbackDays = opts.initialLookbackDays ?? DEFAULT_INITIAL_LOOKBACK_DAYS;
  const now = opts.now ?? (() => new Date());
  const watchStatePath = opts.watchStatePath ?? resolveWatchStatePath();
  const watchlistPath = opts.watchlistPath ?? resolveWatchlistPath();

  const { watchlist, issues: watchlistIssues } = loadWatchlist(watchlistPath);
  const prevState = readWatchState(watchStatePath);

  // 前回位置があれば detected_since（差分同期カーソル、T0b §5）で差分だけを引く。
  // 無ければ初回 = since を N 日遡って全件を引く（design「新規銘柄は初回だけ N 日遡る」。
  // 状態にウォッチリストの中身を持たない設計上、「新規銘柄」は「前回位置そのものが無い」
  // という形でしか表現できない — state.ts の冒頭コメント参照）。
  const query: EventsQuery = prevState?.lastDetectedAt
    ? { detected_since: isoMinusDays(prevState.lastDetectedAt, overlapDays) }
    : { since: dateOnlyMinusDays(now(), initialLookbackDays) };

  const fetchResult = await fetchEvents(query, {
    fetchImpl: opts.fetchImpl,
    maxPages: opts.maxPages,
  });

  const complete = !fetchResult.truncated;
  const { next, newEvents } = advanceState(prevState, fetchResult.events, {
    complete,
    overlapDays,
  });

  let stateAdvanced = false;
  if (complete) {
    writeWatchState(next, watchStatePath);
    stateAdvanced = true;
  }

  const panel = await buildWatchPanel(newEvents, watchlist, {
    all: opts.all,
    incomplete: fetchResult.truncated,
    windowSince: query.since ?? query.detected_since ?? '(不明)',
    windowUntil: query.until,
    watchlistIssues,
    classifier: opts.classifier,
    now: () => now().toISOString(),
  });

  // 記録・表示に出す直前の最後の検査。design §4.2「出力側の linter は当社が生成した
  // 文字列だけ」。ここが通れば `renderWatchPanel` はそのテキストをそのまま返してよい。
  assertOutputClean(panel, 'watch.panel');

  return { panel, text: renderWatchPanel(panel), stateAdvanced };
}
