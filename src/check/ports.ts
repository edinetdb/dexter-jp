/**
 * `/check` の外に出る処理（EDINET DB と LLM）の実装。
 *
 * `runCheck` はこれらを**ポートとして受け取る**ので、テストと `bun run demo` は
 * 録画に差し替えて同じ経路を通れる。ここは本番用の中身だけを持つ。
 */
import { z } from 'zod';
import { api } from '../tools/finance/api.js';
import { resolveEdinetCode } from '../tools/finance/resolver.js';
import { callLlm } from '../model/llm.js';
import { segmentIntoParagraphs, type RawClaimFromModel } from './core/index.js';
import type { CheckPorts, DisclosureSource } from './index.js';
import type { CheckPanel } from './panel.js';

/** 証拠に使う節（design §4.2 = 有報の MD&A・リスク・方針。短信の本文は使わない）。 */
export const EVIDENCE_SECTIONS = ['mda', 'risks', 'policy'] as const;

/** EDINET DB の text-blocks の応答から、節ごとの本文を拾う。 */
function sectionTexts(payload: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const data = (payload as { data?: unknown })?.data ?? payload;
  if (!data || typeof data !== 'object') return out;
  const record = data as Record<string, unknown>;
  for (const section of EVIDENCE_SECTIONS) {
    const value = record[section];
    if (typeof value === 'string' && value.trim()) out[section] = value;
  }
  return out;
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * 有報の対象節を取って段落化する。
 * EDINET DB の呼び出しは 1 回（design §4.2「1 回の `/check` で 6 回以内」の内数）。
 */
export async function fetchDisclosure(ticker: string): Promise<DisclosureSource> {
  const edinetCode = await resolveEdinetCode(ticker);
  const { data } = await api.get(`/companies/${edinetCode}/text-blocks`, {}, { cacheable: true });
  const payload = (data.data ?? data) as Record<string, unknown>;

  const company = {
    name: pickString(payload, 'filerName', 'companyName', 'name') ?? ticker,
    edinetCode,
    ...(pickString(payload, 'secCode', 'securitiesCode')
      ? { secCode: pickString(payload, 'secCode', 'securitiesCode')! }
      : {}),
  };
  const fiscalYearRaw = payload.fiscalYear ?? payload.fiscal_year;
  const fiscalYear = typeof fiscalYearRaw === 'number' ? fiscalYearRaw : undefined;
  const docId = pickString(payload, 'docID', 'doc_id', 'docId') ?? '';

  const texts = sectionTexts(data);
  const paragraphs = Object.entries(texts).flatMap(([section, text]) =>
    segmentIntoParagraphs(text, {
      docId,
      company: company.name,
      ...(company.edinetCode ? { edinetCode: company.edinetCode } : {}),
      filer: company.name,
      docType: '有価証券報告書',
      section,
      ...(fiscalYear ? { fiscalYear } : {}),
    }),
  );

  return {
    company,
    ...(fiscalYear ? { fiscalYear } : {}),
    sections: Object.keys(texts),
    paragraphs,
  };
}

const ClaimsSchema = z.object({
  claims: z.array(
    z.object({
      quote: z.string().describe('利用者の仮説の、この主張のもとになった箇所（逐語。要約しない）'),
      text: z.string().describe('主張を肯定形の 1 文にしたもの。会社名と期間を明示する'),
      negated: z.boolean().optional().describe('もとの言い方が否定形なら true'),
      company: z.string().optional(),
      period: z.string().optional().describe('FY2025 の形'),
    }),
  ),
});

const DECOMPOSE_INSTRUCTIONS = `あなたは、利用者が持ち込んだ仮説を、有価証券報告書の段落に 1 本ずつ当てられる形に分ける係です。

守ること:
- **仮説を別の命題に変えない**。書かれていないことを足さない
- 否定は \`negated: true\` で持ち、\`text\` は**肯定形**にする（判定は肯定形で行い、結果はコードが反転する）
- 「A だけ」のような限定は**そのまま残す**（分けるのはコードの仕事）
- 「主因」「一過性」「大幅」などの**程度を含む語は落とさない**
- 会社名と期間を \`text\` に明示する。仮説に無ければ \`company\` / \`period\` を空のままにする
- \`quote\` は利用者の文からの**逐語**。要約や言い換えをしない
- 売買の推奨・目標株価・株価の水準についての主張は**作らない**（そういう仮説はここに来ない）`;

/** 仮説 → 主張（LLM）。 */
export async function decompose(hypothesis: string, company: string): Promise<RawClaimFromModel[]> {
  const { response } = await callLlm(
    `会社: ${company}\n仮説: ${hypothesis}`,
    { systemPrompt: DECOMPOSE_INSTRUCTIONS, outputSchema: ClaimsSchema },
  );
  const parsed = ClaimsSchema.safeParse(response);
  if (!parsed.success) return [];
  return parsed.data.claims.map(c => ({
    quote: c.quote,
    text: c.text,
    ...(c.negated === undefined ? {} : { negated: c.negated }),
    ...(c.company ? { company: c.company } : {}),
    ...(c.period ? { period: c.period } : {}),
  }));
}

const SUMMARY_INSTRUCTIONS = `確定した判定を 2 文以内でまとめます。

守ること:
- **段落に書かれていないことを足さない**
- 売買・株価の水準・割安割高・目標株価に触れない
- 「〜と会社は説明しています」の形で、会社が何と書いたかだけを言う
- 確定していない主張には触れない`;

/** パネルの要約（LLM）。linter に当たったら呼び出し側で捨てられる。 */
export async function summarize(panel: CheckPanel): Promise<string | null> {
  const confirmed = panel.claims.filter(c => c.status === 'supports' || c.status === 'contradicts');
  if (confirmed.length === 0) return null;
  const material = confirmed
    .map(c => {
      const evidence = [...c.supporting, ...c.contradicting].map(e => e.text.text).join('\n');
      return `主張: ${c.text}\n判定: ${c.status === 'supports' ? '裏付ける' : '食い違う'}\n段落:\n${evidence}`;
    })
    .join('\n\n');
  const { response } = await callLlm(material, { systemPrompt: SUMMARY_INSTRUCTIONS });
  const text = typeof response === 'string' ? response : String(response.content ?? '');
  return text.trim() || null;
}

/** 本番の `/check` が使うポート一式。 */
export function productionPorts(): CheckPorts {
  return { decompose, fetchDisclosure, summarize };
}
