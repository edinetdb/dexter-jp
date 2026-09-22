/**
 * `GET /v1/events` クライアント（EDINET DB 公開 REST）。
 *
 * 実測記録 = `~/Desktop/tmp/dexter-kotae/T0b-events-api.md`（T0b、2026-09-22）。
 * ここに書く挙動は全て T0b の実測に基づく。推測で埋めない。
 *
 * `api.ts` の `api.get` はそのまま使わない:
 *   1) `api.get` は `data.next_page_url` を追尾してページを連結するが、`/events` の応答に
 *      `next_page_url` は無い（T0b §2）。offset/limit 方式（`meta.pagination`）なので、
 *      `api.get` に投げると 1 ページ目（既定 limit 件）で黙って止まる。
 *   2) `/events` は日付窓で毎回取り直す（design §4.2「取り切るまでページを送る」）ため、
 *      `api.get` の `cacheable` 経由の永続キャッシュとは相性が悪い（`/watch` 側で前回位置を
 *      別途管理する。`src/watch/state.ts` 参照）。
 *
 * 銘柄コードでは絞り込まない（`sec_code` / `edinet_code` パラメータをこのクライアントは
 * 実装しない）: T0b §6 の実測で `sec_code`/`edinet_code` はカンマ区切り複数指定に対応せず
 * 先頭 1 件だけが黙って採用されることが分かった。複数銘柄を安全に絞り込むには銘柄ごとに
 * 1 リクエストが要り、無料枠なら 40 銘柄程度が上限になる（設計 B、T0b §7）。
 * `/watch` はサーバー側フィルタを使わず、日付窓で全件取得してから端末側で
 * ウォッチリストと突合する（`src/watch/match.ts`）。将来このクライアントに銘柄フィルタを
 * 足す誘惑を断つため、意図的に型からも外してある。
 */
import { logger } from '../../utils/logger.js';

const EVENTS_BASE_URL = 'https://edinetdb.jp/v1';
const EVENTS_ENDPOINT = '/events';

/** サーバーが許す 1 ページの最大件数（T0b §1・§8: 1001 を送ると 400 ではなく 1000 へ silent clamp）。 */
export const MAX_PAGE_LIMIT = 1000;

/** `fetchEvents` が送る既定の 1 ページあたりの件数。無指定なら常に最大を要求し、往復回数を減らす。 */
export const DEFAULT_PAGE_LIMIT = MAX_PAGE_LIMIT;

/** 取り切りの上限ページ数（design §4.2「取り切るまでページを送る（上限 10 ページ）」）。 */
export const MAX_PAGES = 10;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 1 イベントの全フィールド（T0b §4 で実測した全キー集合。推測の追加なし）。
 * `severity` はここには実在するが、`/watch` 側はこれを記録・表示・ログのどこにも
 * 通さない（design §4.2、テストで固定）。
 */
export interface EdinetDbEvent {
  event_id: string;
  event_date: string;
  event_type: string;
  event_category: string;
  severity: 'low' | 'medium' | 'high' | 'critical' | null;
  edinet_code: string | null;
  sec_code: string | null;
  filer_name: string;
  title: string;
  /** ISO8601・マイクロ秒精度・UTC。T0b §4: 全サンプルで非null。 */
  detected_at: string;
  event_timestamp: string | null;
  fiscal_year: number | null;
  quarter: string | null;
  source: string | null;
  source_id: string | null;
  corrects_event_id: string | null;
  /** T0b §4: 全サンプルで null。要約は API から来ない前提で扱う。 */
  summary: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * 呼び出し側が指定できるクエリ。`sec_code` / `edinet_code` は意図的に無い（上記コメント）。
 */
export interface EventsQuery {
  /** YYYY-MM-DD。省略時のサーバー既定 = today-7（`detected_since` 指定時は today-35、T0b §1・§5）。 */
  since?: string;
  /** YYYY-MM-DD。省略時のサーバー既定 = today。 */
  until?: string;
  /** カンマ区切り複数対応（T0b §1・§6）。 */
  event_type?: readonly string[];
  event_category?: string;
  /** カンマ区切り複数対応（T0b §1・§6）。 */
  severity?: readonly string[];
  /** ISO8601。差分同期カーソル。指定すると `since` の既定窓が 35 日に広がる（T0b §5）。 */
  detected_since?: string;
  /** 1 ページの件数。省略時は `DEFAULT_PAGE_LIMIT`（= 最大値）。1000 超は送らない。 */
  limit?: number;
}

export interface FetchEventsOptions {
  /** 注入可能（既定は global fetch）。テストは必ず注入し、実 API へは出ない。 */
  fetchImpl?: FetchLike;
  /** テスト用の上限ページ数上書き。省略時は `MAX_PAGES`。 */
  maxPages?: number;
}

export interface FetchEventsResult {
  events: EdinetDbEvent[];
  /**
   * true = `maxPages` に当たり、まだ取り切れていない残りがある（「未取得あり」）。
   * `/watch` 側はこれを見て前回位置を進めない（design §4.2）。
   */
  truncated: boolean;
  /** 要求した `limit` をサーバーがそのまま採用しなかったことを検知したか（T0b §1・§8）。 */
  limitClamped: boolean;
  pagesFetched: number;
  /** サーバーが報告した対象件数（最後に読んだページの `meta.pagination.total`）。1 ページも読めなければ undefined。 */
  total?: number;
}

interface EventsPageMeta {
  pagination?: {
    limit?: number;
    offset?: number;
    next_offset?: number;
    total?: number;
  };
}

interface EventsPageResponse {
  data?: unknown;
  meta?: EventsPageMeta;
}

function getApiKey(): string {
  return process.env.EDINETDB_API_KEY || '';
}

function buildUrl(query: EventsQuery, offset: number, limit: number): string {
  const url = new URL(`${EVENTS_BASE_URL}${EVENTS_ENDPOINT}`);
  const params: Record<string, string | undefined> = {
    since: query.since,
    until: query.until,
    event_category: query.event_category,
    detected_since: query.detected_since,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.append(key, value);
    }
  }
  for (const eventType of query.event_type ?? []) {
    url.searchParams.append('event_type', eventType);
  }
  for (const severity of query.severity ?? []) {
    url.searchParams.append('severity', severity);
  }
  url.searchParams.append('limit', String(limit));
  url.searchParams.append('offset', String(offset));
  return url.toString();
}

/**
 * `api.ts` の `executeRequest` に合わせた、鍵・エラー・ログの扱い。
 * ここだけの理由でエラーメッセージの prefix を `[EDINET DB API] events:` にして、
 * `api.ts` 経由の呼び出しログと区別できるようにしている。
 */
async function requestPage(
  url: string,
  fetchImpl: FetchLike,
): Promise<EventsPageResponse> {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('[EDINET DB API] events: call without key');
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { 'X-API-Key': apiKey },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[EDINET DB API] events: network error — ${message}`);
    throw new Error(`[EDINET DB API] events: request failed: ${message}`);
  }

  if (!response.ok) {
    const detail = `${response.status} ${response.statusText}`;
    logger.error(`[EDINET DB API] events: error — ${detail}`);
    throw new Error(`[EDINET DB API] events: request failed: ${detail}`);
  }

  const body = await response.json().catch(() => {
    const detail = `invalid JSON (${response.status} ${response.statusText})`;
    logger.error(`[EDINET DB API] events: parse error — ${detail}`);
    throw new Error(`[EDINET DB API] events: request failed: ${detail}`);
  });

  return body as EventsPageResponse;
}

/**
 * `/v1/events` を offset を手で回して取り切る（`meta.pagination.next_offset` ではなく
 * `offset + 受信件数 >= total` で「まだ続きがあるか」を判定する。T0b §2 の実測どおり
 * `next_offset` は残件の有無に関わらず `offset + limit` を機械的に返しうるため、
 * それだけで継続判定すると空振りページを 1 回余分に叩く恐れがある）。
 *
 * 上限 `maxPages`（既定 `MAX_PAGES`）に当たったら打ち切り、`truncated: true` を返す
 * （エラーにしない = 呼び出し側が「未取得あり」を明示できるようにする）。
 */
export async function fetchEvents(
  query: EventsQuery,
  opts: FetchEventsOptions = {},
): Promise<FetchEventsResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const requestedLimit = Math.min(query.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);

  const events: EdinetDbEvent[] = [];
  let offset = 0;
  let page = 0;
  let total: number | undefined;
  let limitClamped = false;
  let truncated = false;

  while (page < maxPages) {
    const url = buildUrl(query, offset, requestedLimit);
    const body = await requestPage(url, fetchImpl);
    page++;

    const pageData = Array.isArray(body.data) ? (body.data as EdinetDbEvent[]) : [];
    events.push(...pageData);

    const pagination = body.meta?.pagination;
    total = pagination?.total;
    if (typeof pagination?.limit === 'number' && pagination.limit !== requestedLimit) {
      limitClamped = true;
    }

    if (pageData.length === 0) {
      // 空振り。これ以上続けても取れない。
      break;
    }
    if (typeof total === 'number' && offset + pageData.length >= total) {
      // 取り切った。
      break;
    }
    if (page >= maxPages) {
      truncated = true;
      break;
    }
    offset += pageData.length;
  }

  return { events, truncated, limitClamped, pagesFetched: page, total };
}
