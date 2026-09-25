/**
 * replay バックエンドが使う要求ハッシュ。
 * 設計 §4.1: 「要求のハッシュ = state + instructions + criteria + model」。
 * criteria は object/array なので、キー順に依存しないよう決定的にシリアライズしてからハッシュする。
 */
import { createHash } from 'node:crypto';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export interface JudgeQuestionHashInput {
  state: string;
  instructions: string;
  criteria: unknown;
  model: string;
}

export function judgeQuestionHash(input: JudgeQuestionHashInput): string {
  const payload = stableStringify({
    state: input.state,
    instructions: input.instructions,
    criteria: input.criteria,
    model: input.model,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
