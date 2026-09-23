/**
 * `/check <銘柄> <仮説>` の組み立て（design §4.2）。
 *
 * 順番:
 *   1. 判定層が使えるか（`preflightCheck`。LLM 代行では走らせない = 小池裁定 B）
 *   2. 入口ガード（決定論の語彙・構造 OR 判定層の票）。助言の求めなら言い換えを提案して終わり
 *   3. LLM: 仮説 → 主張（原文と対応づけ、否定・限定・因果・期間を落とさない）
 *   4. コード: 有報の対象節を取得 → 段落化 → 重複除去
 *   5. 判定層: 段落 1 本 = 1 リクエスト、主張を並列の Choice で
 *   6. コード: 数値の主張を財務データで検算
 *   7. コード: 閾値で仕分け。証拠が無ければ判定不能
 *   8. ガード（出力）→ 記録
 *
 * 外に出る処理は全部**ポート**で受け取る。こうすると端から端までを録画の再生で回せる
 * （テストと `bun run demo` が同じ経路を通る = 表示の回帰も録画で見られる）。
 */
import {
  runJudgeBatch,
  isAnswerError,
  type JudgeBackend,
  type JudgeRequest,
  type ChoiceQuestion,
} from '../judge/index.js';
import { voteAdvice } from '../judge/vote.js';
import { guardInput, type GuardVerdict } from '../guard/input-guard.js';
import {
  extractClaims,
  mergeNearDuplicateParagraphs,
  verifyNumericClaim,
  type Claim,
  type FinancialSeries,
  type NumericClaim,
  type NumericVerification,
  type Paragraph,
  type ParagraphJudgment,
  type RawClaimFromModel,
  type Verdict,
} from './core/index.js';
import { buildCheckPanel, type CheckPanel } from './panel.js';
import { preflightCheck } from './preflight.js';
import { writeCheckRecord } from './record.js';

/** 段落 × 主張の問い（PoC A 電池で確認した形）。 */
export const STANCE_CRITERIA: Record<string, string> = {
  supports: '証拠の文章は、その主張を裏付けている',
  contradicts: '証拠の文章は、その主張と食い違っている',
  unrelated: '証拠の文章は、その主張とは別の話題である（別会社の話を含む）',
};

/** 取得した有報の対象節。 */
export interface DisclosureSource {
  company: { name: string; edinetCode?: string; secCode?: string };
  fiscalYear?: number;
  sections: string[];
  paragraphs: Paragraph[];
}

export interface CheckPorts {
  /** 判定層。省略時は env から選ぶ */
  judge?: JudgeBackend;
  /** 仮説 → 主張（LLM）。数値の主張は `numeric` を付けて返す */
  decompose: (hypothesis: string, company: string) => Promise<readonly RawClaimFromModel[]>;
  /** 有報の対象節を取る（EDINET DB） */
  fetchDisclosure: (ticker: string) => Promise<DisclosureSource>;
  /** 数値の検算に使う財務データ。数値の主張が無ければ呼ばれない */
  fetchFinancials?: (edinetCode: string) => Promise<FinancialSeries>;
  /** パネルの要約（LLM）。linter に当たったら捨てられる */
  summarize?: (panel: CheckPanel) => Promise<string | null>;
  now?: () => Date;
  /** 記録の書き出し先（テスト用） */
  recordDir?: string;
  /** 判定の上限段落数（design §4.2 = 200） */
  maxParagraphs?: number;
}

export type CheckOutcome =
  | { kind: 'panel'; panel: CheckPanel; recordPath: string }
  | { kind: 'refused'; verdict: Extract<GuardVerdict, { decision: 'refuse' }> }
  | { kind: 'judge_unavailable'; message: string; backendName: string }
  | { kind: 'usage'; message: string };

const USAGE = '使い方: /check <銘柄> <仮説>\n  例: /check 7203 為替の影響が減益の主因だと会社は説明している';

const MAX_PARAGRAPHS = 200;

function isNumericClaim(c: Claim | NumericClaim): c is NumericClaim {
  return (c as NumericClaim).kind === 'numeric' && 'operator' in c;
}

/**
 * 段落ごとに 1 リクエスト、主張を並列の質問にする（PoC で確認した形。
 * 証拠を束ねて 1 つの state にしない = 公式 jaggedness「無関係な state が増えると精度が落ちる」）。
 */
export function buildJudgeRequests(paragraphs: readonly Paragraph[], claims: readonly Claim[]): JudgeRequest[] {
  const questions: Record<string, ChoiceQuestion> = {};
  for (const claim of claims) {
    // 対象会社・対象期間を問いに入れる（Codex T9 r2 H2）。画面で補った範囲を判定層にも渡す。
    // この形は T6 と同じ 180 組・同じ正解で測り直してある（2026-09-23、supports 37/37・contradicts 39/39・割れ 5.0%）。
    // 文面を変えたら測り直す（~/Desktop/tmp/dexter-kotae/t6/run_jev_scoped.py と同じ形）
    questions[claim.id] = {
      type: 'choice',
      instructions: `${scopeHeader(claim)}次の主張に対して、証拠の文章はどの立場か。主張:「${claim.text}」`,
      criteria: STANCE_CRITERIA,
    };
  }
  return paragraphs.map(p => ({
    key: p.id,
    state: `証拠（${p.company} 有価証券報告書 ${p.fiscalYear ? `FY${p.fiscalYear} ` : ''}${p.section}）:\n${p.text}`,
    questions,
  }));
}

function scopeHeader(claim: Claim): string {
  const lines: string[] = [];
  if (claim.company) lines.push(`対象会社: ${claim.company}`);
  if (claim.period) lines.push(`対象期間: ${claim.period}`);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export async function runCheck(
  ticker: string,
  hypothesis: string,
  ports: CheckPorts,
  options: { interactive: boolean } = { interactive: true },
): Promise<CheckOutcome> {
  if (!ticker || !hypothesis) {
    return { kind: 'usage', message: USAGE };
  }

  // 1. 判定層が使えるか（LLM 代行では走らせない）
  const preflight = preflightCheck(ports.judge);
  if (!preflight.ok) {
    return { kind: 'judge_unavailable', message: preflight.message, backendName: preflight.backendName };
  }
  const backend = preflight.backend;

  // 2. 入口ガード。票が取れなければ例外が上がる（呼び出し側が止める）
  const verdict = await guardInput(hypothesis, {
    interactive: options.interactive,
    vote: (input) => voteAdvice(input, { backend }),
  });
  if (verdict.decision === 'refuse') {
    return { kind: 'refused', verdict };
  }

  // 3-4. 分解と、有報の対象節の取得・段落化
  const disclosure = await ports.fetchDisclosure(ticker);
  const raw = await ports.decompose(hypothesis, disclosure.company.name);

  const claims: Claim[] = [];
  const numericClaims: NumericClaim[] = [];
  const scopeNotes = new Map<string, string>();
  for (const [i, r0] of raw.entries()) {
    const r = requireVerbatimQuote(r0, hypothesis);
    const { claim: scoped, note } = fillScopeFromDisclosure(r, disclosure);
    for (const c0 of extractClaims(scoped, `c${i + 1}`)) {
      const c = r.quoteNotVerbatim && !c0.unresolvable
        ? { ...c0, unresolvable: { reason: 'meaning_not_preserved' as const } }
        : c0;
      if (note) scopeNotes.set(c.id, note);
      if (isNumericClaim(c)) numericClaims.push(c);
      else claims.push(c);
    }
  }

  const deduped = mergeNearDuplicateParagraphs(disclosure.paragraphs);
  const limit = ports.maxParagraphs ?? MAX_PARAGRAPHS;
  const examined = deduped.slice(0, limit);
  const overLimit = Math.max(0, deduped.length - examined.length);

  // 5. 判定（分解で未判定になった主張は投げない）
  const judgeable = claims.filter(c => !c.unresolvable);
  const judgments = new Map<string, ParagraphJudgment[]>();
  for (const c of claims) judgments.set(c.id, []);

  let uncheckedParagraphs = overLimit;
  let footer: CheckPanel['footer'];

  if (judgeable.length > 0 && examined.length > 0) {
    const result = await runJudgeBatch(buildJudgeRequests(examined, judgeable), { backend });
    for (const [paragraphId, answers] of Object.entries(result.answers)) {
      for (const [claimId, answer] of Object.entries(answers)) {
        if (isAnswerError(answer) || answer.type !== 'choice') continue;
        const confidence = answer.backend === 'jev' ? answer.confidence : 1;
        const choice = answer.backend === 'jev' ? answer.choice : answer.label;
        judgments.get(claimId)?.push({ paragraphId, verdict: choice as Verdict, confidence });
      }
    }
    uncheckedParagraphs += result.uncheckedCount;
    footer = { requests: result.usage.requestCount, elapsedMs: result.usage.elapsedMs };
  }

  // 6. 数値の検算
  const numeric = new Map<string, NumericVerification>();
  if (numericClaims.length > 0 && ports.fetchFinancials && disclosure.company.edinetCode) {
    const series = await ports.fetchFinancials(disclosure.company.edinetCode);
    for (const n of numericClaims) numeric.set(n.id, verifyNumericClaim(n, series));
  }

  // 7. パネル（要約は判定不能のときは呼ばない = モデルに埋めさせない）
  const base = buildCheckPanel({
    hypothesis,
    company: disclosure.company,
    claims: [...claims, ...numericClaims.map(n => numericClaimAsClaim(n))],
    paragraphs: examined,
    judgments,
    numeric,
    scopeNotes,
    scope: {
      ...(disclosure.fiscalYear ? { fiscalYear: disclosure.fiscalYear } : {}),
      sections: disclosure.sections,
      total: deduped.length,
      unchecked: uncheckedParagraphs,
    },
    ...(footer ? { footer } : {}),
  });

  const summary = base.undetermined || !ports.summarize ? null : await ports.summarize(base);
  const panel = summary === null ? base : buildCheckPanel({
    hypothesis,
    company: disclosure.company,
    claims: [...claims, ...numericClaims.map(n => numericClaimAsClaim(n))],
    paragraphs: examined,
    judgments,
    numeric,
    scopeNotes,
    scope: base.scope,
    summary,
    ...(footer ? { footer } : {}),
  });

  // 8. 記録
  const recordPath = writeCheckRecord(panel, backend.name, {
    ...(ports.recordDir ? { dir: ports.recordDir } : {}),
    ...(ports.now ? { at: ports.now() } : {}),
  });

  return { kind: 'panel', panel, recordPath };
}

/** 比較用: 空白を落とし、全角・半角を NFKC で揃える。 */
function looseForm(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, '');
}

/**
 * `quote` が利用者の仮説に実在するかを確かめる（Codex T9 M2）。
 *
 * `quote` は `{kind:'quote', source:'user'}` として出力 linter の走査を免れる。LLM が原文に無い文
 * （たとえば「目標株価は一万円」）を quote に入れると、当社生成の文が逐語の顔をして linter を素通りする。
 * 原文に無い quote は**仮説の全文に差し替え**、主張は「意味を保って分けられない」として判定に回さない。
 */
export function requireVerbatimQuote(raw: RawClaimFromModel, hypothesis: string): RawClaimFromModel {
  const q = raw.quote ?? '';
  if (q.trim() && looseForm(hypothesis).includes(looseForm(q))) return raw;
  return { ...raw, quote: hypothesis, quoteNotVerbatim: true };
}

/**
 * 仮説に会社・期間が無い主張の範囲を、**実際に検査する開示**から補う（review T9 H2）。
 *
 * 分解プロンプトは「仮説に無ければ `company` / `period` を空のままにする」と指示している
 * （= モデルに推測させない）。一方 `requireExplicitScope` は空なら未判定にする。この 2 つを
 * そのまま繋ぐと、期間を書かない普通の仮説（README の例もそう）が**常に判定不能**になる。
 *
 * 会社は `/check <銘柄>` で利用者が指定している。期間は検査するのが取得した有報 1 期分だけ
 * なので、その期として読むのが実態どおり。読み替えたことは主張ごとに画面へ出す（黙って補わない）。
 * 開示から期が取れないときは補わない = 従来どおり未判定。
 */
export function fillScopeFromDisclosure(
  raw: RawClaimFromModel,
  disclosure: Pick<DisclosureSource, 'company' | 'fiscalYear'>,
): { claim: RawClaimFromModel; note?: string } {
  const filled: string[] = [];
  let claim = raw;
  if (!raw.company?.trim() && disclosure.company.name) {
    claim = { ...claim, company: disclosure.company.name };
    filled.push(`会社は指定された銘柄（${disclosure.company.name}）`);
  }
  if (!raw.period?.trim() && disclosure.fiscalYear) {
    claim = { ...claim, period: `FY${disclosure.fiscalYear}` };
    filled.push(`期間は検査した有価証券報告書の期（FY${disclosure.fiscalYear}）`);
  }
  if (filled.length === 0) return { claim };
  return { claim, note: `範囲: 仮説に書かれていないため、${filled.join('、')}として読みました` };
}

/** 数値の主張もパネルの行として並べる（検算の結果を見せるため）。 */
function numericClaimAsClaim(n: NumericClaim): Claim {
  return {
    id: n.id,
    quote: n.source ?? `${n.company} ${n.period} ${n.metric}`,
    text: `${n.company} の ${n.period}（${n.basis === 'consolidated' ? '連結' : '単体'}）の ${n.metric} は ${n.value}${n.unit}`,
    negated: false,
    kind: 'numeric',
    degreeWords: [],
    company: n.company,
    period: n.period,
  };
}

export { preflightCheck } from './preflight.js';
export * from './panel.js';
export * from './record.js';
