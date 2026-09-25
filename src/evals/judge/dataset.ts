/**
 * `bun run bench:judge` の入力集合の読み込み・検証。
 *
 * 集合ファイルは `JudgeRequest`（`src/judge/types.ts`）の配列そのもの。
 * 主張の分解・段落化（`src/check/core/`）や判定リクエストの組み立ては
 * このベンチの範囲外 — 呼び出し側（T6 の較正集合など）が
 * 「段落 × 主張 = 1 リクエスト」の形にした JSON を渡す前提にして、
 * `src/judge/` の既存ロジックをそのまま再利用する（分解ロジックの二重実装を避ける）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Question, QuestionType, JudgeRequest } from '../../judge/types.js';

export class JudgeDatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeDatasetError';
  }
}

const QUESTION_TYPES: readonly QuestionType[] = ['choice', 'score', 'noul'];

function fail(path: string, detail: string): never {
  throw new JudgeDatasetError(`invalid judge bench dataset at ${path}: ${detail}`);
}

function validateQuestion(path: string, key: string, raw: unknown): Question {
  if (!raw || typeof raw !== 'object') {
    fail(path, `question "${key}" is not an object`);
  }
  const q = raw as Record<string, unknown>;
  if (typeof q.type !== 'string' || !QUESTION_TYPES.includes(q.type as QuestionType)) {
    fail(path, `question "${key}" has an invalid "type" (expected one of ${QUESTION_TYPES.join(', ')})`);
  }
  if (typeof q.instructions !== 'string' || q.instructions.trim().length === 0) {
    fail(path, `question "${key}" is missing non-empty "instructions"`);
  }

  if (q.type === 'choice') {
    if (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria)) {
      fail(path, `question "${key}" (choice) needs "criteria" as an object of choice→description`);
    }
    if (Object.keys(q.criteria as Record<string, unknown>).length === 0) {
      fail(path, `question "${key}" (choice) has an empty "criteria"`);
    }
  } else if (q.type === 'score') {
    if (!Array.isArray(q.criteria) || q.criteria.length === 0) {
      fail(path, `question "${key}" (score) needs "criteria" as a non-empty array`);
    }
  } else {
    // noul
    const c = q.criteria as Record<string, unknown> | undefined;
    if (!c || typeof c.true !== 'string' || typeof c.false !== 'string') {
      fail(path, `question "${key}" (noul) needs "criteria" with "true" and "false" strings`);
    }
  }

  return q as unknown as Question;
}

function validateRequest(path: string, index: number, raw: unknown): JudgeRequest {
  if (!raw || typeof raw !== 'object') {
    fail(path, `entry ${index} is not an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || r.key.trim().length === 0) {
    fail(path, `entry ${index} is missing a non-empty "key"`);
  }
  if (typeof r.state !== 'string' || r.state.trim().length === 0) {
    fail(path, `entry ${index} ("${r.key}") is missing a non-empty "state"`);
  }
  if (!r.questions || typeof r.questions !== 'object' || Array.isArray(r.questions)) {
    fail(path, `entry ${index} ("${r.key}") is missing a "questions" object`);
  }
  const questions: Record<string, Question> = {};
  for (const [qKey, qRaw] of Object.entries(r.questions as Record<string, unknown>)) {
    questions[qKey] = validateQuestion(path, `${r.key}.${qKey}`, qRaw);
  }
  if (Object.keys(questions).length === 0) {
    fail(path, `entry ${index} ("${r.key}") has zero questions`);
  }

  return { key: r.key as string, state: r.state as string, questions };
}

export interface JudgeBenchDataset {
  requests: JudgeRequest[];
  /** sha256 of the normalized dataset, first 12 hex chars (same convention as src/evals/dataset.ts). */
  hash: string;
}

/** Parses and validates dataset JSON already read into memory. Pure — no file I/O. */
export function parseJudgeBenchDataset(json: string, sourcePath = '<in-memory>'): JudgeBenchDataset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    fail(sourcePath, `not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!Array.isArray(parsed)) {
    fail(sourcePath, 'top level must be a JSON array of JudgeRequest entries');
  }
  if (parsed.length === 0) {
    fail(sourcePath, 'dataset is empty — need at least one entry');
  }

  const requests = parsed.map((entry, index) => validateRequest(sourcePath, index, entry));

  const seenKeys = new Set<string>();
  for (const r of requests) {
    if (seenKeys.has(r.key)) fail(sourcePath, `duplicate request key "${r.key}"`);
    seenKeys.add(r.key);
  }

  const hash = createHash('sha256').update(JSON.stringify(requests)).digest('hex').slice(0, 12);
  return { requests, hash };
}

export function loadJudgeBenchDataset(path: string): JudgeBenchDataset {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (e) {
    throw new JudgeDatasetError(
      `could not read judge bench dataset at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return parseJudgeBenchDataset(raw, path);
}
