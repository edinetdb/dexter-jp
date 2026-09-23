/**
 * 判定層が生成するユーザー向け文言。
 * G-A6: バーの数字の説明は逐語で「この段落と主張の関係についてのモデルの推定」。
 * 「正しい確率」「支持率」「的中」は判定層の出す文字列に現れてはいけない。
 */

export const JUDGE_ESTIMATE_DISCLAIMER = 'この段落と主張の関係についてのモデルの推定';

/** Score のバケット化で最大確率が 0.5 未満だった時に使うラベル。 */
export const JUDGE_NEEDS_REVIEW_LABEL = '要確認';

/** 判定層が出す文言のうち、語彙検査の対象にする文字列一覧（テスト・linter の走査対象）。 */
export const JUDGE_DISPLAY_STRINGS: readonly string[] = [
  JUDGE_ESTIMATE_DISCLAIMER,
  JUDGE_NEEDS_REVIEW_LABEL,
];

/** 判定層の出力に含めてはいけない語（G-A6）。 */
export const FORBIDDEN_DISPLAY_WORDS: readonly string[] = ['正しい確率', '支持率', '的中'];

export function containsForbiddenDisplayWord(text: string): string | null {
  for (const word of FORBIDDEN_DISPLAY_WORDS) {
    if (text.includes(word)) return word;
  }
  return null;
}
