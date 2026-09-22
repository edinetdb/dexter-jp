/**
 * Jev の生の応答を、宣言された criteria に照らして検証・正規化する。
 *
 * 不正な分布（合計が 1 にならない・クラス名が criteria と違う・負の値）と
 * 回答の欠落は、ここで AnswerError に落として呼び出し元へ返す（例外は投げない）。
 *
 * ★ choice の一貫性検査: `choice` は `probabilities` の最大クラスと一致していなければならない。
 * `probabilities` の値の割り当てを 1 つずらす（例: supports の値を unrelated へ移す）と、
 * `choice` はそのまま「supports」でも最大クラスは別のキーになり、この検査で invalid_distribution になる。
 */
import type {
  AnswerError,
  AnswerOrError,
  ChoiceQuestion,
  NoulQuestion,
  Question,
  ScoreQuestion,
} from './types.js';

const DISTRIBUTION_SUM_TOLERANCE = 0.02;

interface DistributionOk {
  error?: undefined;
  normalized: Record<string, number>;
  argmax: string;
}

interface DistributionErr {
  error: AnswerError;
  normalized?: undefined;
  argmax?: undefined;
}

type DistributionResult = DistributionOk | DistributionErr;

function invalid(message: string): AnswerError {
  return { error: message, code: 'invalid_distribution' };
}

function missing(message: string): AnswerError {
  return { error: message, code: 'missing_answer' };
}

/**
 * `raw` が `expectedKeys` ちょうどをキーに持つ確率分布であることを検証する。
 * キー不一致・負値・NaN・合計 ≠ 1(許容誤差 0.02) のいずれかで invalid_distribution。
 */
export function validateDistribution(raw: unknown, expectedKeys: string[]): DistributionResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: invalid('probabilities must be an object') };
  }
  const r = raw as Record<string, unknown>;
  const gotKeys = Object.keys(r).sort();
  const expected = [...expectedKeys].sort();
  if (gotKeys.length !== expected.length || gotKeys.some((k, i) => k !== expected[i])) {
    return {
      error: invalid(
        `probabilities keys [${gotKeys.join(',')}] do not match expected [${expected.join(',')}]`,
      ),
    };
  }

  let sum = 0;
  let argmax = expected[0];
  let argmaxVal = -Infinity;
  const normalized: Record<string, number> = {};
  for (const k of expected) {
    const v = r[k];
    if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1) {
      return { error: invalid(`probabilities["${k}"] must be a number in [0,1], got ${String(v)}`) };
    }
    normalized[k] = v;
    sum += v;
    if (v > argmaxVal) {
      argmaxVal = v;
      argmax = k;
    }
  }
  if (Math.abs(sum - 1) > DISTRIBUTION_SUM_TOLERANCE) {
    return { error: invalid(`probabilities sum to ${sum}, expected ~1`) };
  }
  return { normalized, argmax };
}

export function validateChoiceAnswer(question: ChoiceQuestion, raw: unknown): AnswerOrError {
  if (!raw || typeof raw !== 'object') return invalid('answer is not an object');
  const r = raw as Record<string, unknown>;

  const criteriaKeys = Object.keys(question.criteria);
  const choice = r.choice;
  if (typeof choice !== 'string' || !criteriaKeys.includes(choice)) {
    return invalid(`choice "${String(choice)}" is not one of the declared criteria keys [${criteriaKeys.join(',')}]`);
  }

  const confidence = r.confidence;
  if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    return invalid(`confidence must be a number in [0,1], got ${String(confidence)}`);
  }

  const dist = validateDistribution(r.probabilities, criteriaKeys);
  if (dist.error) return dist.error;

  // choice はタイ(同率首位)なら許容する。「argmax の key と文字列一致」ではなく
  // 「choice の確率が最大値と一致しているか」で判定する。
  const maxVal = Math.max(...Object.values(dist.normalized));
  if (Math.abs(dist.normalized[choice] - maxVal) > 1e-9) {
    return invalid(
      `choice "${choice}" (p=${dist.normalized[choice]}) does not match the highest-probability class (max=${maxVal}, probabilities=${JSON.stringify(dist.normalized)})`,
    );
  }

  return { type: 'choice', backend: 'jev', choice, confidence, probabilities: dist.normalized };
}

export function validateScoreAnswer(question: ScoreQuestion, raw: unknown): AnswerOrError {
  if (!raw || typeof raw !== 'object') return invalid('answer is not an object');
  const r = raw as Record<string, unknown>;

  const score = r.score;
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return invalid(`score must be a number, got ${String(score)}`);
  }

  const confidence = r.confidence;
  if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    return invalid(`confidence must be a number in [0,1], got ${String(confidence)}`);
  }

  const expectedKeys = question.criteria.map((_, i) => String(i));
  const dist = validateDistribution(r.probabilities, expectedKeys);
  if (dist.error) return dist.error;

  const maxVal = dist.normalized[dist.argmax];
  const bucket = maxVal >= 0.5 ? dist.argmax : null;

  const rawLegend = r.legend;
  const legend: Record<string, string> =
    rawLegend && typeof rawLegend === 'object' && !Array.isArray(rawLegend)
      ? (rawLegend as Record<string, string>)
      : Object.fromEntries(question.criteria.map((text, i) => [String(i), text]));

  return {
    type: 'score',
    backend: 'jev',
    score,
    confidence,
    legend,
    probabilities: dist.normalized,
    bucket,
  };
}

export function validateNoulAnswer(question: NoulQuestion, raw: unknown): AnswerOrError {
  if (!raw || typeof raw !== 'object') return invalid('answer is not an object');
  const r = raw as Record<string, unknown>;

  const noul = r.noul;
  if (typeof noul !== 'number' || Number.isNaN(noul) || noul < 0 || noul > 1) {
    return invalid(`noul must be a number in [0,1], got ${String(noul)}`);
  }

  let probabilities: { true: number; false: number } | undefined;
  if (r.probabilities !== undefined) {
    const dist = validateDistribution(r.probabilities, ['true', 'false']);
    if (dist.error) return dist.error;
    probabilities = { true: dist.normalized.true, false: dist.normalized.false };
    if (Math.abs(probabilities.true - noul) > 0.05) {
      return invalid(
        `noul (${noul}) does not match probabilities.true (${probabilities.true})`,
      );
    }
  }

  const confidence = typeof r.confidence === 'number' ? r.confidence : undefined;
  // question の criteria(true/false の説明文) は検証には使わないが、型の対応を明示するため受け取る。
  void question;
  return { type: 'noul', backend: 'jev', noul, confidence, probabilities };
}

/** raw answer(unknown) を question の型に応じて検証・正規化する。回答が丸ごと欠落した場合は呼び出し元で missing() を使う。 */
export function validateAnswer(question: Question, raw: unknown): AnswerOrError {
  if (raw === undefined) return missing('answer is missing');
  switch (question.type) {
    case 'choice':
      return validateChoiceAnswer(question, raw);
    case 'score':
      return validateScoreAnswer(question, raw);
    case 'noul':
      return validateNoulAnswer(question, raw);
    default: {
      const _exhaustive: never = question;
      return invalid(`unknown question type: ${String((_exhaustive as Question).type)}`);
    }
  }
}
