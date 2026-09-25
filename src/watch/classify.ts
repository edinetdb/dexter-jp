/**
 * 開示の性質 4 段の既定分類器（決定論・`event_type`/`event_category` からの写像）。
 *
 * これはプレースホルダ。design §4.2「群分けは Judge(Score) で行う設計だが…既定は
 * コードの決定論の規則にしておくこと。Judge との配線は別便がやる」。この関数は
 * `EventClassifier` interface を満たす形にしてあるので、Judge(Score) 版に
 * 差し替えても呼び出し側（`src/watch/panel.ts`）は変わらない。
 *
 * `event_type` の全量の enum は実測できていない（T0b は `earnings_summary` 等の
 * 一部のみ確認）。未知の種別は安全側（group 0 = 「経過・完了の報告」）に倒す。
 * 優先順位:
 *   1. LOW_PRIORITY_MARKERS に当たれば group 0（経過・完了・訂正の報告は、他の強い
 *      シグナルと同居していても基本は経過報告として扱う。例: 自己株式取得の
 *      「決定」ではなく「完了」は group 0）
 *   2. CONTROL_MARKERS に当たれば group 3（支配・上場・存続）
 *   3. DECISION_MARKERS に当たれば group 2（業績予想・配当・自己株式・特別損益の決定）
 *   4. ORG_MARKERS に当たれば group 1（組織・人事・軽微な取引）
 *   5. それ以外は group 0（未知は最も低い段に倒す。design「どの群も捨てない」と対で、
 *      過大な扱いをしない）
 */
import type { EdinetDbEvent } from '../tools/finance/events.js';
import type { EventClassification, EventClassifier, GroupIndex } from './types.js';

const LOW_PRIORITY_MARKERS: readonly string[] = [
  'completion', 'completed', 'progress', 'status_report', 'execution_status',
  'filing', 'summary', 'correction', 'resumption', 'extension', 'confirmation',
];

const CONTROL_MARKERS: readonly string[] = [
  'delisting', 'going_concern', 'bankruptcy', 'civil_rehabilitation',
  'corporate_reorganization', 'tender_offer', 'merger', 'business_combination',
  'share_exchange', 'share_transfer', 'company_split', 'control_change',
  'major_shareholder_change', 'squeeze_out', 'liquidation',
];

const DECISION_MARKERS: readonly string[] = [
  'forecast_revision', 'earnings_forecast', 'dividend_forecast', 'dividend_decision',
  'dividend', 'buyback_decision', 'buyback_announcement', 'treasury_stock_acquisition',
  'treasury_stock', 'extraordinary_gain', 'extraordinary_loss', 'special_gain',
  'special_loss', 'impairment',
];

const ORG_MARKERS: readonly string[] = [
  'officer_change', 'director_change', 'organization_change', 'subsidiary_change',
  'minor_transaction', 'representative_change', 'personnel',
];

function firstMatch(haystack: string, markers: readonly string[]): boolean {
  return markers.some((marker) => haystack.includes(marker));
}

/** 決定論のデフォルト分類。純関数（I/O なし）。 */
export function defaultClassify(event: EdinetDbEvent): EventClassification {
  const haystack = `${event.event_type ?? ''} ${event.event_category ?? ''}`.toLowerCase();

  let group: GroupIndex = 0;
  if (firstMatch(haystack, LOW_PRIORITY_MARKERS)) {
    group = 0;
  } else if (firstMatch(haystack, CONTROL_MARKERS)) {
    group = 3;
  } else if (firstMatch(haystack, DECISION_MARKERS)) {
    group = 2;
  } else if (firstMatch(haystack, ORG_MARKERS)) {
    group = 1;
  }

  return { group, source: 'default' };
}

/** `EventClassifier` を満たす既定実装。呼び出し側はこれを渡すか、独自の実装を注入する。 */
export const defaultClassifier: EventClassifier = {
  classify: defaultClassify,
};
