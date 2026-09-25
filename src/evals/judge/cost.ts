/**
 * 判定バックエンド呼び出しの費用見積り。
 * `usage.input_tokens` × 単価（引数で渡す。出力は無料 = 出力トークンは数えない）。
 * `cb-jev`（Jev、TypeSafe）の実測単価は $0.042/百万入力トークンだが、ここでハードコードは
 * しない — バックエンドごとに単価が違い、変わりうるため呼び出し側（cli.ts）が明示で渡す。
 */
export type BenchCostCurrency = 'usd' | 'jpy';

export interface CostBreakdown {
  inputTokens: number;
  pricePerMillionInputTokens: number;
  currency: BenchCostCurrency;
  total: number;
}

export function computeCost(
  inputTokens: number,
  pricePerMillionInputTokens: number,
  currency: BenchCostCurrency = 'usd',
): CostBreakdown {
  if (!Number.isFinite(inputTokens) || inputTokens < 0) {
    throw new Error(`inputTokens must be a non-negative finite number, got ${inputTokens}`);
  }
  if (!Number.isFinite(pricePerMillionInputTokens) || pricePerMillionInputTokens < 0) {
    throw new Error(
      `pricePerMillionInputTokens must be a non-negative finite number, got ${pricePerMillionInputTokens}`,
    );
  }
  const total = (inputTokens / 1_000_000) * pricePerMillionInputTokens;
  return { inputTokens, pricePerMillionInputTokens, currency, total };
}

/** Jev（`cb-jev`）の実測単価。cli.ts の既定値として使う（`--jev-price-per-mtok` で上書き可）。 */
export const MEASURED_JEV_PRICE_PER_MILLION_INPUT_TOKENS_USD = 0.042;
