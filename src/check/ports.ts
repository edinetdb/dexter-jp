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

/**
 * 証拠に使う節（design §4.2 = 有報の MD&A・リスク・方針。短信の本文は使わない）。
 *
 * **EDINET DB の `text-blocks` は節名を日本語で返す**（`mda` 等のキーではない。2026-09-23 実測）。
 * 内部の呼び名 → 応答の節名の対応をここに固定する。応答の実キーは 18 節ある。
 */
export const EVIDENCE_SECTIONS: ReadonlyArray<{ key: string; sectionName: string }> = [
  { key: 'mda', sectionName: '経営者による分析' },
  { key: 'risks', sectionName: '事業等のリスク' },
  { key: 'policy', sectionName: '事業方針・経営環境' },
];

/** `text-blocks` の 1 節。 */
interface TextBlockSection {
  section: string;
  text: string;
}

/**
 * 応答から対象節の**全文**を拾う。
 *
 * ★ `full=true` を付けないと、各節は **2,000 字の要約版**が返る
 * （`meta.truncated: true`、応答の note が明記。トヨタの「経営者による分析」は
 * 全文 24,544 字 / 要約 2,007 字、2026-09-23 実測）。
 * 要約を有報の逐語として引用すると、出典表記と中身が食い違う。必ず全文を取る。
 */
export function extractSections(payload: unknown): { key: string; sectionName: string; text: string }[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const bySection = new Map<string, string>();
  for (const item of data as TextBlockSection[]) {
    if (item && typeof item.section === 'string' && typeof item.text === 'string') {
      bySection.set(item.section, item.text);
    }
  }
  const out: { key: string; sectionName: string; text: string }[] = [];
  for (const { key, sectionName } of EVIDENCE_SECTIONS) {
    const text = bySection.get(sectionName);
    if (text && text.trim()) out.push({ key, sectionName, text });
  }
  return out;
}

/** 応答が要約版のまま（`full=true` を付け忘れた）かどうか。 */
export function isTruncated(payload: unknown): boolean {
  return (payload as { meta?: { truncated?: unknown } })?.meta?.truncated === true;
}

/** 有報（`event_type=yuhou`）の最新の書類 ID を取り出す。出所メタの `doc_id` に要る。 */
export function latestYuhouDocId(payload: unknown): string | null {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return null;
  const yuhou = (data as { event_type?: string; source_id?: string; event_date?: string }[])
    .filter(e => e.event_type === 'yuhou' && typeof e.source_id === 'string')
    .sort((a, b) => String(b.event_date ?? '').localeCompare(String(a.event_date ?? '')));
  return yuhou[0]?.source_id ?? null;
}

/** `/companies/{code}` から会社の見出しを取る。 */
export function companyHeader(payload: unknown): { name?: string; secCode?: string; fiscalYear?: number } {
  const d = ((payload as { data?: unknown })?.data ?? payload) as Record<string, unknown>;
  const name = typeof d.name_ja === 'string' ? d.name_ja : typeof d.name === 'string' ? d.name : undefined;
  const secCode = typeof d.sec_code === 'string' ? d.sec_code : undefined;
  const fiscalYear = typeof d.latest_fiscal_year === 'number' ? d.latest_fiscal_year : undefined;
  return {
    ...(name ? { name } : {}),
    ...(secCode ? { secCode } : {}),
    ...(fiscalYear ? { fiscalYear } : {}),
  };
}

/**
 * 有報の対象節を取って段落化する。
 *
 * EDINET DB の呼び出しは 3 回（会社の見出し / 対象節の全文 / 有報の書類 ID）。
 * design §4.2 の「1 回の `/check` で 6 回以内」の内数。
 */
export async function fetchDisclosure(ticker: string): Promise<DisclosureSource> {
  const edinetCode = await resolveEdinetCode(ticker);

  const [{ data: companyPayload }, { data: blocks }, { data: events }] = await Promise.all([
    api.get(`/companies/${edinetCode}`, {}, { cacheable: true }),
    api.get(`/companies/${edinetCode}/text-blocks`, { full: 'true' }, { cacheable: true }),
    api.get('/events', { edinet_code: edinetCode, event_type: 'yuhou', limit: 5 }, { cacheable: true }),
  ]);

  const header = companyHeader({ data: companyPayload });
  const company = {
    name: header.name ?? ticker,
    edinetCode,
    ...(header.secCode ? { secCode: header.secCode } : {}),
  };
  const fiscalYear = header.fiscalYear;
  const docId = latestYuhouDocId({ data: events }) ?? '';

  const sections = extractSections({ data: blocks, meta: (blocks as { meta?: unknown })?.meta });
  const paragraphs = sections.flatMap(({ key, sectionName, text }) =>
    segmentIntoParagraphs(text, {
      docId,
      company: company.name,
      ...(company.edinetCode ? { edinetCode: company.edinetCode } : {}),
      filer: company.name,
      docType: '有価証券報告書',
      section: key,
      ...(fiscalYear ? { fiscalYear } : {}),
    }).map(p => ({ ...p, id: `${key}-${p.id}`, sectionName })),
  );

  return {
    company,
    ...(fiscalYear ? { fiscalYear } : {}),
    sections: sections.map(s => s.key),
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
