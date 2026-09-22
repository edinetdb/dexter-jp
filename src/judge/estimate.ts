/** 実行前の見積り（設計 §4.1「実行前に見積り（段落数 × 主張数）を 1 行返せる関数を持つ」）。 */
export function estimateJudgeCost(paragraphCount: number, claimCount: number): string {
  const pairs = paragraphCount * claimCount;
  return `見積り: 段落 ${paragraphCount} × 主張 ${claimCount} = 判定 ${pairs} 件（リクエスト数 ${paragraphCount}）`;
}
