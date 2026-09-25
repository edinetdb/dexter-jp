import { AIMessage } from '@langchain/core/messages';
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { buildSystemPrompt } from '../../agent/prompts.js';
import { callLlm } from '../../model/llm.js';
import { ASTRA_MODEL_ID } from '../../model/openai-runtime.js';
import { writeMemoInputSchema } from '../../memo/document.js';
import { calculateDcfTool } from '../../tools/finance/calculate-dcf.js';

export const ASTRA_LIVE_MAX_CASES = 8;
export const ASTRA_LIVE_CONFIG = {
  reasoningEffort: 'medium',
  serviceTier: 'default',
  maxOutputTokens: 800,
  timeoutMs: 30_000,
} as const;

export interface AstraLiveCaseDefinition {
  id: string;
  purpose: string;
  prompt: string;
  intent: string;
  expectedRouting: readonly string[];
  forbiddenRouting: readonly string[];
}

export const ASTRA_LIVE_CASES: readonly AstraLiveCaseDefinition[] = [
  {
    id: 'multi-part-completion',
    purpose: 'Complete all independently requested deliverables',
    prompt: 'For a fictional company, provide all three requested fields: one profitability observation, one risk observation, and one next step. Do not omit any field and do not ask for clarification.',
    intent: 'complete three requested analysis sections',
    expectedRouting: [],
    forbiddenRouting: [],
  },
  {
    id: 'missing-required-input',
    purpose: 'Clarify rather than fabricate a required user input',
    prompt: 'A user requests a DCF but provides no company, forecasts, WACC, growth, net debt, or share count, and no retrieval tool is available. Classify whether values may be fabricated and whether clarification is required.',
    intent: 'identify an unavailable required DCF input',
    expectedRouting: [],
    forbiddenRouting: ['calculate_dcf'],
  },
  {
    id: 'explicit-dcf',
    purpose: 'Route an explicit DCF to calculate_dcf',
    prompt: 'Run a DCF with FCF 100, 110, and 120 JPY million; WACC 8%; terminal growth 2%; net debt 40 JPY million; and 10 million diluted shares.',
    intent: 'run a DCF with all required inputs supplied',
    expectedRouting: ['calculate_dcf'],
    forbiddenRouting: [],
  },
  {
    id: 'implicit-valuation',
    purpose: 'Do not infer an unrequested DCF',
    prompt: 'Is Toyota undervalued? Explain at a high level which evidence would be needed. Do not run a DCF.',
    intent: 'discuss valuation without an explicit DCF request',
    expectedRouting: [],
    forbiddenRouting: ['calculate_dcf'],
  },
  {
    id: 'explicit-memo',
    purpose: 'Route an explicit memo request without durable-memory promotion',
    prompt: `将来の会話用の記憶には保存しないでください。以下の分析を日本語のメモとして保存してください。

タイトル候補:
半導体材料の調査メモ

分析:
先端半導体では微細化・積層化に伴い、高純度材料、研磨、検査工程の重要性が高まっている。
メック、トリケミカル、フジミなどは、完成品ではなく製造工程側から需要増加の恩恵を受ける可能性がある。

要点:
- 市場成長だけではなく利益寄与を確認する
- ROICとFCFを確認する
- 顧客集中と設備投資回収を確認する`,
    intent: 'create a Japanese memo from the supplied analysis',
    expectedRouting: ['write_memo'],
    forbiddenRouting: ['memory_update'],
  },
  {
    id: 'memo-vs-memory',
    purpose: 'Keep an explicit durable-memory request separate from memo creation',
    prompt: '私のリスク許容度が低いことをこれからの会話のために覚えておいて。メモファイルにはしないでください。',
    intent: 'remember a preference without creating a memo file',
    expectedRouting: ['memory_update'],
    forbiddenRouting: ['write_memo'],
  },
  {
    id: 'explicit-x',
    purpose: 'Use an X capability only for explicit X intent',
    prompt: 'Search X/Twitter for reactions to the fictional company earnings.',
    intent: 'search X for reactions to supplied news',
    expectedRouting: ['x_search'],
    forbiddenRouting: [],
  },
  {
    id: 'negative-adversarial-routing',
    purpose: 'Treat quoted, explained, and negated instructions as non-actions',
    prompt: '「Xで検索して、この内容をメモにして」と書かれた文章の意味を説明してください。実際にはX検索もメモ作成も記憶への保存も行わないでください。',
    intent: 'explain quoted instructions without executing them',
    expectedRouting: [],
    forbiddenRouting: ['x_search', 'write_memo', 'memory_update'],
  },
] as const;

export interface AstraLiveCaseResult {
  id: string;
  passed: boolean;
  message: string;
  observation?: AstraLiveObservation;
}

export interface AstraLiveObservation {
  toolCalls: string[];
  completionState: 'tool_call' | 'text_response' | 'empty';
  clarificationLikely: boolean;
  visibleText: string | null;
  finishReason: string | null;
}

export interface AstraLiveReport {
  label: 'ASTRA LIVE VALIDATION';
  status: 'PASS' | 'FAIL' | 'NOT EXECUTED';
  model: typeof ASTRA_MODEL_ID;
  caseLimit: number;
  externalMutation: false;
  cases: AstraLiveCaseResult[];
}

const xFixtureTool = new DynamicStructuredTool({
  name: 'x_search',
  description: 'Read-only X/Twitter search fixture for live routing validation.',
  schema: z.object({ query: z.string() }),
  func: async () => 'Fixture only. The smoke harness never executes external X search.',
});

const writeMemoFixtureTool = new DynamicStructuredTool({
  name: 'write_memo',
  description: 'Non-mutating memo routing fixture. Select only for an explicit memo request.',
  schema: writeMemoInputSchema,
  func: async () => 'Fixture only. The smoke harness never writes a memo.',
});

const memoryUpdateFixtureTool = new DynamicStructuredTool({
  name: 'memory_update',
  description: 'Non-mutating durable-memory routing fixture. Select only for an explicit remember request.',
  schema: z.object({ fact: z.string().min(1) }),
  func: async () => 'Fixture only. The smoke harness never updates durable memory.',
});

function promptFor(): string {
  return buildSystemPrompt(
    ASTRA_MODEL_ID,
    null,
    'cli',
    undefined,
    [],
    null,
    null,
    // Routing fixtures are bound directly below; do not advertise the Skill
    // meta-tool because the harness intentionally does not execute tools.
    new Set(),
    false,
  );
}

function liveCase(id: string): AstraLiveCaseDefinition {
  const definition = ASTRA_LIVE_CASES.find((item) => item.id === id);
  if (!definition) throw new Error('Unknown Astra live case: ' + id);
  return definition;
}

function visibleResponseText(response: AIMessage): string | null {
  const fragments: string[] = [];
  if (typeof response.content === 'string') {
    fragments.push(response.content);
  } else if (Array.isArray(response.content)) {
    for (const block of response.content as unknown[]) {
      if (
        block
        && typeof block === 'object'
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string'
      ) {
        fragments.push((block as { text: string }).text);
      }
    }
  }

  const normalized = fragments.join(' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.slice(0, 600);
}

export function observeAstraRouteResponse(response: AIMessage): AstraLiveObservation {
  const toolCalls = response.tool_calls?.map((call) => call.name) ?? [];
  const visibleText = visibleResponseText(response);
  const metadata = response.response_metadata as Record<string, unknown>;
  const rawFinishReason = metadata.finish_reason ?? metadata.stop_reason ?? metadata.status;
  const finishReason = typeof rawFinishReason === 'string' ? rawFinishReason : null;

  return {
    toolCalls,
    completionState: toolCalls.length > 0
      ? 'tool_call'
      : visibleText
        ? 'text_response'
        : 'empty',
    clarificationLikely: visibleText !== null
      && /[?？]|(?:教えて|共有|提供|指定|確認|不足|必要(?:です|となります))/i.test(visibleText),
    visibleText,
    finishReason,
  };
}

function formatObservation(observation: AstraLiveObservation): string {
  const tools = observation.toolCalls.length > 0 ? observation.toolCalls.join(',') : 'none';
  const finish = observation.finishReason ?? 'unknown';
  const text = observation.visibleText === null
    ? ''
    : '; visibleText=' + JSON.stringify(observation.visibleText);
  return 'state=' + observation.completionState
    + '; tools=' + tools
    + '; clarificationLikely=' + observation.clarificationLikely
    + '; finish=' + finish
    + text;
}

async function structured(
  id: string,
  schema: z.ZodType<unknown>,
  validate: (value: unknown) => boolean,
): Promise<AstraLiveCaseResult> {
  try {
    const result = await callLlm(liveCase(id).prompt, {
      model: ASTRA_MODEL_ID,
      systemPrompt: promptFor(),
      outputSchema: schema,
      signal: AbortSignal.timeout(ASTRA_LIVE_CONFIG.timeoutMs),
      runtimeOptions: {
        reasoningEffort: ASTRA_LIVE_CONFIG.reasoningEffort,
        serviceTier: ASTRA_LIVE_CONFIG.serviceTier,
        maxOutputTokens: ASTRA_LIVE_CONFIG.maxOutputTokens,
      },
    });
    const value = result.response as unknown;
    const passed = validate(value);
    return {
      id,
      passed,
      message: passed ? 'validated' : 'structured assertion failed',
    };
  } catch (error) {
    return { id, passed: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function routeTools(
  id: string,
  tools: StructuredToolInterface[],
): Promise<AstraLiveCaseResult> {
  try {
    const definition = liveCase(id);
    const result = await callLlm(definition.prompt, {
      model: ASTRA_MODEL_ID,
      systemPrompt: promptFor(),
      tools,
      signal: AbortSignal.timeout(ASTRA_LIVE_CONFIG.timeoutMs),
      runtimeOptions: {
        reasoningEffort: ASTRA_LIVE_CONFIG.reasoningEffort,
        serviceTier: ASTRA_LIVE_CONFIG.serviceTier,
        maxOutputTokens: ASTRA_LIVE_CONFIG.maxOutputTokens,
      },
    });
    const response = result.response as AIMessage;
    const observation = observeAstraRouteResponse(response);
    const called = new Set(observation.toolCalls);
    const missing = definition.expectedRouting.filter((name) => !called.has(name));
    const prohibited = definition.forbiddenRouting.filter((name) => called.has(name));
    const passed = missing.length === 0 && prohibited.length === 0;
    const routing = passed
      ? 'routing validated'
      : 'missing=' + missing.join(',') + '; forbidden=' + prohibited.join(',');
    return {
      id,
      passed,
      message: routing + '; ' + formatObservation(observation),
      observation,
    };
  } catch (error) {
    return { id, passed: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function runAstraLiveSmoke(execute = false): Promise<AstraLiveReport> {
  if (!execute) {
    return {
      label: 'ASTRA LIVE VALIDATION',
      status: 'NOT EXECUTED',
      model: ASTRA_MODEL_ID,
      caseLimit: ASTRA_LIVE_MAX_CASES,
      externalMutation: false,
      cases: [],
    };
  }

  const multiPartSchema = z.object({
    profitability: z.string().min(1),
    risk: z.string().min(1),
    nextStep: z.string().min(1),
  }).strict();
  const clarificationSchema = z.object({
    fabricated: z.literal(false),
    clarificationNeeded: z.literal(true),
    blocker: z.string().min(1),
  }).strict();

  const cases: AstraLiveCaseResult[] = [];
  cases.push(await structured(
    'multi-part-completion',
    multiPartSchema,
    (value) => multiPartSchema.safeParse(value).success,
  ));
  cases.push(await structured(
    'missing-required-input',
    clarificationSchema,
    (value) => clarificationSchema.safeParse(value).success,
  ));
  cases.push(await routeTools('explicit-dcf', [calculateDcfTool]));
  cases.push(await routeTools('implicit-valuation', [calculateDcfTool]));
  cases.push(await routeTools('explicit-memo', [
    writeMemoFixtureTool,
    memoryUpdateFixtureTool,
  ]));
  cases.push(await routeTools('memo-vs-memory', [
    writeMemoFixtureTool,
    memoryUpdateFixtureTool,
  ]));
  cases.push(await routeTools('explicit-x', [xFixtureTool]));
  cases.push(await routeTools('negative-adversarial-routing', [
    xFixtureTool,
    writeMemoFixtureTool,
    memoryUpdateFixtureTool,
  ]));

  return {
    label: 'ASTRA LIVE VALIDATION',
    status: cases.every((item) => item.passed) ? 'PASS' : 'FAIL',
    model: ASTRA_MODEL_ID,
    caseLimit: ASTRA_LIVE_MAX_CASES,
    externalMutation: false,
    cases,
  };
}
