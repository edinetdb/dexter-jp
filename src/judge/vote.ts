/**
 * 入力ガードの追加票（Noul）。`src/guard/input-guard.ts` の `AdviceVote` 型
 *   `(input: string) => Promise<{ isAdvice: boolean; probability: number } | null>`
 * に合う 1 関数を提供する（guard 側の型はここでは import しない = judge/ は guard/ に依存しない）。
 *
 * design §5: state = 「利用者の入力: <text>」、criteria は売買・目標株価・割安割高・配分を尋ねる型。
 *
 * jev バックエンド（確率つき）でも llm バックエンド（確率なし = LabelOnlyAnswer）でも同じ判定ができる:
 *   - jev: noul(0..1) をそのまま probability に、isAdvice はそれを閾値で仕分ける
 *   - llm: label "true"/"false" を isAdvice ? 1 : 0 の 2 値として probability に返す
 *          （確率を持たない型の性質を壊さないため、勾配のある確率を捏造しない）
 *
 * 判定層（jev/llm どちらも）が使えない・応答が得られない場合は「票なし(null)」ではなく
 * 例外を投げて明示的に失敗する。呼び出し側（/check）はこれを捕まえて「判定層が無い状態では
 * 走らせない」（go-decision G-A1 改定）を実装できる。
 */
import { JudgeUnavailableError, RetryableJudgeError } from './errors.js';
import { resolveJudgeBackend } from './backends/select.js';
import { isAnswerError } from './types.js';
import type { JudgeBackend, NoulQuestion } from './types.js';

export const ADVICE_GUARD_QUESTION_KEY = 'advice';

/** design §5 の GUARD_Q（割安・割高・妥当な株価の水準を追加した版）。 */
export const ADVICE_GUARD_QUESTION: NoulQuestion = {
  type: 'noul',
  instructions:
    'この入力は、特定の銘柄を買うべきか売るべきか・買い時や売り時・目標株価・割安か割高か・' +
    '妥当な株価の水準・保有する数量や金額の配分について、助言を求めているか。',
  criteria: {
    true:
      '売買の推奨、買い時・売り時・利確や損切りの判断、目標株価、割安か割高か・妥当な株価の水準、' +
      '何株・いくら買うかの配分を尋ねている',
    false:
      '会社の開示内容・業績の理由・リスク記述・事実関係を確かめたい、または自分の仮説を開示と' +
      '照らしたいという依頼である',
  },
};

export interface AdviceVoteResult {
  isAdvice: boolean;
  probability: number;
}

export interface VoteAdviceOptions {
  backend?: JudgeBackend;
  /** noul をどこから isAdvice=true とみなすか。既定 0.5（guard 側の既定閾値と揃える）。 */
  threshold?: number;
  /** RetryableJudgeError の再試行回数。既定 2。 */
  maxRetries?: number;
  /** テスト注入用。実時間を待たない。 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

/**
 * `AdviceVote` と同じシグネチャの実装。
 * 戻り値の型は `Promise<AdviceVoteResult>`（`null` を返す分岐を持たない）。
 * `AdviceVote = (input: string) => Promise<AdviceVoteResult | null>` に対して
 * 戻り値型は共変なので、この関数はそのまま `vote` として渡せる。
 */
export async function voteAdvice(input: string, opts: VoteAdviceOptions = {}): Promise<AdviceVoteResult> {
  const backend = opts.backend ?? resolveJudgeBackend();
  const threshold = opts.threshold ?? 0.5;
  const maxRetries = opts.maxRetries ?? 2;
  const sleep = opts.sleep ?? defaultSleep;

  const request = {
    key: 'guard',
    state: `利用者の入力: ${input}`,
    questions: { [ADVICE_GUARD_QUESTION_KEY]: ADVICE_GUARD_QUESTION },
  };

  let attempt = 0;
  for (;;) {
    try {
      const result = await backend.call(request);
      const answer = result.answers[ADVICE_GUARD_QUESTION_KEY];
      if (!answer) {
        throw new JudgeUnavailableError(`advice guard: no answer returned by "${backend.name}" backend`);
      }
      if (isAnswerError(answer)) {
        throw new JudgeUnavailableError(`advice guard: "${backend.name}" backend failed: ${answer.error}`);
      }

      if (answer.backend === 'jev') {
        if (answer.type !== 'noul') {
          throw new JudgeUnavailableError(`advice guard: unexpected answer type "${answer.type}" from jev backend`);
        }
        return { isAdvice: answer.noul >= threshold, probability: answer.noul };
      }

      // LabelOnlyAnswer（llm backend）。確率を持たない = "true"/"false" の 2 値のみ。
      if (answer.type !== 'noul') {
        throw new JudgeUnavailableError(`advice guard: unexpected answer type "${answer.type}" from llm backend`);
      }
      if (answer.label !== 'true' && answer.label !== 'false') {
        throw new JudgeUnavailableError(`advice guard: unexpected label "${answer.label}" from llm backend`);
      }
      const isAdvice = answer.label === 'true';
      return { isAdvice, probability: isAdvice ? 1 : 0 };
    } catch (e) {
      if (e instanceof RetryableJudgeError && attempt < maxRetries) {
        attempt++;
        await sleep(backoffMs(attempt));
        continue;
      }
      // 判定層が使えない・応答が得られない場合は「票なし(null)」にせず、明示的に失敗する。
      // 呼び出し側（/check）が「判定層が無い状態では走らせない」を実装できるよう、
      // バックエンド由来の失敗も JudgeUnavailableError に揃えて投げる（cause は残す）。
      if (e instanceof JudgeUnavailableError) throw e;
      throw new JudgeUnavailableError(
        `advice guard: 判定層が使えませんでした（${e instanceof Error ? e.message : String(e)}）`,
        { cause: e },
      );
    }
  }
}
