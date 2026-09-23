/**
 * `bun run bench:judge` の中核。評価集合（JudgeRequest[]）を、同じ条件（同じ requests・
 * 同じ concurrency・同じプロセス内の連続実行）で 1 つ以上のバックエンドに通し、
 * 時間・母数・費用を測る。
 *
 * 「判定だけの時間」と「端から端まで」を分ける（T8 合格基準）:
 *   - judgeOnlyMs（バックエンドごと）= `runJudgeBatch` 自身が測る `usage.elapsedMs`。
 *     判定リクエストの実行だけの時間（予算チェック・再試行込み、バックエンド呼び出しの外側は含まない）。
 *   - endToEndMs（実行全体で 1 つ）= `endToEndStartMs` から全バックエンドの実行が終わるまでの壁時計。
 *     `endToEndStartMs` は呼び出し側（cli.ts）が渡す — 集合ファイルの読み込み・検証を含めたければ
 *     読み込み開始の時刻を渡す。省略時はこの関数に入った時刻を使う（= バックエンド実行だけを測る）。
 *
 * ★ 主張の分解・段落化・取得（`src/check/core/` や `/check` のパイプライン）はこのベンチの
 * 範囲外。ここが受け取る `requests` は既に組み立て済みの JudgeRequest 集合であることが前提。
 */
import { runJudgeBatch, type RunJudgeBatchOptions } from '../../judge/index.js';
import { isAnswerError } from '../../judge/types.js';
import type { AnswerOrError, JudgeBackend, JudgeBackendName, JudgeRequest } from '../../judge/types.js';
import { computeCost, type BenchCostCurrency, type CostBreakdown } from './cost.js';
import { collectRuntimeEnv, type RuntimeEnvInfo } from './env-info.js';

export interface BenchBackendSpec {
  /** ラベル。同じ backend.name を違う model で 2 回走らせたい時のため、backend.name と別に持てる。 */
  label?: string;
  model?: string;
  backend: JudgeBackend;
  pricePerMillionInputTokens?: number;
  currency?: BenchCostCurrency;
}

export interface BenchBackendCounts {
  /** 評価集合のリクエスト数（= requests.length、バックエンドを跨いで共通）。 */
  requests: number;
  /** 全リクエストの質問数の合計（= リクエストごとの Object.keys(questions).length の総和）。 */
  questions: number;
  /** 実際に発火した HTTP/バックエンド呼び出しの総数（再試行を含む。runJudgeBatch の usage.requestCount）。 */
  httpCalls: number;
  /** httpCalls のうち再試行ぶん（= httpCalls - 最低1回は着手できたリクエスト数）。0未満にはならない。 */
  retries: number;
  /** answers に結果が載ったリクエスト数（エラーで終わったものも含む — 着手はできた）。 */
  answered: number;
  /** 予算切れ等で一度も着手できなかったリクエスト数。 */
  unchecked: number;
  truncated: boolean;
}

export interface BenchBackendResult {
  backend: JudgeBackendName;
  label?: string;
  model?: string;
  timing: { judgeOnlyMs: number };
  counts: BenchBackendCounts;
  /** AnswerError の code ごとの件数（error 0 件なら空配列）。 */
  errors: { code: string; count: number }[];
  cost: CostBreakdown | null;
}

export interface BenchRunResult {
  date: string;
  env: RuntimeEnvInfo;
  datasetPath?: string;
  datasetHash?: string;
  label?: string;
  n: number;
  questionCount: number;
  timing: { endToEndMs: number };
  backends: BenchBackendResult[];
}

export interface RunJudgeBenchOptions {
  requests: JudgeRequest[];
  backends: BenchBackendSpec[];
  concurrency?: number;
  datasetPath?: string;
  datasetHash?: string;
  label?: string;
  env?: RuntimeEnvInfo;
  /** ISO 文字列。省略時は実行開始時刻。 */
  date?: string;
  /** 壁時計。省略時は Date.now。 */
  clock?: () => number;
  /** endToEndMs の起点。省略時はこの関数に入った時刻（= バックエンド実行だけを測る）。 */
  endToEndStartMs?: number;
  /** テスト注入用。省略時は実物の runJudgeBatch。 */
  runJudgeBatchImpl?: (requests: readonly JudgeRequest[], opts: RunJudgeBatchOptions) => ReturnType<typeof runJudgeBatch>;
}

function sumQuestions(requests: readonly JudgeRequest[]): number {
  return requests.reduce((sum, r) => sum + Object.keys(r.questions).length, 0);
}

function summarizeErrors(answers: Record<string, Record<string, AnswerOrError>>): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const perRequest of Object.values(answers)) {
    for (const answer of Object.values(perRequest)) {
      if (isAnswerError(answer)) {
        counts.set(answer.code, (counts.get(answer.code) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export async function runJudgeBench(opts: RunJudgeBenchOptions): Promise<BenchRunResult> {
  if (opts.requests.length === 0) {
    throw new Error('runJudgeBench: requests must not be empty');
  }
  if (opts.backends.length === 0) {
    throw new Error('runJudgeBench: backends must not be empty');
  }

  const clock = opts.clock ?? Date.now;
  const endToEndStart = opts.endToEndStartMs ?? clock();
  const date = opts.date ?? new Date(endToEndStart).toISOString();
  const runBatch = opts.runJudgeBatchImpl ?? runJudgeBatch;
  const questionCount = sumQuestions(opts.requests);

  const backendResults: BenchBackendResult[] = [];
  for (const spec of opts.backends) {
    const batchResult = await runBatch(opts.requests, {
      backend: spec.backend,
      concurrency: opts.concurrency,
    });

    const attempted = opts.requests.length - batchResult.uncheckedCount;
    const retries = Math.max(0, batchResult.usage.requestCount - attempted);
    const cost =
      spec.pricePerMillionInputTokens != null
        ? computeCost(batchResult.usage.inputTokens, spec.pricePerMillionInputTokens, spec.currency ?? 'usd')
        : null;

    backendResults.push({
      backend: spec.backend.name,
      label: spec.label,
      model: spec.model,
      timing: { judgeOnlyMs: batchResult.usage.elapsedMs },
      counts: {
        requests: opts.requests.length,
        questions: questionCount,
        httpCalls: batchResult.usage.requestCount,
        retries,
        answered: Object.keys(batchResult.answers).length,
        unchecked: batchResult.uncheckedCount,
        truncated: batchResult.truncated,
      },
      errors: summarizeErrors(batchResult.answers),
      cost,
    });
  }

  const endToEndMs = clock() - endToEndStart;

  return {
    date,
    env: opts.env ?? collectRuntimeEnv(),
    datasetPath: opts.datasetPath,
    datasetHash: opts.datasetHash,
    label: opts.label,
    n: opts.requests.length,
    questionCount,
    timing: { endToEndMs },
    backends: backendResults,
  };
}
