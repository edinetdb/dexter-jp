/**
 * SEC EDGAR(米国証券取引委員会の公式開示データベース)への薄いクライアント。
 *
 * 2026-08-12、米国株版MAGI深掘り(Dexter)のために新規作成。EDINET DB(api.ts)とは
 * 異なりSEC EDGARは完全無料・APIキー不要の公式データベースで、User-Agentヘッダー
 * (連絡先メールアドレス含む)を明示することだけがマナー上求められる
 * (https://www.sec.gov/os/webmaster-faq#developers 参照)。
 *
 * ティッカー→CIK(EDGAR固有の企業ID)のマッピングはSEC公式のcompany_tickers.json
 * (日次更新・全上場企業網羅)を使う。個別のfull-text searchやEDGAR自体の検索APIは
 * レート制限が厳しい/認証が必要なケースがあるため、まずこの軽量な公式JSONで
 * 完結させる設計にした。
 */
import { logger } from '../../utils/logger.js';

const SEC_USER_AGENT = 'investment-screener-dexter-us research contact@example.com';

// ティッカー一覧はSEC側で日次更新される数百KB程度のJSON。プロセス内で1回だけ
// 取得しメモリキャッシュする(EDINET版resolver.tsのcodeCacheと同じ発想)。
let tickerMapPromise: Promise<Map<string, { cik: string; title: string }>> | undefined;

interface CompanyTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

async function fetchTickerMap(): Promise<Map<string, { cik: string; title: string }>> {
  const resp = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': SEC_USER_AGENT },
  });
  if (!resp.ok) {
    throw new Error(`[SEC EDGAR] company_tickers.json fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as Record<string, CompanyTickerEntry>;
  const map = new Map<string, { cik: string; title: string }>();
  for (const entry of Object.values(data)) {
    // CIKは10桁ゼロ埋めがdata.sec.gov側のURL規約
    map.set(entry.ticker.toUpperCase(), {
      cik: String(entry.cik_str).padStart(10, '0'),
      title: entry.title,
    });
  }
  return map;
}

/** ティッカー(例: "AAPL")からCIKと正式社名を解決する。見つからなければnull。 */
export async function resolveTickerToCik(
  ticker: string,
): Promise<{ cik: string; title: string } | null> {
  tickerMapPromise ??= fetchTickerMap();
  const map = await tickerMapPromise;
  return map.get(ticker.toUpperCase().trim()) ?? null;
}

export interface FilingSummary {
  form: string; // "10-K" | "10-Q" | "8-K" 等
  filingDate: string; // YYYY-MM-DD
  accessionNumber: string;
  primaryDocument: string;
  /** 実際の書類本文へのHTML URL(そのままweb_fetch/getURLMarkdownContentに渡せる) */
  documentUrl: string;
}

/**
 * 指定CIKの直近の提出書類一覧を取得し、formsで絞り込む(例: ["10-K", "10-Q"])。
 * SEC EDGARのsubmissions APIは無料・APIキー不要。
 *
 * 2026-08-12、当初`recent`配列の先頭200件だけを見る実装にしていたが、
 * JPMのような取引の多い大企業は8-K/Form4/424B2等の頻出書類に埋もれ、
 * 10-Kが13,351番目にしか出現せず0件が返る不具合が実データ検証で発覚した。
 * submissions APIの`recent`配列自体には直近の全提出(JPMの場合25,747件)が
 * 含まれている(古いものは`filings.files`の別ページに分割される仕組みで、
 * `recent`自体を全走査すれば追加リクエストなしで解決する)ため、上限を撤廃し
 * 全件ループする。文字列比較のみの軽量なループなので数万件でも高速。
 */
export async function getRecentFilings(
  cik: string,
  forms: string[],
  limit = 5,
): Promise<FilingSummary[]> {
  const resp = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { 'User-Agent': SEC_USER_AGENT },
  });
  if (!resp.ok) {
    throw new Error(`[SEC EDGAR] submissions fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as {
    filings: {
      recent: {
        form: string[];
        filingDate: string[];
        accessionNumber: string[];
        primaryDocument: string[];
      };
    };
  };

  const recent = data.filings.recent;
  const formSet = new Set(forms.map((f) => f.toUpperCase()));
  const results: FilingSummary[] = [];

  for (let i = 0; i < recent.form.length && results.length < limit; i++) {
    const form = recent.form[i];
    if (!formSet.has(form.toUpperCase())) continue;

    const accessionNumber = recent.accessionNumber[i];
    const accessionNoDashes = accessionNumber.replace(/-/g, '');
    const primaryDocument = recent.primaryDocument[i];
    // CIKはURLパスでは先頭ゼロを含めない形式が使われる
    const cikNoLeadingZeros = String(Number(cik));
    const documentUrl = `https://www.sec.gov/Archives/edgar/data/${cikNoLeadingZeros}/${accessionNoDashes}/${primaryDocument}`;

    results.push({
      form,
      filingDate: recent.filingDate[i],
      accessionNumber,
      primaryDocument,
      documentUrl,
    });
  }

  if (results.length === 0) {
    logger.warn(`[SEC EDGAR] no filings found for CIK ${cik} with forms ${forms.join(',')}`);
  }
  return results;
}
