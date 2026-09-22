/**
 * 入力ガード（go-decision G-A1 / G-A2、design §4.2）。
 *
 * `/check` の入口は 1 つ。売買の助言・価値の助言を求める入力は**判定に進めない**。
 *
 * 判定の順序（fail-close）:
 *   1. 決定論の語彙リスト（一次）。**Jev の票でこの拒否は解除しない**
 *   2. Judge(Noul) の追加票（OR）。語彙リストが通しても、Noul が該当と言えば拒否
 *   3. 言い換えの提案は 2〜3 個。**非対話環境では提案せず拒否で終わる**（review r2 M12:
 *      `ask_user_question` は agent ループ前提で、非対話では「best judgment で進め」を
 *      返す fail-open。同じ設計を踏まない）
 *   4. 言い換えを選んで再入力された文も、**同じ検査をもう一度通る**
 */
import { findVocabularyHits, INPUT_LISTS, type VocabularyHit } from './vocabulary.js';
import { findIntentHits, type IntentHit } from './intent-patterns.js';

/** Judge(Noul) の追加票。鍵が無い・判定層が使えないときは呼ばれない。 */
export type AdviceVote = (input: string) => Promise<{ isAdvice: boolean; probability: number } | null>;

export interface GuardOptions {
  /** 対話できる端末か。false なら提案せず拒否で終わる（fail-close） */
  interactive: boolean;
  /** Judge(Noul) の追加票。省略時は語彙リストだけで判定する */
  vote?: AdviceVote;
  /** Noul をどこから「該当」とみなすか */
  voteThreshold?: number;
}

export type GuardVerdict =
  | { decision: 'proceed' }
  | {
      decision: 'refuse';
      /** どこで止まったか。`vocabulary` / `intent` は Judge の票で覆らない */
      by: 'vocabulary' | 'intent' | 'judge';
      hits: VocabularyHit[];
      /** 構造で当たった箇所（`by:'intent'` のとき） */
      intentHits?: IntentHit[];
      /** Judge が該当と言ったときの確率（`by:'judge'` のときだけ） */
      probability?: number;
      /** 対話できるときだけ 2〜3 個。非対話では空 */
      suggestions: string[];
      message: string;
    };

const REFUSAL_MESSAGE =
  'この問いには答えられません。/check は、あなたの仮説を有価証券報告書の段落に当てて' +
  '「裏付ける / 食い違う / 無関係」を返す機能で、売買の指示や株価の水準についての判断は出しません。';

const REFUSAL_MESSAGE_NON_INTERACTIVE =
  REFUSAL_MESSAGE + '（非対話のため言い換えの提案は出しません）';

/**
 * 言い換えの候補。**開示で確かめられる形**に寄せる。
 * 当社生成の文字列なので、これ自体が出力 linter を通る語彙で書く。
 */
const SUGGESTIONS_BY_LIST: Record<'trading' | 'valuation', readonly string[]> = {
  trading: [
    'この会社が有価証券報告書で述べている経営方針は、前期から変わったか',
    'この会社は株主還元の方針として何を開示しているか',
    'この会社が「事業等のリスク」に挙げている項目は何か',
  ],
  valuation: [
    'この会社は業績の見通しについて有価証券報告書で何と書いているか',
    'この会社が開示した利益の計画と、実績はどう違ったか',
    'この会社が自分で挙げている業績の変動要因は何か',
  ],
};

function suggestionsFor(hits: VocabularyHit[]): string[] {
  const hasTrading = hits.some(h => h.list === 'trading');
  const hasValuation = hits.some(h => h.list === 'valuation');
  if (hasValuation && !hasTrading) return [...SUGGESTIONS_BY_LIST.valuation];
  if (hasTrading && !hasValuation) return [...SUGGESTIONS_BY_LIST.trading];
  // 両方（または Judge だけ）のときは両方から混ぜる
  return [SUGGESTIONS_BY_LIST.trading[0], SUGGESTIONS_BY_LIST.valuation[0], SUGGESTIONS_BY_LIST.trading[2]];
}

function refuse(
  by: 'vocabulary' | 'intent' | 'judge',
  hits: VocabularyHit[],
  interactive: boolean,
  probability?: number,
  intentHits?: IntentHit[],
): GuardVerdict {
  return {
    decision: 'refuse',
    by,
    hits,
    ...(intentHits === undefined ? {} : { intentHits }),
    ...(probability === undefined ? {} : { probability }),
    suggestions: interactive ? suggestionsFor(hits) : [],
    message: interactive ? REFUSAL_MESSAGE : REFUSAL_MESSAGE_NON_INTERACTIVE,
  };
}

/**
 * 入力を検査する。言い換え後の再入力も**この同じ関数**を通す。
 */
export async function guardInput(input: string, options: GuardOptions): Promise<GuardVerdict> {
  const hits = findVocabularyHits(input, INPUT_LISTS);
  if (hits.length > 0) {
    // 一次 = 決定論。ここで止まったら Judge は呼ばない（票で解除されないことを構造で示す）
    return refuse('vocabulary', hits, options.interactive);
  }

  // 第 2 層も決定論。語を使わずに助言を求める型を構造で捉える
  const intentHits = findIntentHits(input);
  if (intentHits.length > 0) {
    return refuse('intent', [], options.interactive, undefined, intentHits);
  }

  if (options.vote) {
    const threshold = options.voteThreshold ?? 0.5;
    const vote = await options.vote(input);
    if (vote && vote.isAdvice && vote.probability >= threshold) {
      return refuse('judge', [], options.interactive, vote.probability);
    }
  }

  return { decision: 'proceed' };
}
