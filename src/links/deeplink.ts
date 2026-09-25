/**
 * 出力に添える外部リンク（`tv-max-permissible-v0.md` 案 3 = white、R1 に入れてよいと裁定済み）。
 *
 * **URL を組み立てるだけ**。取得も認証もしない。TradingView の API・MCP には触れない
 * （本 release は β = TradingView 接続なし）。人がリンクを開いて自分の目で見るための 1 行。
 *
 * `/check` と `/watch` で**同じ関数**を使う（kickoff T3・T4）。
 */

/** utm の出所。CLI から出すものと README に書くもので分ける。 */
export const UTM_CLI = 'utm_source=dexter-cli';
export const UTM_README = 'utm_source=github&utm_medium=readme&utm_campaign=dexter-kotaeawase';

export interface DeepLink {
  label: string;
  url: string;
}

/**
 * 東証の 4 桁コードに正規化する。
 *
 * EDINET DB の `sec_code` は **5 桁**で返る（トヨタ = `72030`。EDINET / 金商法系の
 * 書式で、末尾に 0 を足した形）。4 桁だけを受ける実装にしていると、
 * **実データでは TradingView のリンクが 1 本も出ない**（実測 2026-09-23）。
 *
 * 5 桁で末尾が `0` のときだけ落とす。`7203A` のような英字付き（2024 年以降の新形式）は
 * 4 桁に落とさず、リンクを出さない側に倒す（誤ったチャートへ飛ばさないため）。
 */
export function toTseFourDigit(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  if (/^[0-9]{4}$/.test(trimmed)) return trimmed;
  if (/^[0-9]{4}0$/.test(trimmed)) return trimmed.slice(0, 4);
  return null;
}

/** 4 桁の証券コードとして扱える形か（5 桁の EDINET 形式も含む）。 */
export function isTseFourDigit(code: string | null | undefined): boolean {
  return toTseFourDigit(code) !== null;
}

/**
 * 銘柄に添えるリンクを作る。
 *
 * - 4 桁コードがあるとき = TradingView のチャートと EDINET DB の 2 行
 * - 無いとき（東証以外・解釈できないシンボル）= **EDINET DB の 1 行だけ**
 * - EDINET コードも無いときは 0 行（空配列。「リンクなし」を無理に作らない）
 */
export function deepLinksFor(params: {
  secCode?: string | null;
  edinetCode?: string | null;
}): DeepLink[] {
  const links: DeepLink[] = [];
  const four = toTseFourDigit(params.secCode);
  if (four) {
    links.push({
      label: 'チャート（TradingView）',
      url: `https://jp.tradingview.com/symbols/TSE-${four}/`,
    });
  }
  if (params.edinetCode) {
    links.push({
      label: '企業ページ（EDINET DB）',
      url: `https://edinetdb.jp/companies/${params.edinetCode}?${UTM_CLI}`,
    });
  }
  return links;
}
