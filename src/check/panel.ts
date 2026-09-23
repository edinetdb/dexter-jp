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
import { deepLinksFor, toTseFourDigit, type DeepLink } from '../links/deeplink.js';
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

/**
 * 主張の言い換えも利用者の原文も出力 linter に当たったときに出す固定文（review T9 H3）。
 * 利用者が「注目」「重要度」のような出力側の禁止語を書くと、原文への退避も同じ語で当たる。
 * そのまま記録を書くと例外で落ちる（判定層の課金を払い切ったあと）ので、当社生成の固定文に落とす。
 * 原文は `quote`（逐語 = 走査対象外）に残っているので、利用者の言葉は画面から消えない。
 */
export const CLAIM_TEXT_WITHHELD = 'この主張は言い換えた形では表示できませんでした（もとの言葉をご覧ください）';

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
  /**
   * 言い換えを出せなかったときの退避先（review T9 M7 = 差し替えを画面に出す）。
   * `user_quote` = 利用者の原文に落とした / `withheld` = 原文にも禁止語があり固定文に落とした
   */
  textReplaced?: 'user_quote' | 'withheld';
  /** 仮説に無かった範囲を開示から補ったとき（review T9 H2）。当社生成の固定語彙 */
  scopeNote?: string;
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
export function safeClaimText(
  generated: string,
  userQuote: string,
): { text: string; replaced?: 'user_quote' | 'withheld' } {
  if (lintOutput(generated, '$.claim.text').clean) return { text: generated };
  // 原文も同じ語を含みうる（利用者がその語を書いたから主張に載っている）。原文も汚れていれば固定文へ
  if (lintOutput(userQuote, '$.claim.text').clean) return { text: userQuote, replaced: 'user_quote' };
  return { text: CLAIM_TEXT_WITHHELD, replaced: 'withheld' };
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
  /** claimId → 仮説に無かった範囲を補った旨（当社生成の固定語彙） */
  scopeNotes?: ReadonlyMap<string, string>;
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
    const { text, replaced } = safeClaimText(claim.text, claim.quote);
    const scopeNote = input.scopeNotes?.get(claim.id);

    claims.push({
      id: claim.id,
      quote: quote(claim.quote, { source: 'user' }),
      text,
      ...(replaced ? { textReplaced: replaced } : {}),
      ...(scopeNote ? { scopeNote } : {}),
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

/** パネルを端末に出す行に落とす。**当社生成の行だけ**を組み立て、逐語はそのまま並べる。 */
export function renderCheckPanel(panel: CheckPanel): string[] {
  const lines: string[] = [];
  lines.push(`仮説: ${panel.hypothesis.text}`);
  // EDINET DB の sec_code は 5 桁（トヨタ = 72030）。利用者が打った 4 桁の形で出す（英字付き等はそのまま）
  const code = panel.company.secCode ? (toTseFourDigit(panel.company.secCode) ?? panel.company.secCode) : '';
  lines.push(`会社: ${panel.company.name}${code ? `（${code}）` : ''}`);
  lines.push('');

  if (panel.undetermined) {
    lines.push(panel.undeterminedText ?? UNDETERMINED_TEXT);
    lines.push('');
  }

  for (const claim of panel.claims) {
    lines.push(`主張: ${claim.text}`);
    lines.push(`  もとの言葉: ${claim.quote.text}`);
    if (claim.textReplaced === 'user_quote') lines.push('  （言い換えは出せる形にならなかったため、もとの言葉で判定結果を示しています）');
    if (claim.scopeNote) lines.push(`  ${claim.scopeNote}`);
    switch (claim.status) {
      case 'supports': lines.push('  → 裏付ける'); break;
      case 'contradicts': lines.push('  → 食い違う'); break;
      case 'split': lines.push('  → 判定が割れている（裏付けと食い違いの両方が確定）'); break;
      case 'unresolved': lines.push('  → 確かめられなかった'); break;
      case 'not_judged': lines.push(`  → ${claim.notJudgedReason ?? '未判定'}`); break;
    }
    if (claim.numeric) {
      const label = { match: '一致', mismatch: '不一致', unverifiable: '検算不能' }[claim.numeric.result];
      lines.push(`  数値の検算: ${label}${claim.numeric.reason ? `（${claim.numeric.reason}）` : ''}`);
    }
    for (const [heading, entries] of [['裏付け', claim.supporting], ['食い違い', claim.contradicting]] as const) {
      for (const e of entries) {
        const estimate = e.estimate === undefined ? '' : `（推定 ${e.estimate.toFixed(2)}）`;
        lines.push(`  [${heading}]${estimate} ${e.docType ?? ''} ${e.section} ${e.docId}`);
        lines.push(`    ${e.text.text}`);
      }
    }
    lines.push('');
  }

  lines.push(renderScopeLine(panel.scope));
  lines.push(`バーの数字は「${panel.estimateCaption}」です。`);
  if (panel.summary) lines.push('', panel.summary);
  if (panel.summaryDropped) lines.push('', '（要約は出せる形になりませんでした。上の段落をそのままご覧ください）');
  if (panel.footer) {
    lines.push('', `判定リクエスト ${panel.footer.requests} 回 / ${(panel.footer.elapsedMs / 1000).toFixed(1)} 秒`);
  }
  if (panel.links.length > 0) {
    lines.push('');
    for (const link of panel.links) lines.push(`  ${link.label}: ${link.url}`);
  }
  return lines;
}
