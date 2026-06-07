import { DynamicStructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { AIMessage, ToolCall } from '@langchain/core/messages';
import { z } from 'zod';
import { callLlm } from '../../model/llm.js';
import { formatToolResult } from '../types.js';
import { getCurrentDate } from '../../agent/prompts.js';
import { withTimeout, SUB_TOOL_TIMEOUT_MS } from './utils.js';

/**
 * Rich description for the get_financials tool.
 */
export const GET_FINANCIALS_DESCRIPTION = `
Intelligent meta-tool for retrieving Japanese company financial data. Takes a natural language query and automatically routes to appropriate financial data sources.

## When to Use

- Company facts (name, industry, securities code, accounting standard)
- Company financials (revenue, operating income, net income, total assets, equity, cash flows)
- Financial metrics and key ratios (ROE, ROIC, operating margin, EPS, PER, dividend yield)
- Historical financial time series and trend analysis
- AI-powered company analysis and health scoring
- Earnings disclosures (TDNet 決算短信)
- Multi-company comparisons

## When NOT to Use

- Reading securities report text content (use read_filings instead)
- Stock screening by criteria (use company_screener)
- Shareholder ownership data (use get_shareholders)
- General web searches (use web_search)

## Usage Notes

- Call ONCE with the complete natural language query - the tool handles complexity internally
- Handles ticker resolution automatically (7203 → Toyota, トヨタ → E02144)
- Returns structured JSON data with source URLs for verification
- Securities codes (4-digit numbers like 7203) and company names (トヨタ, Sony) both work
`.trim();

/** Format snake_case tool name to Title Case for progress messages */
function formatSubToolName(name: string): string {
  return name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Import all finance tools directly
import { getFinancials, getCompanyInfo } from './financials.js';
import { getKeyRatios, getAnalysis } from './key-ratios.js';
import { getEarnings } from './earnings.js';

// All finance tools available for routing
const FINANCE_TOOLS: StructuredToolInterface[] = [
  getFinancials,
  getCompanyInfo,
  getKeyRatios,
  getAnalysis,
  getEarnings,
];

const FINANCE_TOOL_MAP = new Map(FINANCE_TOOLS.map(t => [t.name, t]));

type PacketDiagnostics = {
  packetType: 'company_snapshot';
  sourceTool: 'get_company_info';
  compacted: boolean;
  selectedFieldCount: number;
  fallbackReason?: 'compact_packet_unusable';
};

type CompanySnapshotRoute = {
  tool: 'get_company_info';
  args: { ticker: string };
};

type FinanceToolCall = {
  name: string;
  args: Record<string, unknown>;
};

type FinanceToolResult = {
  tool: string;
  args: Record<string, unknown>;
  data: unknown;
  sourceUrls: string[];
  error: string | null;
};

type KeyMetric = {
  label: string;
  value: unknown;
  unit: string | null;
  status: 'available' | 'unavailable';
  sourceField: string;
  note?: string;
};

const COMPANY_INFO_TOP_FIELDS = [
  'name',
  'name_ja',
  'name_en',
  'sec_code',
  'edinet_code',
  'industry',
  'business_summary',
  'business_items',
  'hq_address',
  'founding_date',
  'representative_name',
  'accounting_standard',
  'latest_fiscal_year',
  'credit_rating',
  'credit_score',
  'data_notes',
] as const;

const LATEST_EARNINGS_FIELDS = [
  'title',
  'disclosure_date',
  'disclosure_time',
  'fiscal_year_end',
  'quarter',
  'accounting_standard',
  'revenue',
  'revenue_change',
  'operating_income',
  'operating_income_change',
  'ordinary_income',
  'ordinary_income_change',
  'net_income',
  'net_income_change',
  'eps',
  'dividend_per_share',
  'forecast_revenue',
  'forecast_revenue_change',
  'forecast_operating_income',
  'forecast_operating_income_change',
  'forecast_net_income',
  'forecast_net_income_change',
  'forecast_eps',
  'forecast_dividend_per_share',
] as const;

const LATEST_FINANCIALS_FIELDS = [
  'fiscal_year',
  'submit_date',
  'accounting_standard',
  'revenue',
  'operating_income',
  'ordinary_income',
  'net_income',
  'total_assets',
  'total_liabilities',
  'net_assets',
  'shareholders_equity',
  'cash',
  'cf_operating',
  'cf_investing',
  'cf_financing',
  'equity_ratio_official',
  'roe_official',
  'eps',
  'diluted_eps',
  'bps',
  'per',
  'pbr',
  'dividend_per_share',
  'payout_ratio',
  'num_employees',
  'avg_annual_salary',
  'avg_age',
  'avg_tenure_years',
] as const;

function pickFields<T extends readonly string[]>(
  source: unknown,
  fields: T,
): Partial<Record<T[number], unknown>> | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in record) {
      picked[field] = record[field];
    }
  }
  return Object.keys(picked).length > 0
    ? (picked as Partial<Record<T[number], unknown>>)
    : undefined;
}

function getObjectKeyCount(value: unknown): number {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).length
    : 0;
}

function withPacketDiagnostics(data: unknown, diagnostics: PacketDiagnostics): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }
  return {
    ...(data as Record<string, unknown>),
    _packet: diagnostics,
  };
}

function isUsableCompanySnapshotPacket(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const record = data as Record<string, unknown>;
  const hasIdentity = COMPANY_INFO_TOP_FIELDS.some((field) => field in record);
  const hasFinancialData = 'latest_earnings' in record || 'latest_financials' in record;
  return hasIdentity && hasFinancialData;
}

function buildKeyMetric(
  source: Record<string, unknown>,
  field: string,
  label: string,
  unit: string | null,
): KeyMetric | undefined {
  if (!(field in source)) {
    return undefined;
  }
  return {
    label,
    value: source[field],
    unit,
    status: source[field] === null || source[field] === undefined ? 'unavailable' : 'available',
    sourceField: `latest_financials.${field}`,
  };
}

function buildCompanySnapshotKeyMetrics(latestFinancials: unknown): Record<string, KeyMetric> | undefined {
  if (!latestFinancials || typeof latestFinancials !== 'object' || Array.isArray(latestFinancials)) {
    return undefined;
  }

  const record = latestFinancials as Record<string, unknown>;
  const metrics: Record<string, KeyMetric> = {};

  for (const [key, metric] of [
    ['revenue', buildKeyMetric(record, 'revenue', 'Revenue / 売上高', 'JPY')],
    ['operating_income', buildKeyMetric(record, 'operating_income', 'Operating income / 営業利益', 'JPY')],
    ['net_income', buildKeyMetric(record, 'net_income', 'Net income / 純利益', 'JPY')],
    ['total_assets', buildKeyMetric(record, 'total_assets', 'Total assets / 総資産', 'JPY')],
    ['roe', buildKeyMetric(record, 'roe_official', 'ROE (Return on Equity) / 自己資本利益率', '%')],
    ['equity_ratio', buildKeyMetric(record, 'equity_ratio_official', 'Equity ratio / 自己資本比率', '%')],
    ['eps', buildKeyMetric(record, 'eps', 'EPS (Earnings per Share) / 1株当たり利益', 'JPY/share')],
    ['bps', buildKeyMetric(record, 'bps', 'BPS (Book-value per Share) / 1株当たり純資産', 'JPY/share')],
    ['per', buildKeyMetric(record, 'per', 'PER (Price-to-Earnings Ratio) / 株価収益率', 'x')],
  ] as const) {
    if (metric) {
      metrics[key] = metric;
    }
  }

  metrics.pbr = buildKeyMetric(record, 'pbr', 'PBR (Price-to-Book Ratio) / 株価純資産倍率', 'x') ?? {
    label: 'PBR (Price-to-Book Ratio) / 株価純資産倍率',
    value: null,
    unit: 'x',
    status: 'unavailable',
    sourceField: 'latest_financials.pbr',
    note: 'PBR is not available in this company snapshot source. Do not infer PBR from PER.',
  };

  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

/**
 * Keep meta-tool results compact enough for local models while preserving
 * the metrics users usually ask for in a first company snapshot.
 */
export function compactFinanceResult(toolName: string, data: unknown): unknown {
  if (toolName !== 'get_company_info' || !data || typeof data !== 'object') {
    return data;
  }

  const record = data as Record<string, unknown>;
  const compact: Record<string, unknown> = {
    ...pickFields(record, COMPANY_INFO_TOP_FIELDS),
  };

  const latestEarnings = pickFields(record.latest_earnings, LATEST_EARNINGS_FIELDS);
  if (latestEarnings) {
    compact.latest_earnings = latestEarnings;
  }

  const latestFinancials = pickFields(record.latest_financials, LATEST_FINANCIALS_FIELDS);
  if (latestFinancials) {
    compact.latest_financials = latestFinancials;
  }

  const keyMetrics = buildCompanySnapshotKeyMetrics(record.latest_financials);
  if (keyMetrics) {
    compact.key_metrics = keyMetrics;
  }

  const sources = pickFields(record.sources, [
    'business_items',
    'founding_date',
    'hq_address',
    'representative_name',
  ] as const);
  if (sources) {
    compact.sources = sources;
  }

  const compactFieldCount = getObjectKeyCount(compact);
  if (!isUsableCompanySnapshotPacket(compact)) {
    return withPacketDiagnostics(data, {
      packetType: 'company_snapshot',
      sourceTool: 'get_company_info',
      compacted: false,
      selectedFieldCount: compactFieldCount,
      fallbackReason: 'compact_packet_unusable',
    });
  }

  return withPacketDiagnostics(compact, {
    packetType: 'company_snapshot',
    sourceTool: 'get_company_info',
    compacted: true,
    selectedFieldCount: compactFieldCount,
  });
}

const SNAPSHOT_OVERVIEW_TERMS = [
  '会社概要',
  '企業概要',
  '会社情報',
  '企業情報',
  '基本情報',
] as const;

const SNAPSHOT_FINANCIAL_TERMS = [
  '直近',
  '最新',
  '主要財務',
  '主要指標',
  '財務指標',
  '財務',
  '業績',
  'key ratios',
  'financials',
] as const;

const NON_SNAPSHOT_INTENT_TERMS = [
  '比較',
  '比べ',
  '競合',
  'screening',
  'screener',
  'スクリーニング',
  '抽出',
  'ランキング',
  '一覧',
  '有価証券報告書',
  'filing',
  'filings',
  'read_filings',
  '決算短信',
  'earnings',
  'tdnet',
  '過去',
  '推移',
  'トレンド',
  '時系列',
  '履歴',
  'history',
  'historical',
  '財務健全性',
  '健全性',
  'スコア',
  'score',
  'health',
  '分析',
  '財務分析',
  'analysis',
  'analyze',
  'key ratio',
  'key ratios',
  'ratio',
  'ratios',
  'roic',
  'roe',
  '詳しく',
  '詳細',
  'detail',
  'details',
] as const;

const SNAPSHOT_COMPANY_ALIAS_TO_TICKER: Record<string, string> = {
  トヨタ: '7203',
};

function includesAny(query: string, terms: readonly string[]): boolean {
  const normalizedQuery = query.toLowerCase();
  return terms.some((term) => normalizedQuery.includes(term.toLowerCase()));
}

function normalizeSnapshotTicker(ticker: string): string {
  return SNAPSHOT_COMPANY_ALIAS_TO_TICKER[ticker] ?? '';
}

function stripSnapshotYears(text: string): string {
  return text.replace(/(?:の)?\d{4}\s*年(?:度)?(?:の)?/gu, '');
}

function getSnapshotSubject(query: string): string | null {
  const beforeOverview = query.match(/^(.{1,60}?)(?:の)?(?:会社概要|企業概要|会社情報|企業情報|基本情報)/u)?.[1];
  if (!beforeOverview) {
    return null;
  }

  return stripSnapshotYears(
    beforeOverview.replace(/^(?:まず|簡単に|ざっくり|短く|一言で)\s*/u, ''),
  ).trim();
}

function containsSubjectSeparator(subject: string): boolean {
  return /(?:と|、|,|＆|&|\bvs\b|及び|および)/iu.test(subject);
}

function hasOnlyIdentifierSubject(subject: string, identifier: string): boolean {
  const remaining = subject
    .replaceAll(identifier, '')
    .replace(/[()\[\]{}（）【】「」『』\s]/gu, '')
    .replace(/^の|の$/gu, '');
  return remaining.length === 0;
}

function extractSnapshotTicker(query: string): string | null {
  const subject = getSnapshotSubject(query);
  if (!subject || containsSubjectSeparator(subject)) {
    return null;
  }

  const edinetCodes = [...new Set(query.match(/\bE\d{5}\b/gi) ?? [])];
  const securitiesCodes = [...new Set(
    [...query.matchAll(/\b(\d{4})\b(?!\s*(?:年(?:度)?|億(?:円)?|万円|円))/g)]
      .map((match) => match[1])
      .filter((code): code is string => Boolean(code)),
  )];

  if (edinetCodes.length > 1) {
    return null;
  }
  if (securitiesCodes.length > 1) {
    return null;
  }
  if (edinetCodes.length > 0 && securitiesCodes.length > 0) {
    return null;
  }

  const edinetCode = edinetCodes[0];
  if (edinetCode) {
    return hasOnlyIdentifierSubject(subject, edinetCode) ? edinetCode : null;
  }

  const securitiesCode = securitiesCodes[0];
  if (securitiesCode) {
    return hasOnlyIdentifierSubject(subject, securitiesCode) ? securitiesCode : null;
  }

  const normalizedTicker = normalizeSnapshotTicker(subject);
  return normalizedTicker.length > 0 ? normalizedTicker : null;
}

export function getDeterministicCompanySnapshotRoute(query: string): CompanySnapshotRoute | null {
  if (
    !includesAny(query, SNAPSHOT_OVERVIEW_TERMS)
    || !includesAny(query, SNAPSHOT_FINANCIAL_TERMS)
    || includesAny(query, NON_SNAPSHOT_INTENT_TERMS)
  ) {
    return null;
  }

  const ticker = extractSnapshotTicker(query);
  return ticker ? { tool: 'get_company_info', args: { ticker } } : null;
}

async function executeFinanceToolCall(tc: FinanceToolCall): Promise<FinanceToolResult> {
  try {
    const tool = FINANCE_TOOL_MAP.get(tc.name);
    if (!tool) {
      throw new Error(`Tool '${tc.name}' not found`);
    }
    const rawResult = await withTimeout(tool.invoke(tc.args), SUB_TOOL_TIMEOUT_MS, tc.name);
    const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
    const parsed = JSON.parse(result) as { data?: unknown; sourceUrls?: unknown };
    const compactData = compactFinanceResult(tc.name, parsed.data);
    return {
      tool: tc.name,
      args: tc.args,
      data: compactData,
      sourceUrls: Array.isArray(parsed.sourceUrls) ? parsed.sourceUrls.filter((url): url is string => typeof url === 'string') : [],
      error: null,
    };
  } catch (error) {
    return {
      tool: tc.name,
      args: tc.args,
      data: null,
      sourceUrls: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatFinanceToolResults(results: FinanceToolResult[]): string {
  const successfulResults = results.filter((r) => r.error === null);
  const failedResults = results.filter((r) => r.error !== null);
  const allUrls = results.flatMap((r) => r.sourceUrls);

  const combinedData: Record<string, unknown> = {};
  for (const result of successfulResults) {
    const ticker = result.args.ticker as string | undefined;
    const key = ticker ? `${result.tool}_${ticker}` : result.tool;
    combinedData[key] = result.data;
  }

  if (failedResults.length > 0) {
    combinedData._errors = failedResults.map((r) => ({
      tool: r.tool,
      args: r.args,
      error: r.error,
    }));
  }

  return formatToolResult(combinedData, allUrls);
}

function buildRouterPrompt(): string {
  return `You are a Japanese financial data routing assistant.
Current date: ${getCurrentDate()}

Given a user's natural language query about financial data for Japanese listed companies, call the appropriate financial tool(s).

## Guidelines

1. **Ticker Resolution**: The tools handle ticker resolution automatically. Pass through whatever the user provides:
   - Securities codes: "7203", "6758", "7974"
   - Company names: "トヨタ", "Sony", "任天堂"
   - EDINET codes: "E02144"

2. **Tool Selection**:
   - For latest financial metrics snapshot (key ratios, ROE, margins, EPS) → get_key_ratios
   - For AI analysis, health score, industry benchmarks → get_analysis
   - For historical financial time series (revenue trends, multi-year data) → get_financial_statements
   - For company basic info (industry, accounting standard, latest financials) → get_company_info
   - For recent earnings disclosures (TDNet 決算短信) → get_earnings

3. **Efficiency**:
   - Prefer specific tools over general ones when possible
   - For point-in-time / latest data → get_key_ratios or get_company_info
   - For trend analysis → get_financial_statements with appropriate years
   - For comparisons between companies, call the same tool for each ticker
   - Always use the smallest data window that answers the question

Call the appropriate tool(s) now.`;
}

const GetFinancialsInputSchema = z.object({
  query: z.string().describe('Natural language query about financial data for Japanese companies'),
});

/**
 * Create a get_financials tool configured with the specified model.
 */
export function createGetFinancials(model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'get_financials',
    description: `Intelligent meta-tool for retrieving Japanese company financial data. Takes a natural language query and automatically routes to appropriate financial data tools. Use for:
- Company financials (revenue, operating income, net income, cash flows)
- Financial metrics and key ratios (ROE, ROIC, margins, EPS, PER, dividend yield)
- Historical trends and time series analysis
- AI analysis and financial health scoring
- Earnings disclosures (TDNet 決算短信)`,
    schema: GetFinancialsInputSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;

      onProgress?.('Fetching...');
      const deterministicRoute = getDeterministicCompanySnapshotRoute(input.query);
      if (deterministicRoute) {
        onProgress?.(`Fetching from ${formatSubToolName(deterministicRoute.tool)}...`);
        const result = await executeFinanceToolCall({
          name: deterministicRoute.tool,
          args: deterministicRoute.args,
        });
        return formatFinanceToolResults([result]);
      }

      const { response } = await callLlm(input.query, {
        model,
        systemPrompt: buildRouterPrompt(),
        tools: FINANCE_TOOLS,
      });
      const aiMessage = response as AIMessage;

      const toolCalls = aiMessage.tool_calls as ToolCall[];
      if (!toolCalls || toolCalls.length === 0) {
        return formatToolResult({ error: 'No tools selected for query' }, []);
      }

      const toolNames = [...new Set(toolCalls.map(tc => formatSubToolName(tc.name)))];
      onProgress?.(`Fetching from ${toolNames.join(', ')}...`);
      const results = await Promise.all(
        toolCalls.map((tc) => executeFinanceToolCall({
          name: tc.name,
          args: tc.args as Record<string, unknown>,
        }))
      );

      return formatFinanceToolResults(results);
    },
  });
}
