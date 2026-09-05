/**
 * SEC EDGARの10-K/10-Q本文から、Item番号ベースでセクション(Risk Factors, MD&A等)
 * を抽出する。
 *
 * 2026-08-12、米国株版MAGI深掘り用に新規作成。SEC規則(Regulation S-K)により
 * 10-Kの構成は全上場企業でItem番号が共通のため(Item 1=Business, Item 1A=Risk
 * Factors, Item 7=MD&A等)、この共通構造を前提にHTMLから該当区間を切り出す。
 * EDINET DB(text-blocks.ts)のように構造化APIが存在しないため、ここでの
 * 正規表現ベースの抽出が構造化データ取得の代替になる。
 *
 * 10-K本文はしばしば10MB超のHTMLになるため、Turndown(HTML→Markdown変換)を
 * かける前にItem区切りでHTML片を切り出し、変換対象を最小化してから処理する
 * (全文を先にMarkdown化すると重い上、後段のLLM要約でもトークン超過しやすい)。
 */

// 10-K(年次報告書)の主要Item。米国株深掘りで意味のある定性情報に絞る
// (財務諸表そのものはget_financials相当を別途作る場合に回す想定、今回は
// 定性セクションのみでまず実用範囲を作る)。
export const TEN_K_SECTIONS: Record<string, { start: RegExp; end: RegExp; label: string }> = {
  business: {
    start: /Item\s+1\.\s*Business/i,
    end: /Item\s+1A\.\s*Risk\s+Factors/i,
    label: 'Business Overview (Item 1)',
  },
  risk_factors: {
    start: /Item\s+1A\.\s*Risk\s+Factors/i,
    end: /Item\s+1B\./i,
    label: 'Risk Factors (Item 1A)',
  },
  mda: {
    start: /Item\s+7\.\s*Management.s\s+Discussion/i,
    end: /Item\s+7A\./i,
    label: "Management's Discussion and Analysis (Item 7)",
  },
};

// 10-Q(四半期報告書)は10-Kよりずっと簡素な構成(Part I/II、Item番号体系も別)。
export const TEN_Q_SECTIONS: Record<string, { start: RegExp; end: RegExp; label: string }> = {
  mda: {
    start: /Item\s+2\.\s*Management.s\s+Discussion/i,
    end: /Item\s+3\./i,
    label: "Management's Discussion and Analysis (Item 2)",
  },
  risk_factors: {
    start: /Item\s+1A\.\s*Risk\s+Factors/i,
    end: /Item\s+2\./i,
    label: 'Risk Factors (Item 1A)',
  },
};

const MAX_SECTION_HTML_LENGTH = 500_000; // 1セクションあたりの上限(HTML片、暴走防止)

/**
 * 全文HTMLから指定セクションのHTML片を切り出す。開始マーカーが複数回出現する
 * (目次と本文の両方に見出しが出るのが典型)ため、2回目以降の出現(本文側)を
 * 使う。見つからなければnullを返す(その報告書にセクションが無い/表記揺れ)。
 */
export function extractSectionHtml(
  fullHtml: string,
  section: { start: RegExp; end: RegExp },
): string | null {
  const startMatches = [...fullHtml.matchAll(new RegExp(section.start.source, section.start.flags + 'g'))];
  if (startMatches.length === 0) return null;

  // 目次(TOC)には通常ページ番号やリンクが付随し本文より短い間隔で見出しが
  // 並ぶため、複数マッチがあれば最後の出現(=本文側)を本文開始とみなす。
  const startIdx = startMatches[startMatches.length - 1].index!;

  const endMatch = fullHtml.slice(startIdx).match(section.end);
  const endIdx = endMatch?.index !== undefined ? startIdx + endMatch.index : fullHtml.length;

  const sliceEnd = Math.min(endIdx, startIdx + MAX_SECTION_HTML_LENGTH);
  return fullHtml.slice(startIdx, sliceEnd);
}

/** フォーム種別("10-K" | "10-Q")に応じたセクション定義を返す。 */
export function sectionsForForm(form: string): Record<string, { start: RegExp; end: RegExp; label: string }> {
  return form.toUpperCase() === '10-Q' ? TEN_Q_SECTIONS : TEN_K_SECTIONS;
}
