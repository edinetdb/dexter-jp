/**
 * 判定層（Judge）の型定義。
 *
 * 設計 = hq/reports/dexter-tv-jev/design-v0.md §4.1・§5。
 * Jev の実際の HTTP 契約（実測済み）:
 *   POST https://api.typesafe.ai/v1/systemone
 *   body = { state, questions: { [key]: {type, instructions, criteria} }, model }
 *   応答 = { answers: { [key]: <型ごとの回答> }, usage: { input_tokens }, model }
 * `probabilities` はクラス名をキーにした object（配列ではない。キー出現順は不定）。
 */

export type QuestionType = 'choice' | 'score' | 'noul';

/** choice: 選択肢キー → 説明文。 */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

/** score: 0 始まりの段階を並べた説明文の配列（index = クラス）。 */
export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

/** noul: true/false それぞれの説明文。 */
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/**
 * 判定層への 1 リクエスト = Jev の 1 HTTP 呼び出しに対応する単位
 * （設計: 「段落 1 本 = 1 リクエスト、主張を並列の Choice で」）。
 * `key` は呼び出し側が付ける識別子（例: 段落 ID）で、結果の突合に使う。
 */
export interface JudgeRequest {
  key: string;
  state: string;
  questions: Record<string, Question>;
}

// ---------------------------------------------------------------------------
// 回答（Jev バックエンド。確率つき）
// ---------------------------------------------------------------------------

export interface ChoiceAnswer {
  type: 'choice';
  backend: 'jev';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  backend: 'jev';
  score: number;
  confidence: number;
  /** クラス index(文字列) → 説明文。criteria をそのまま写したもの、または応答の legend。 */
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  /**
   * 分布の最大クラス(index 文字列)。最大確率が 0.5 未満なら null(「要確認」)。
   * 設計 §4.1「Score は分布の最大クラスで仕分ける。最大確率 < 0.5 は『要確認』」。
   */
  bucket: string | null;
}

export interface NoulAnswer {
  type: 'noul';
  backend: 'jev';
  noul: number;
  confidence?: number;
  probabilities?: { true: number; false: number };
}

export type JevAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

/**
 * LLM 代行バックエンドの回答。確率を持たず閾値にもかけない（設計 §4.1、確率なし型の分離）。
 * `label` は choice の選択肢キー / score のクラス index(文字列) / noul の "true"|"false"。
 */
export interface LabelOnlyAnswer {
  type: QuestionType;
  backend: 'llm';
  label: string;
}

export type Answer = JevAnswer | LabelOnlyAnswer;

export type AnswerErrorCode =
  | 'invalid_distribution'
  | 'missing_answer'
  | 'rate_limited'
  | 'timeout'
  | 'replay_miss'
  | 'unknown';

export interface AnswerError {
  error: string;
  code: AnswerErrorCode;
}

export type AnswerOrError = Answer | AnswerError;

export function isAnswerError(a: AnswerOrError): a is AnswerError {
  return typeof a === 'object' && a !== null && 'error' in a && 'code' in a;
}

// ---------------------------------------------------------------------------
// バックエンド境界
// ---------------------------------------------------------------------------

export type JudgeBackendName = 'jev' | 'llm' | 'replay';

export interface JudgeBackendCallResult {
  /** リクエスト内の各 question key → 回答 or エラー。 */
  answers: Record<string, AnswerOrError>;
  /** この 1 回の呼び出しで消費した入力トークン数（不明なバックエンドは 0）。 */
  inputTokens: number;
}

export interface JudgeBackend {
  readonly name: JudgeBackendName;
  call(request: JudgeRequest): Promise<JudgeBackendCallResult>;
}

// ---------------------------------------------------------------------------
// バッチ実行（予算・並列・再試行つきオーケストレーション）
// ---------------------------------------------------------------------------

export interface JudgeUsage {
  /** 再試行を含む、実行された判定リクエストの総数。 */
  requestCount: number;
  inputTokens: number;
  elapsedMs: number;
}

export interface JudgeBatchResult {
  /** request.key → (question key → 回答 or エラー)。予算切れ・失敗で欠けた request.key は answers に現れない。 */
  answers: Record<string, Record<string, AnswerOrError>>;
  usage: JudgeUsage;
  /** 予算（件数・トークン・時間のいずれか）に達して打ち切ったか。 */
  truncated: boolean;
  /** 着手できなかった、または予算切れで未完のまま終わった request の数。 */
  uncheckedCount: number;
  backend: JudgeBackendName;
}
