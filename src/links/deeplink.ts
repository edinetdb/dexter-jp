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

/** 4 桁の証券コードとして扱える形か（東証の内国株 = 4 桁）。 */
export function isTseFourDigit(code: string | null | undefined): code is string {
  return typeof code === 'string' && /^[0-9]{4}$/.test(code);
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
  if (isTseFourDigit(params.secCode)) {
    links.push({
      label: 'チャート（TradingView）',
      url: `https://jp.tradingview.com/symbols/TSE-${params.secCode}/`,
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
