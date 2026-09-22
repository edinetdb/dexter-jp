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
function buildJudgeRequests(paragraphs: readonly Paragraph[], claims: readonly Claim[]): JudgeRequest[] {
  const questions: Record<string, ChoiceQuestion> = {};
  for (const claim of claims) {
    questions[claim.id] = {
      type: 'choice',
      instructions: `次の主張に対して、証拠の文章はどの立場か。主張:「${claim.text}」`,
      criteria: STANCE_CRITERIA,
    };
  }
  return paragraphs.map(p => ({
    key: p.id,
    state: `証拠（${p.company} 有価証券報告書 ${p.section}）:\n${p.text}`,
    questions,
  }));
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
  for (const [i, r] of raw.entries()) {
    for (const c of extractClaims(r, `c${i + 1}`)) {
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
