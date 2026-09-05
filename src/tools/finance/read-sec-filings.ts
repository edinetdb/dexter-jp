/**
 * 米国株版read_filings相当のツール。SEC EDGARから10-K/10-Qの定性セクション
 * (Business, Risk Factors, MD&A)を取得する(read-filings.ts/text-blocks.tsの
 * 米国株版)。
 *
 * 2026-08-12、米国株版MAGI深掘り(Dexter)のために新規作成。EDINET DB版のような
 * 構造化APIが無いため、以下のパイプラインで代替する:
 *   1. ティッカー→CIK解決(sec-edgar-client.ts、SEC公式company_tickers.json)
 *   2. 直近の10-K/10-Q提出書類一覧取得(sec-edgar-client.ts、submissions API)
 *   3. 書類本文HTML取得(数MB〜十数MB規模)
 *   4. Item番号ベースでセクションHTML片を切り出す(sec-edgar-sections.ts)
 *   5. TurndownでMarkdown化 → 長すぎる場合はLLMで要約(web-fetchのパターンを踏襲)
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { resolveTickerToCik, getRecentFilings } from './sec-edgar-client.js';
import { extractSectionHtml, sectionsForForm } from './sec-edgar-sections.js';
import { callLlm } from '../../model/llm.js';

export const READ_SEC_FILINGS_DESCRIPTION = `
Reads qualitative sections from a US company's SEC filings (10-K annual report or 10-Q quarterly report).

## When to Use

- Reading business overview, risk factors, or management's discussion and analysis (MD&A) for US-listed companies
- Analyzing business risks and challenges for a US ticker (e.g. AAPL, JPM)
- Understanding management's strategy and outlook from official SEC disclosures

## When NOT to Use

- Structured financial metrics (revenue, EPS, ROE) — use other financial data tools
- Japanese companies — use read_filings instead
- General web searches for news — use web_search

## Usage Notes

- Provide a US ticker symbol (e.g. 'AAPL', 'JPM', 'KO')
- Set form to '10-K' for annual (default) or '10-Q' for quarterly
- Set section to 'risk_factors', 'mda', or 'business' (10-K only); omit to get all available sections
- Source is SEC EDGAR (data.sec.gov / www.sec.gov), the official free US filing database
`.trim();

const ReadSecFilingsInputSchema = z.object({
  ticker: z.string().describe("US ticker symbol, e.g. 'AAPL', 'JPM', 'KO'."),
  form: z.enum(['10-K', '10-Q']).optional().describe("Filing type. Defaults to '10-K' (annual report)."),
  section: z
    .enum(['business', 'risk_factors', 'mda'])
    .optional()
    .describe(
      "Which section to retrieve: 'business' (10-K only), 'risk_factors', or 'mda' (Management's Discussion and Analysis). Omit to retrieve all sections available for the form type.",
    ),
});

// 10-K本文は数MB〜十数MBになるため、web-fetchの標準タイムアウト(15秒)より
// 長めに確保する。
const SEC_FETCH_TIMEOUT_MS = 45_000;
const SEC_USER_AGENT = 'investment-screener-dexter-us research contact@example.com';

// セクションHTML→Markdown変換後、これを超えたらLLMで要約する
// (web-fetch/utils.tsのMAX_MARKDOWN_LENGTHと同じ考え方、Dexter標準の
// エージェントコンテキストを圧迫しないための閾値)。
const MAX_SECTION_MARKDOWN_LENGTH = 20_000;

// 要約LLM(callLlmに渡すmodel、実質phi-4)へ渡す入力の文字数上限。2026-08-12、
// phi-4のネイティブ最大コンテキストが16,384トークンで頭打ち(lms loadで
// --context-lengthをそれ以上に指定しても実際には16,384に制限される、実測で
// 確認済み)と判明。実測(slice(0,100_000)文字→18,388トークン)から逆算し、
// システムプロンプト・要約指示文・LLM応答分の余裕を見て45,000文字
// (概算10,000トークン弱)に設定。
const MAX_SUMMARIZE_INPUT_LENGTH = 45_000;

type TurndownCtor = typeof import('turndown');
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined;
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then((m) => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default;
    return new Turndown();
  }));
}

async function summarizeIfTooLong(markdown: string, sectionLabel: string, model: string): Promise<string> {
  if (markdown.length <= MAX_SECTION_MARKDOWN_LENGTH) {
    return markdown;
  }
  // 2026-08-12、当初はweb-fetch/utils.tsのapplyPromptToMarkdownを踏襲し
  // getFastModel(resolveProvider(model).id, model)で「軽量モデル」に切り替えて
  // いたが、このプロジェクトはOPENAI_BASE_URLをローカルLM Studio(メインPC)に
  // 向けて運用しており、model(例: 'microsoft/phi-4')がproviders.tsのどの
  // プレフィックスにもマッチせずOpenAIプロバイダにフォールバック、その
  // fastModel('gpt-5.4-mini')がLM Studio上に存在せず400エラーになることを
  // 実地で確認した。getFastModel自体はAnthropic/OpenAI等クラウドプロバイダの
  // 軽量モデル切替を意図した仕組みで、ローカルLM Studio運用とは前提が
  // 噛み合わないため、ここでは呼び出し元から渡されたmodelをそのまま使う
  // (今ロード済みのモデルを使い回す方が、追加ロード失敗のリスクもない)。
  const { response } = await callLlm(
    `Summarize the following SEC filing section ("${sectionLabel}") in detail, preserving all specific facts, figures, and risk items. Aim for a comprehensive but token-efficient summary:\n\n${markdown.slice(0, MAX_SUMMARIZE_INPUT_LENGTH)}`,
    {
      model,
      systemPrompt: 'You are a financial document summarization assistant. Preserve concrete facts and figures.',
    },
  );
  if (typeof response === 'string') return response;
  const content = (response as { content?: unknown }).content;
  return typeof content === 'string' ? content : markdown.slice(0, MAX_SECTION_MARKDOWN_LENGTH);
}

export function createReadSecFilings(model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'read_sec_filings',
    description: READ_SEC_FILINGS_DESCRIPTION,
    schema: ReadSecFilingsInputSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
      const form = input.form ?? '10-K';

      onProgress?.(`Resolving ${input.ticker}...`);
      const resolved = await resolveTickerToCik(input.ticker);
      if (!resolved) {
        return formatToolResult({ error: `Could not find US ticker: ${input.ticker}` }, []);
      }

      onProgress?.(`Fetching ${form} filing list for ${resolved.title}...`);
      let filings;
      try {
        filings = await getRecentFilings(resolved.cik, [form], 1);
      } catch (error) {
        return formatToolResult(
          { error: 'Failed to fetch filing list', details: error instanceof Error ? error.message : String(error) },
          [],
        );
      }
      if (filings.length === 0) {
        return formatToolResult({ error: `No ${form} filings found for ${input.ticker}` }, []);
      }
      const filing = filings[0];

      onProgress?.(`Downloading ${form} (${filing.filingDate})...`);
      let html: string;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SEC_FETCH_TIMEOUT_MS);
        const resp = await fetch(filing.documentUrl, {
          headers: { 'User-Agent': SEC_USER_AGENT },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!resp.ok) {
          throw new Error(`${resp.status} ${resp.statusText}`);
        }
        html = await resp.text();
      } catch (error) {
        return formatToolResult(
          { error: 'Failed to download filing', details: error instanceof Error ? error.message : String(error) },
          [filing.documentUrl],
        );
      }

      const allSections = sectionsForForm(form);
      const targetKeys = input.section ? [input.section] : Object.keys(allSections);

      onProgress?.('Extracting sections...');
      const turndown = await getTurndownService();
      const results: Record<string, string> = {};
      const missing: string[] = [];

      for (const key of targetKeys) {
        const sectionDef = allSections[key];
        if (!sectionDef) continue; // section not applicable to this form (e.g. business for 10-Q)
        const sectionHtml = extractSectionHtml(html, sectionDef);
        if (!sectionHtml) {
          missing.push(key);
          continue;
        }
        const markdown = turndown.turndown(sectionHtml);
        results[key] = await summarizeIfTooLong(markdown, sectionDef.label, model);
      }

      if (Object.keys(results).length === 0) {
        return formatToolResult(
          {
            error: 'Could not extract any requested sections from the filing',
            missing,
            filingUrl: filing.documentUrl,
          },
          [filing.documentUrl],
        );
      }

      return formatToolResult(
        {
          ticker: input.ticker.toUpperCase(),
          companyName: resolved.title,
          form: filing.form,
          filingDate: filing.filingDate,
          sections: results,
          missingSection: missing.length > 0 ? missing : undefined,
        },
        [filing.documentUrl],
      );
    },
  });
}
