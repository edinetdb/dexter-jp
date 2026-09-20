export const ASTRA_MODEL_ID = 'gpt-6-astra' as const;

export const ASTRA_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export const ASTRA_SERVICE_TIERS = [
  'auto',
  'default',
  'flex',
  'fast',
  'priority',
] as const;

export type AstraReasoningEffort = typeof ASTRA_REASONING_EFFORTS[number];
export type AstraServiceTier = typeof ASTRA_SERVICE_TIERS[number];

/**
 * Optional OpenAI request controls used by explicit runtime callers such as
 * the opt-in live smoke harness. Product defaults leave these unset.
 */
export interface OpenAIRuntimeOptions {
  reasoningEffort?: string;
  serviceTier?: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topLogprobs?: number;
  logprobs?: boolean;
  include?: string[];
}

export interface ValidatedOpenAIRuntimeOptions {
  reasoningEffort?: AstraReasoningEffort;
  serviceTier?: AstraServiceTier;
  maxOutputTokens?: number;
}

function includes<T extends string>(values: readonly T[], value: string): value is T {
  return values.includes(value as T);
}

/** GPT-5.6 and Astra require Responses for Dexter's function-tool path. */
export function usesOpenAIResponsesApi(model: string): boolean {
  return model.startsWith('gpt-5.6-') || model === ASTRA_MODEL_ID;
}

/** LangChain uses the legacy API alias priority for Fast mode. */
export function normalizeAstraServiceTier(
  serviceTier: AstraServiceTier | undefined,
): Exclude<AstraServiceTier, 'fast'> | undefined {
  return serviceTier === 'fast' ? 'priority' : serviceTier;
}

/**
 * Fail before a paid request when an Astra-only runtime option is invalid.
 * Dexter does not expose sampling controls for Astra and never silently maps
 * an unsupported value to another effort or service tier.
 */
export function validateOpenAIRuntimeOptions(
  model: string,
  options: OpenAIRuntimeOptions = {},
): ValidatedOpenAIRuntimeOptions {
  if (
    options.maxOutputTokens !== undefined
    && (!Number.isInteger(options.maxOutputTokens)
      || options.maxOutputTokens < 1
      || options.maxOutputTokens > 128_000)
  ) {
    throw new Error('OpenAI maxOutputTokens must be an integer between 1 and 128000.');
  }

  if (model !== ASTRA_MODEL_ID) {
    if (
      options.reasoningEffort !== undefined
      || options.serviceTier !== undefined
      || options.temperature !== undefined
      || options.topP !== undefined
      || options.topLogprobs !== undefined
      || options.logprobs !== undefined
      || options.include !== undefined
    ) {
      throw new Error('Astra runtime overrides may only be used with gpt-6-astra.');
    }
    return {
      ...(options.maxOutputTokens !== undefined
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
    };
  }

  if (
    options.temperature !== undefined
    || options.topP !== undefined
    || options.topLogprobs !== undefined
    || options.logprobs !== undefined
    || options.include?.includes('message.output_text.logprobs')
  ) {
    throw new Error(
      'GPT-6 Astra does not accept Dexter sampling/logprob options. Remove temperature, topP, topLogprobs, logprobs, and message.output_text.logprobs.',
    );
  }

  if (
    options.reasoningEffort !== undefined
    && !includes(ASTRA_REASONING_EFFORTS, options.reasoningEffort)
  ) {
    throw new Error(
      'Unsupported GPT-6 Astra reasoning effort: ' + options.reasoningEffort
      + '. Expected one of: ' + ASTRA_REASONING_EFFORTS.join(', ') + '.',
    );
  }

  if (
    options.serviceTier !== undefined
    && !includes(ASTRA_SERVICE_TIERS, options.serviceTier)
  ) {
    throw new Error(
      'Unsupported GPT-6 Astra service tier: ' + options.serviceTier
      + '. Expected one of: ' + ASTRA_SERVICE_TIERS.join(', ') + '.',
    );
  }

  return {
    ...(options.reasoningEffort !== undefined
      ? { reasoningEffort: options.reasoningEffort }
      : {}),
    ...(options.serviceTier !== undefined
      ? { serviceTier: options.serviceTier }
      : {}),
    ...(options.maxOutputTokens !== undefined
      ? { maxOutputTokens: options.maxOutputTokens }
      : {}),
  };
}
