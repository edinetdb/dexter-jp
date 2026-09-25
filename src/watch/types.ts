/**
 * `/watch` の型定義。設計 = design-v0.md §4.2「/watch」・§5（開示の性質 4 段）。
 * ここは純粋な型だけ（I/O なし）。
 */
import type { EdinetDbEvent } from '../tools/finance/events.js';

// ---------------------------------------------------------------------------
// 前回位置（.dexter/watch-state.json）
// ---------------------------------------------------------------------------

/**
 * `/watch` の前回位置。design §4.0「単一の時刻 + 既読イベント ID の集合
 * （銘柄コードを含まない）」。この型に銘柄コード・ウォッチリストの中身を
 * 表すフィールドを足さないこと（★state に 4 桁コードが現れると赤、review r2 M2）。
 */
export interface WatchState {
  /** 直近まで取り切った窓の detected_at 最大値（ISO8601）。undefined = まだ一度も取り切っていない。 */
  lastDetectedAt?: string;
  /** 直近の取り切り窓 + 重複除去の重なり分だけ持つ既読イベント ID（無限には増やさない）。 */
  seenEventIds: string[];
}

// ---------------------------------------------------------------------------
// ウォッチリスト（.dexter/watchlist.json、ローカルファイル）
// ---------------------------------------------------------------------------

export interface WatchlistEntry {
  /** 表示用ラベル。無ければ表示側で secCode/edinetCode から作る。 */
  label?: string;
  /** 証券コード（4 桁、東証）。 */
  secCode?: string;
  /** EDINET コード。 */
  edinetCode?: string;
}

export interface Watchlist {
  entries: WatchlistEntry[];
}

// ---------------------------------------------------------------------------
// 開示の性質 4 段（design §5、逐語）
// ---------------------------------------------------------------------------

export const GROUP_NAMES = [
  '経過・完了の報告',
  '組織・人事・軽微な取引',
  '業績予想・配当・自己株式・特別損益などの決定',
  '支配・上場・存続に関わる事項',
] as const;

export type GroupIndex = 0 | 1 | 2 | 3;

/**
 * `GroupIndex` に加えて `'uncertain'`（= 「要確認」）を持つ。design §4.1「Score は
 * 分布の最大クラスで仕分ける。最大確率 < 0.5 は『要確認』」・§4.2「『要確認』は最上段」。
 * 決定論の既定分類器（`classify.ts`）は確率を持たないので常に確信した `GroupIndex` を返し、
 * `'uncertain'` は返さない。Judge(Score) 版に差し替えたときに使われる。
 */
export type Group = GroupIndex | 'uncertain';

export interface EventClassification {
  group: Group;
  /** 'default' = コードの決定論の規則 / 'jev' = 判定層(Score) / それ以外 = 将来のバックエンド名。 */
  source: string;
}

/**
 * 分類器の注入点。design §4.2「群分けは Judge(Score) で行う設計だが…あなたは注入できる形
 * （分類関数を引数で受ける interface）にして、既定はコードの決定論の規則（event_type からの
 * 写像）にしておくこと。Judge との配線は別便がやる」。
 */
export interface EventClassifier {
  classify(event: EdinetDbEvent): EventClassification | Promise<EventClassification>;
}
