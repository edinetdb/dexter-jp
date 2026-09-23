/**
 * 環境変数からバックエンドを選ぶ。
 * 優先順位: TYPESAFE_API_KEY（Jev）> 既定（LLM 代行）。
 * ここは env を読んで各バックエンドのコンストラクタを呼ぶだけで、fetch や外部 I/O はしない。
 *
 * **録画の再生（replay）は env からは選ばない**（review T9 H5）。以前は `DEXTER_JUDGE_REPLAY`
 * を最優先で見ていたので、利用者が指すディレクトリの JSON が入口ガードの第 2 層（判定層の票）に
 * なり、`TYPESAFE_API_KEY` なしで `/check` が走った（README「鍵が無いと動きません」が破れる）。
 * replay は demo・テストが**ポートとして注入する**ものに限る（`scripts/demo.ts` は自前で注入済み）。
 */
import type { JudgeBackend } from '../types.js';
import { createJevBackend } from './jev.js';
import { createLlmBackend } from './llm.js';

export interface ResolveJudgeBackendOptions {
  env?: Record<string, string | undefined>;
}

export function resolveJudgeBackend(opts: ResolveJudgeBackendOptions = {}): JudgeBackend {
  const env = opts.env ?? process.env;

  if (env.TYPESAFE_API_KEY) {
    return createJevBackend(env.TYPESAFE_API_KEY);
  }
  return createLlmBackend();
}
