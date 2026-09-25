/**
 * 前回位置（`WatchState`）の純粋なロジック。I/O なし（永続化は `state-store.ts`）。
 *
 * design §4.2:
 *   「窓は前回と 1 日重ねてイベント ID で重複除去、取り切れた窓だけ前回位置を進める」
 * design §4.0:
 *   「.dexter/watch-state.json = 単一の時刻 + 既読イベント ID の集合（銘柄コードを含まない）」
 *
 * `seenEventIds` を無限に増やさない設計: 次回の取得窓は必ず
 * `[lastDetectedAt - overlapDays, ...]` から始まる。だから「次回また出てきうる ID」は
 * 「今回の取得の中で detected_at が (次回位置の) 重なり床以降だったもの」だけに限られる。
 * 過去の watch-state.json に入っていた ID をそのまま引きずる必要が無い
 * （引きずらなくても、境界より古いイベントは次回 `since` に入らないので再取得されない）。
 */
import type { EdinetDbEvent } from '../tools/finance/events.js';
import type { WatchState } from './types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** ISO8601 文字列から `days` 日引いた ISO8601 文字列を返す。 */
export function isoMinusDays(iso: string, days: number): string {
  const d = new Date(iso);
  return new Date(d.getTime() - days * MS_PER_DAY).toISOString();
}

/** `date` から `days` 日引いた日付部分だけ（YYYY-MM-DD、UTC）。`/v1/events` の `since` の形式。 */
export function dateOnlyMinusDays(date: Date, days: number): string {
  return new Date(date.getTime() - days * MS_PER_DAY).toISOString().slice(0, 10);
}

function maxIso(a: string | undefined, b: string): string {
  if (!a) return b;
  return a >= b ? a : b;
}

export interface AdvanceStateOptions {
  /** この取得窓が「取り切れた」か（`fetchEvents` の `!truncated` に対応）。 */
  complete: boolean;
  /** 次回の窓を今回の位置と何日重ねるか。design「1 日重ねて」。 */
  overlapDays: number;
}

export interface AdvanceStateResult {
  next: WatchState;
  /** 今回の取得の中で、前回までに見ていない（重複除去済みの）イベント。表示に使う。 */
  newEvents: EdinetDbEvent[];
}

/**
 * 取得結果から次の `WatchState` を計算する。
 *
 * - `complete: false`（ページ溢れ・取得失敗）のときは **前回位置を進めない**
 *   （★ 動かすと design の「取り切れた窓だけ前回位置を進める」に反する = 赤）。
 *   ただし新規イベントの検出（重複除去）自体は行う（呼び出し側の表示用）。
 * - `complete: true` のときだけ `lastDetectedAt` を進め、`seenEventIds` を
 *   次回の重なり窓分だけに絞って書き換える。
 */
export function advanceState(
  prev: WatchState | undefined,
  fetched: readonly EdinetDbEvent[],
  opts: AdvanceStateOptions,
): AdvanceStateResult {
  const prevSeen = new Set(prev?.seenEventIds ?? []);
  const seenInThisBatch = new Set<string>();
  const newEvents: EdinetDbEvent[] = [];

  for (const event of fetched) {
    if (prevSeen.has(event.event_id) || seenInThisBatch.has(event.event_id)) {
      continue;
    }
    seenInThisBatch.add(event.event_id);
    newEvents.push(event);
  }

  if (!opts.complete) {
    return { next: prev ?? { seenEventIds: [] }, newEvents };
  }

  if (fetched.length === 0) {
    // 何も取れなかった（空振り）。前回位置を完全に据え置く。
    //
    // ここで seenEventIds を空へ作り直すと、境界近くの既読 ID を忘れてしまい、
    // 次に同じイベントが（重なり窓の範囲内で）再度返ってきたときに「新規」として
    // 誤って再表示してしまう（fetched が空でも lastDetectedAt は変わらない =
    // 次回の重なり床も変わらないため、prev.seenEventIds をそのまま引き継ぐ必要がある）。
    return { next: prev ?? { seenEventIds: [] }, newEvents: [] };
  }

  let maxDetectedAt = prev?.lastDetectedAt;
  for (const event of fetched) {
    maxDetectedAt = maxIso(maxDetectedAt, event.detected_at);
  }
  // fetched.length > 0 が保証されているので maxDetectedAt は必ず truthy。
  const floor = isoMinusDays(maxDetectedAt as string, opts.overlapDays);
  const seenEventIds = fetched
    .filter((event) => event.detected_at >= floor)
    .map((event) => event.event_id);

  return {
    next: { lastDetectedAt: maxDetectedAt, seenEventIds },
    newEvents,
  };
}
