/**
 * LLM 代行バックエンド。TYPESAFE_API_KEY が無い時の既定。
 * 確率を持たない別の型 `LabelOnlyAnswer` を返し、閾値にはかけない（設計 §4.1）。
 * 既存の LLM 呼び出しは `src/model/llm.ts` の `callLlm` を使うが、テストが実 API に
 * 出ないよう `callLlmImpl` を注入可能にしてある。
 */
import { callLlm } from '@/model/llm';
import type { JudgeBackend, JudgeBackendCallResult, JudgeRequest, Question } from '../types.js';

type CallLlmFn = typeof callLlm;

export interface CreateLlmBackendOptions {
  model?: string;
  callLlmImpl?: CallLlmFn;
}

function validLabelsFor(q: Question): string[] {
  if (q.type === 'choice') return Object.keys(q.criteria);
  if (q.type === 'score') return q.criteria.map((_, i) => String(i));
  return ['true', 'false'];
}

function criteriaTextFor(q: Question): string {
  if (q.type === 'choice') {
    return Object.entries(q.criteria)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');
  }
  if (q.type === 'score') {
    return q.criteria.map((v, i) => `- ${i}: ${v}`).join('\n');
  }
  return `- true: ${q.criteria.true}\n- false: ${q.criteria.false}`;
}

function buildLabelOnlyPrompt(state: string, q: Question): string {
  const labels = validLabelsFor(q);
  return [
    `証拠:`,
    state,
    ``,
    `問い: ${q.instructions}`,
    ``,
    `次の選択肢のうちちょうど1つだけを選び、最後の行に「ANSWER: <選択肢>」とだけ書いてください。`,
    `選択肢は次のいずれかです: ${labels.join(', ')}`,
    criteriaTextFor(q),
  ].join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractLabel(q: Question, text: string): string | null {
  const labels = validLabelsFor(q);
  const match = text.match(/ANSWER:\s*(\S+)/i);
  const candidate = match?.[1]?.trim();
  if (candidate && labels.includes(candidate)) return candidate;
  for (const label of labels) {
    const re = new RegExp(`(^|[^\\w])${escapeRegExp(label)}([^\\w]|$)`);
    if (re.test(text)) return label;
  }
  return null;
}

export function createLlmBackend(opts: CreateLlmBackendOptions = {}): JudgeBackend {
  const callLlmImpl: CallLlmFn = opts.callLlmImpl ?? callLlm;

  return {
    name: 'llm',
    async call(request: JudgeRequest): Promise<JudgeBackendCallResult> {
      const answers: JudgeBackendCallResult['answers'] = {};
      let inputTokens = 0;

      for (const [key, question] of Object.entries(request.questions)) {
        try {
          const prompt = buildLabelOnlyPrompt(request.state, question);
          const { response, usage } = await callLlmImpl(prompt, { model: opts.model });
          const text = typeof response === 'string' ? response : String(response.content ?? '');
          const label = extractLabel(question, text);
          if (label === null) {
            answers[key] = {
              error: `could not extract a label for "${key}" from the LLM response`,
              code: 'missing_answer',
            };
          } else {
            answers[key] = { type: question.type, backend: 'llm', label };
          }
          inputTokens += usage?.inputTokens ?? 0;
        } catch (e) {
          answers[key] = { error: e instanceof Error ? e.message : String(e), code: 'unknown' };
        }
      }

      return { answers, inputTokens };
    },
  };
}
