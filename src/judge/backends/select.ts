/**
 * 環境変数からバックエンドを選ぶ。
 * 優先順位: DEXTER_JUDGE_REPLAY（明示的な録画再生。demo・回帰テスト）
 *         > TYPESAFE_API_KEY（Jev）
 *         > 既定（LLM 代行）。
 * ここは env を読んで各バックエンドのコンストラクタを呼ぶだけで、fetch や外部 I/O はしない。
 */
import type { JudgeBackend } from '../types.js';
import { createJevBackend } from './jev.js';
import { createLlmBackend } from './llm.js';
import { createReplayBackend } from './replay.js';

export interface ResolveJudgeBackendOptions {
  env?: Record<string, string | undefined>;
}

export function resolveJudgeBackend(opts: ResolveJudgeBackendOptions = {}): JudgeBackend {
  const env = opts.env ?? process.env;

  if (env.DEXTER_JUDGE_REPLAY) {
    return createReplayBackend(env.DEXTER_JUDGE_REPLAY);
  }
  if (env.TYPESAFE_API_KEY) {
    return createJevBackend(env.TYPESAFE_API_KEY);
  }
  return createLlmBackend();
}
