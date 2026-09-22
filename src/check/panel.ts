/**
 * `/check` のパネル組み立て（design §4.2・§6、go-decision G-A2 / G-A3 / G-A5 / G-A6）。
 *
 * 出す順に: 仮説の原文 → 分けた主張 → 主張ごとの証拠（有報の逐語 + 出所）→ 数値の検算 →
 * 検査した範囲と未検査数 → 推定値の説明 → deep link。
 *
 * ## 逐語と当社生成を型で分ける
 * 有報の段落と利用者の仮説は `{kind:'quote'}` で持ち、出力 linter は走査しない。
 * 走査するのは当社が作った文字列（見出し・ラベル・件数文・LLM の要約・主張の言い換え）だけ。
 * 有報の「事業等のリスク」には「割高」「下値」「配分」が普通に出るので、パネル全体を
 * 走査すると芯の証拠段落が捨てられる（review r2 H3）。
 *
 * ## 判定不能（G-A3）
 * 対象節が取れない / 裏付け・食い違いと確定した段落が 0 / 全部が閾値未満、のどれかなら
 * 「判定不能」で止め、**モデルに埋めさせない**。
 */
import { quote, lintOutput, acceptSummary, type QuotedText } from '../guard/output-linter.js';
import { deepLinksFor, type DeepLink } from '../links/deeplink.js';
import {
  resolveClaim,
  type Claim,
  type ClaimResolution,
  type NumericVerification,
  type Paragraph,
  type ParagraphJudgment,
} from './core/index.js';

/** 推定値の説明（G-A6 の逐語。「正しい確率」「支持率」「的中」は使わない）。 */
export const ESTIMATE_CAPTION = 'この段落と主張の関係についてのモデルの推定';

/** 判定不能のときに出す文（モデルに埋めさせないための固定文）。 */
export const UNDETERMINED_TEXT = '判定不能（有価証券報告書の対象節からは確かめられませんでした）';

export interface EvidenceEntry {
  paragraphId: string;
  /** 有報の逐語。linter は走査しない */
  text: QuotedText;
  docId: string;
  filer?: string;
  docType?: string;
  section: string;
  fiscalYear?: number;
  /** モデルの推定（0..1）。LLM 代行では確率が無いので undefined */
  estimate?: number;
}

export type ClaimStatus =
  | 'supports'
  | 'contradicts'
  | 'split' // 裏付けと食い違いの両方が確定した = 割れている
  | 'unresolved' // 確定した段落が 0
  | 'not_judged'; // 分解の時点で未判定（会社・期間が無い、「だけ」の後半が確かめられない 等

export interface PanelClaim {
  id: string;
  /** 仮説の原文の該当箇所（逐語） */
  quote: QuotedText;
  /** 当社生成（LLM が言い換えた主張）。linter の対象 */
  text: string;
  negated: boolean;
  status: ClaimStatus;
  /** `not_judged` のときの理由（当社生成の固定語彙） */
  notJudgedReason?: string;
  supporting: EvidenceEntry[];
  contradicting: EvidenceEntry[];
  numeric?: NumericVerification;
}

export interface CheckPanel {
  /** 利用者の仮説の原文（逐語。書き換えない） */
  hypothesis: QuotedText;
  company: { name: string; edinetCode?: string; secCode?: string };
  claims: PanelClaim[];
  /** 検査した範囲。「有報 FY2026 MD&A・リスク・方針、132 段落中 132」の形で出す */
  scope: {
    fiscalYear?: number;
    sections: string[];
    examined: number;
    total: number;
    /** 予算切れ・失敗で見られなかった段落数（0 を返さない） */
    unchecked: number;
  };
  /** 全主張が確定しなかったら判定不能で止める */
  undetermined: boolean;
  undeterminedText?: string;
  estimateCaption: string;
  /** LLM の要約。linter に当たったら null（パネルだけ出す） */
  summary: string | null;
  summaryDropped: boolean;
  links: DeepLink[];
  footer?: { requests: number; elapsedMs: number; jpy?: number };
}

const NOT_JUDGED_REASONS: Record<string, string> = {
  missing_company: '会社が主張に明示されていないため未判定',
  missing_period: '期間が主張に明示されていないため未判定',
  exclusivity_unconfirmed: '「それ以外は寄与していない」を段落から確かめられないため未判定',
  meaning_not_preserved: '仮説の意味を保ったまま主張に分けられないため未判定',
};

function evidenceFor(
  ids: readonly string[],
  paragraphs: ReadonlyMap<string, Paragraph>,
  estimates: ReadonlyMap<string, number>,
): EvidenceEntry[] {
  const out: EvidenceEntry[] = [];
  for (const id of ids) {
    const p = paragraphs.get(id);
    if (!p) continue;
    const estimate = estimates.get(`${id}`);
    out.push({
      paragraphId: p.id,
      text: quote(p.text, { doc_id: p.docId, source: 'edinet' }),
      docId: p.docId,
      ...(p.filer ? { filer: p.filer } : {}),
      ...(p.docType ? { docType: p.docType } : {}),
      section: p.section,
      ...(p.fiscalYear ? { fiscalYear: p.fiscalYear } : {}),
      ...(estimate === undefined ? {} : { estimate }),
    });
  }
  return out;
}

function statusOf(claim: Claim, resolution: ClaimResolution): ClaimStatus {
  if (claim.unresolvable) return 'not_judged';
  if (resolution.status === 'unresolved') return 'unresolved';
  if (resolution.verdict === 'supports') return 'supports';
  if (resolution.verdict === 'contradicts') return 'contradicts';
  return 'split';
}

/**
 * 主張の言い換えが linter に当たったら、**捨てずに利用者の原文へ落とす**。
 *
 * 主張ごと落とすと証拠の並びが消えて機能の芯が壊れる。原文はそのまま出してよい
 * （逐語 = 走査対象外）ので、当社生成の言い換えだけを引っ込める。
 */
function safeClaimText(generated: string, userQuote: string): { text: string; replaced: boolean } {
  if (lintOutput(generated, '$.claim.text').clean) return { text: generated, replaced: false };
  return { text: userQuote, replaced: true };
}

export interface BuildPanelInput {
  hypothesis: string;
  company: { name: string; edinetCode?: string; secCode?: string };
  claims: readonly Claim[];
  paragraphs: readonly Paragraph[];
  /** claimId → その主張に対する段落ごとの判定 */
  judgments: ReadonlyMap<string, readonly ParagraphJudgment[]>;
  /** claimId → 数値検算の結果 */
  numeric?: ReadonlyMap<string, NumericVerification>;
  scope: { fiscalYear?: number; sections: string[]; total: number; unchecked: number };
  summary?: string | null;
  threshold?: number;
  footer?: CheckPanel['footer'];
}

export function buildCheckPanel(input: BuildPanelInput): CheckPanel {
  const byId = new Map(input.paragraphs.map(p => [p.id, p]));
  const claims: PanelClaim[] = [];

  for (const claim of input.claims) {
    const judgments = input.judgments.get(claim.id) ?? [];
    const estimates = new Map(judgments.map(j => [j.paragraphId, j.confidence]));
    const resolution = resolveClaim(claim, judgments, input.threshold);
    const status = statusOf(claim, resolution);
    const { text } = safeClaimText(claim.text, claim.quote);

    claims.push({
      id: claim.id,
      quote: quote(claim.quote, { source: 'user' }),
      text,
      negated: claim.negated,
      status,
      ...(claim.unresolvable
        ? { notJudgedReason: NOT_JUDGED_REASONS[claim.unresolvable.reason] ?? '未判定' }
        : {}),
      supporting: evidenceFor(resolution.supportingParagraphIds, byId, estimates),
      contradicting: evidenceFor(resolution.contradictingParagraphIds, byId, estimates),
      ...(input.numeric?.get(claim.id) ? { numeric: input.numeric.get(claim.id)! } : {}),
    });
  }

  // 判定不能（G-A3）: 対象節が 0 / どの主張も確定しなかった
  const anyConfirmed = claims.some(c => c.status === 'supports' || c.status === 'contradicts' || c.status === 'split');
  const anyNumericResolved = claims.some(c => c.numeric && c.numeric.result !== 'unverifiable');
  const undetermined = input.scope.total === 0 || (!anyConfirmed && !anyNumericResolved);

  const summaryDecision = acceptSummary(undetermined ? null : input.summary);

  return {
    hypothesis: quote(input.hypothesis, { source: 'user' }),
    company: input.company,
    claims,
    scope: {
      ...(input.scope.fiscalYear ? { fiscalYear: input.scope.fiscalYear } : {}),
      sections: input.scope.sections,
      examined: input.scope.total - input.scope.unchecked,
      total: input.scope.total,
      unchecked: input.scope.unchecked,
    },
    undetermined,
    ...(undetermined ? { undeterminedText: UNDETERMINED_TEXT } : {}),
    estimateCaption: ESTIMATE_CAPTION,
    summary: summaryDecision.accepted,
    summaryDropped: summaryDecision.accepted === null && Boolean(input.summary) && !undetermined,
    links: deepLinksFor({ secCode: input.company.secCode, edinetCode: input.company.edinetCode }),
    ...(input.footer ? { footer: input.footer } : {}),
  };
}

const SECTION_LABELS: Record<string, string> = {
  mda: 'MD&A',
  risks: 'リスク',
  policy: '方針',
};

/** 「検査した範囲: 有報 FY2026 MD&A・リスク・方針、132 段落中 132」の 1 行。 */
export function renderScopeLine(scope: CheckPanel['scope']): string {
  const year = scope.fiscalYear ? `FY${scope.fiscalYear} ` : '';
  const sections = scope.sections.map(s => SECTION_LABELS[s] ?? s).join('・');
  const tail = scope.unchecked > 0 ? `（未検査 ${scope.unchecked}）` : '';
  return `検査した範囲: 有価証券報告書 ${year}${sections}、${scope.total} 段落中 ${scope.examined}${tail}`;
}
