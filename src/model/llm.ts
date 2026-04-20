import { AIMessage, AIMessageChunk, BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOllama } from '@langchain/ollama';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { StructuredToolInterface } from '@langchain/core/tools';
import { Runnable } from '@langchain/core/runnables';
import { z } from 'zod';
import { DEFAULT_SYSTEM_PROMPT } from '@/agent/prompts';
import type { TokenUsage } from '@/agent/types';
import { logger } from '@/utils';
import { classifyError, isNonRetryableError } from '@/utils/errors';
import { resolveProvider, getProviderById } from '@/providers';

export const DEFAULT_PROVIDER = 'openai';
export const DEFAULT_MODEL = 'gpt-5.4';

/**
 * Gets the fast model variant for the given provider.
 * Falls back to the provided model if no fast variant is configured (e.g., Ollama).
 */
export function getFastModel(modelProvider: string, fallbackModel: string): string {
  return getProviderById(modelProvider)?.fastModel ?? fallbackModel;
}

// Generic retry helper with exponential backoff
async function withRetry<T>(fn: () => Promise<T>, provider: string, maxAttempts = 3): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const errorType = classifyError(message);
      logger.error(`[${provider} API] ${errorType} error (attempt ${attempt + 1}/${maxAttempts}): ${message}`);

      if (isNonRetryableError(message)) {
        throw new Error(`[${provider} API] ${message}`);
      }

      if (attempt === maxAttempts - 1) {
        throw new Error(`[${provider} API] ${message}`);
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error('Unreachable');
}

// Model provider configuration
interface ModelOpts {
  streaming: boolean;
}

type ModelFactory = (name: string, opts: ModelOpts) => BaseChatModel;

function getApiKey(envVar: string): string {
  const apiKey = process.env[envVar];
  if (!apiKey) {
    throw new Error(`[LLM] ${envVar} not found in environment variables`);
  }
  return apiKey;
}

// Factories keyed by provider id — prefix routing is handled by resolveProvider()
const MODEL_FACTORIES: Record<string, ModelFactory> = {
  anthropic: (name, opts) =>
    new ChatAnthropic({
      model: name,
      ...opts,
      apiKey: getApiKey('ANTHROPIC_API_KEY'),
    }),
  google: (name, opts) => {
    const model = new ChatGoogleGenerativeAI({
      model: name,
      ...opts,
      apiKey: getApiKey('GOOGLE_API_KEY'),
    });
    // Wrap bindTools to sanitize schemas for Gemini API
    // Zod v4 may generate oneOf+const which Gemini rejects
    const originalBind = model.bindTools.bind(model);
    model.bindTools = function(tools: unknown[], ...rest: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = originalBind(tools as any, ...(rest as any[])) as any;
      // Sanitize config.tools (where LangChain Google stores functionDeclarations)
      if (result.config?.tools) {
        result.config.tools = JSON.parse(
          JSON.stringify(result.config.tools, (_key: string, value: unknown) => {
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
              const obj = value as Record<string, unknown>;
              // Convert oneOf/anyOf with const values to enum
              for (const prop of ['oneOf', 'anyOf'] as const) {
                if (Array.isArray(obj[prop])) {
                  const items = obj[prop] as Record<string, unknown>[];
                  const constVals = items
                    .filter(i => i && typeof i === 'object' && 'const' in i)
                    .map(i => i.const);
                  if (constVals.length === items.length && constVals.length > 0) {
                    const { [prop]: _, ...rest } = obj;
                    return { ...rest, enum: constVals };
                  }
                }
              }
              // Convert standalone const to enum
              if ('const' in obj) {
                const { const: val, ...rest } = obj;
                return { ...rest, enum: [val] };
              }
            }
            return value;
          })
        );
      }
      return result;
    } as typeof model.bindTools;
    return model;
  },
  xai: (name, opts) =>
    new ChatOpenAI({
      model: name,
      ...opts,
      apiKey: getApiKey('XAI_API_KEY'),
      configuration: {
        baseURL: 'https://api.x.ai/v1',
      },
    }),
  openrouter: (name, opts) =>
    new ChatOpenAI({
      model: name.replace(/^openrouter:/, ''),
      ...opts,
      apiKey: getApiKey('OPENROUTER_API_KEY'),
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
      },
    }),
  moonshot: (name, opts) =>
    new ChatOpenAI({
      model: name,
      ...opts,
      apiKey: getApiKey('MOONSHOT_API_KEY'),
      configuration: {
        baseURL: 'https://api.moonshot.cn/v1',
      },
    }),
  deepseek: (name, opts) =>
    new ChatOpenAI({
      model: name,
      ...opts,
      apiKey: getApiKey('DEEPSEEK_API_KEY'),
      configuration: {
        baseURL: 'https://api.deepseek.com',
      },
    }),
  ollama: (name, opts) =>
    new ChatOllama({
      model: name.replace(/^ollama:/, ''),
      ...opts,
      ...(process.env.OLLAMA_BASE_URL ? { baseUrl: process.env.OLLAMA_BASE_URL } : {}),
    }),
};

const DEFAULT_FACTORY: ModelFactory = (name, opts) =>
  new ChatOpenAI({
    model: name,
    ...opts,
    apiKey: getApiKey('OPENAI_API_KEY'),
  });

export function getChatModel(
  modelName: string = DEFAULT_MODEL,
  streaming: boolean = false
): BaseChatModel {
  const opts: ModelOpts = { streaming };
  const provider = resolveProvider(modelName);
  const factory = MODEL_FACTORIES[provider.id] ?? DEFAULT_FACTORY;
  return factory(modelName, opts);
}

/**
 * Recursively sanitize JSON Schema for Gemini API compatibility.
 * Zod v4 generates `oneOf: [{const: "a"}, {const: "b"}]` for enums/literals,
 * which Gemini's function calling API doesn't support.
 * This converts them to `{enum: ["a", "b"]}`.
 */
function sanitizeSchemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema;

  const result = { ...schema };

  // Convert oneOf with const values to enum
  if (Array.isArray(result.oneOf)) {
    const constValues = (result.oneOf as Record<string, unknown>[])
      .filter(item => item && typeof item === 'object' && 'const' in item)
      .map(item => item.const);
    if (constValues.length > 0 && constValues.length === (result.oneOf as unknown[]).length) {
      delete result.oneOf;
      result.enum = constValues;
      return result;
    }
  }

  // Convert anyOf with const values to enum
  if (Array.isArray(result.anyOf)) {
    const constValues = (result.anyOf as Record<string, unknown>[])
      .filter(item => item && typeof item === 'object' && 'const' in item)
      .map(item => item.const);
    if (constValues.length > 0 && constValues.length === (result.anyOf as unknown[]).length) {
      delete result.anyOf;
      result.enum = constValues;
      return result;
    }
  }

  // Remove standalone const (convert to enum with single value)
  if ('const' in result) {
    const val = result.const;
    delete result.const;
    result.enum = [val];
  }

  // Recurse into properties
  if (result.properties && typeof result.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result.properties as Record<string, unknown>)) {
      props[key] = typeof value === 'object' && value !== null
        ? sanitizeSchemaForGemini(value as Record<string, unknown>)
        : value;
    }
    result.properties = props;
  }

  // Recurse into items
  if (result.items && typeof result.items === 'object') {
    result.items = sanitizeSchemaForGemini(result.items as Record<string, unknown>);
  }

  // Recurse into oneOf/anyOf items (when not fully convertible to enum)
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as Record<string, unknown>[]).map(item =>
        typeof item === 'object' && item !== null
          ? sanitizeSchemaForGemini(item)
          : item
      );
    }
  }

  return result;
}

interface CallLlmOptions {
  model?: string;
  systemPrompt?: string;
  outputSchema?: z.ZodType<unknown>;
  tools?: StructuredToolInterface[];
  signal?: AbortSignal;
}

export interface LlmResult {
  response: AIMessage | string;
  usage?: TokenUsage;
}

function extractUsage(result: unknown): TokenUsage | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const msg = result as Record<string, unknown>;

  const usageMetadata = msg.usage_metadata;
  if (usageMetadata && typeof usageMetadata === 'object') {
    const u = usageMetadata as Record<string, unknown>;
    const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
    const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
    const total = typeof u.total_tokens === 'number' ? u.total_tokens : input + output;
    return { inputTokens: input, outputTokens: output, totalTokens: total };
  }

  const responseMetadata = msg.response_metadata;
  if (responseMetadata && typeof responseMetadata === 'object') {
    const rm = responseMetadata as Record<string, unknown>;
    if (rm.usage && typeof rm.usage === 'object') {
      const u = rm.usage as Record<string, unknown>;
      const input = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
      const output = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
      const total = typeof u.total_tokens === 'number' ? u.total_tokens : input + output;
      return { inputTokens: input, outputTokens: output, totalTokens: total };
    }
  }

  return undefined;
}

/**
 * Build messages with Anthropic cache_control on the system prompt.
 * Marks the system prompt as ephemeral so Anthropic caches the prefix,
 * reducing input token costs by ~90% on subsequent calls.
 */
function buildAnthropicMessages(systemPrompt: string, userPrompt: string) {
  return [
    new SystemMessage({
      content: [
        {
          type: 'text' as const,
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
    }),
    new HumanMessage(userPrompt),
  ];
}

export async function callLlm(prompt: string, options: CallLlmOptions = {}): Promise<LlmResult> {
  const { model = DEFAULT_MODEL, systemPrompt, outputSchema, tools, signal } = options;
  const finalSystemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;

  const llm = getChatModel(model, false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runnable: Runnable<any, any> = llm;

  if (outputSchema) {
    runnable = llm.withStructuredOutput(outputSchema, { strict: false });
  } else if (tools && tools.length > 0 && llm.bindTools) {
    runnable = llm.bindTools(tools);
  }

  const invokeOpts = signal ? { signal } : undefined;
  const provider = resolveProvider(model);
  let result;

  if (provider.id === 'anthropic') {
    // Anthropic: use explicit messages with cache_control for prompt caching (~90% savings)
    const messages = buildAnthropicMessages(finalSystemPrompt, prompt);
    result = await withRetry(() => runnable.invoke(messages, invokeOpts), provider.displayName);
  } else {
    // Other providers: use ChatPromptTemplate (OpenAI/Gemini have automatic caching)
    const promptTemplate = ChatPromptTemplate.fromMessages([
      ['system', finalSystemPrompt],
      ['user', '{prompt}'],
    ]);
    const chain = promptTemplate.pipe(runnable);
    result = await withRetry(() => chain.invoke({ prompt }, invokeOpts), provider.displayName);
  }
  const usage = extractUsage(result);

  // If no outputSchema and no tools, extract content from AIMessage
  // When tools are provided, return the full AIMessage to preserve tool_calls
  if (!outputSchema && !tools && result && typeof result === 'object' && 'content' in result) {
    return { response: (result as { content: string }).content, usage };
  }
  return { response: result as AIMessage, usage };
}

// ---------------------------------------------------------------------------
// Multi-turn message array API
// ---------------------------------------------------------------------------

/**
 * Annotate the first SystemMessage with Anthropic's cache_control for prompt
 * caching (~90% input token savings on repeated calls).
 */
function annotateSystemMessageForCaching(messages: BaseMessage[]): BaseMessage[] {
  if (messages.length === 0 || messages[0]._getType() !== 'system') {
    return messages;
  }

  const systemMsg = messages[0];
  const text = typeof systemMsg.content === 'string'
    ? systemMsg.content
    : JSON.stringify(systemMsg.content);

  const annotated = new SystemMessage({
    content: [
      {
        type: 'text' as const,
        text,
        cache_control: { type: 'ephemeral' },
      },
    ],
  });

  return [annotated, ...messages.slice(1)];
}

interface CallLlmWithMessagesOptions {
  model?: string;
  tools?: StructuredToolInterface[];
  signal?: AbortSignal;
}

/**
 * Call an LLM with a full message array (multi-turn tool-calling).
 *
 * Unlike callLlm() which takes a single prompt string, this function accepts
 * a BaseMessage[] array containing SystemMessage, HumanMessage, AIMessage,
 * and ToolMessage objects. This enables the agent loop where
 * conversation history (including model reasoning and tool results) persists
 * across iterations.
 *
 * All LangChain providers support BaseMessage[] via BaseChatModel.invoke().
 */
export async function callLlmWithMessages(
  messages: BaseMessage[],
  options: CallLlmWithMessagesOptions = {},
): Promise<LlmResult> {
  const { model = DEFAULT_MODEL, tools, signal } = options;

  const llm = getChatModel(model, false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runnable: Runnable<any, any> = llm;

  if (tools && tools.length > 0 && llm.bindTools) {
    runnable = llm.bindTools(tools);
  }

  const invokeOpts = signal ? { signal } : undefined;
  const provider = resolveProvider(model);

  // For Anthropic: annotate SystemMessage with cache_control for prompt caching
  const finalMessages = provider.id === 'anthropic'
    ? annotateSystemMessageForCaching(messages)
    : messages;

  const result = await withRetry(
    () => runnable.invoke(finalMessages, invokeOpts),
    provider.displayName,
  );

  const usage = extractUsage(result);
  return { response: result as AIMessage, usage };
}

// ---------------------------------------------------------------------------
// Streaming multi-turn API
// ---------------------------------------------------------------------------

/**
 * Stream an LLM response as AIMessageChunk objects.
 *
 * Uses LangChain's .stream() method. Chunks can be accumulated via .concat()
 * to progressively build complete tool_calls. Falls back to blocking invoke
 * if streaming is not supported by the provider.
 */
export async function* streamLlmWithMessages(
  messages: BaseMessage[],
  options: CallLlmWithMessagesOptions = {},
): AsyncGenerator<AIMessageChunk, void> {
  const { model = DEFAULT_MODEL, tools, signal } = options;

  const llm = getChatModel(model, true);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runnable: Runnable<any, any> = llm;

  if (tools && tools.length > 0 && llm.bindTools) {
    runnable = llm.bindTools(tools);
  }

  const invokeOpts = signal ? { signal } : undefined;
  const provider = resolveProvider(model);

  const finalMessages = provider.id === 'anthropic'
    ? annotateSystemMessageForCaching(messages)
    : messages;

  const stream = await runnable.stream(finalMessages, invokeOpts);

  for await (const chunk of stream) {
    yield chunk as AIMessageChunk;
  }
}
