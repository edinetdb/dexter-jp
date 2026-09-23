/**
 * T8 合格基準:「精度」「的中」「当たる」を使わない（出力の文字列に含めない。テストで固定）。
 *
 * これは `src/judge/display.ts` の `FORBIDDEN_DISPLAY_WORDS`（判定層がユーザーに見せる文言の
 * 禁止語、G-A6）とは別物 — こちらはベンチの出力 JSON（フィールド名・値の両方）が対象。
 */
export const BENCH_OUTPUT_FORBIDDEN_WORDS = ['精度', '的中', '当たる'] as const;

export function findForbiddenBenchWords(serialized: string): string[] {
  return BENCH_OUTPUT_FORBIDDEN_WORDS.filter((word) => serialized.includes(word));
}

/** 見つかったら投げる。ベンチ出力を書き出す前に必ず通す。 */
export function assertNoForbiddenBenchWords(serialized: string): void {
  const hits = findForbiddenBenchWords(serialized);
  if (hits.length > 0) {
    throw new Error(`bench output contains forbidden words: ${hits.join(', ')}`);
  }
}
