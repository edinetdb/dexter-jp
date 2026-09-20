import { describe, expect, test } from 'bun:test';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getChatModel } from './llm.js';
import { resolveProvider } from '../providers.js';
import {
  ASTRA_MODEL_ID,
  normalizeAstraServiceTier,
  validateOpenAIRuntimeOptions,
} from './openai-runtime.js';

describe('OpenAI API routing', () => {
  test('uses the Responses API for the GPT-5.6 family', () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    try {
      for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
        const llm = getChatModel(model) as { useResponsesApi?: boolean };
        expect(llm.useResponsesApi).toBe(true);
      }
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
    }
  });

  test('routes Astra through OpenAI Responses', () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    try {
      expect(resolveProvider(ASTRA_MODEL_ID).id).toBe('openai');
      const llm = getChatModel(ASTRA_MODEL_ID) as {
        model?: string;
        useResponsesApi?: boolean;
      };
      expect(llm.model).toBe(ASTRA_MODEL_ID);
      expect(llm.useResponsesApi).toBe(true);
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }
  });

  test('maps Astra reasoning and Fast mode into Responses request fields', () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    try {
      const llm = getChatModel(ASTRA_MODEL_ID, false, {
        reasoningEffort: 'xhigh',
        serviceTier: 'fast',
        maxOutputTokens: 800,
      }) as {
        modelKwargs?: { reasoning?: { effort?: string } };
        service_tier?: string;
        maxTokens?: number;
      };
      expect(llm.modelKwargs).toEqual({ reasoning: { effort: 'xhigh' } });
      expect(llm.service_tier).toBe('priority');
      expect(llm.maxTokens).toBe(800);
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }
  });

  test('exposes Astra tool binding and Structured Outputs without a live call', () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    try {
      const llm = getChatModel(ASTRA_MODEL_ID);
      const fixtureTool = new DynamicStructuredTool({
        name: 'read_fixture',
        description: 'Read-only fixture.',
        schema: z.object({ id: z.string() }),
        func: async () => 'fixture',
      });
      expect(llm.bindTools?.([fixtureTool])).toBeDefined();
      expect(llm.withStructuredOutput(z.object({ answer: z.string() }))).toBeDefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }
  });

  test('validates Astra reasoning and unsupported sampling controls before a request', () => {
    expect(validateOpenAIRuntimeOptions(ASTRA_MODEL_ID, {
      reasoningEffort: 'max',
      serviceTier: 'default',
      maxOutputTokens: 800,
    })).toEqual({
      reasoningEffort: 'max',
      serviceTier: 'default',
      maxOutputTokens: 800,
    });

    expect(() => validateOpenAIRuntimeOptions(ASTRA_MODEL_ID, { reasoningEffort: 'none' }))
      .toThrow('Unsupported GPT-6 Astra reasoning effort');
    expect(() => validateOpenAIRuntimeOptions(ASTRA_MODEL_ID, { temperature: 0.2 }))
      .toThrow('does not accept Dexter sampling/logprob options');
    expect(() => validateOpenAIRuntimeOptions(ASTRA_MODEL_ID, { serviceTier: 'ultrafast' }))
      .toThrow('Unsupported GPT-6 Astra service tier');
    expect(normalizeAstraServiceTier('fast')).toBe('priority');
    expect(() => validateOpenAIRuntimeOptions('gpt-5.6-sol', { reasoningEffort: 'max' }))
      .toThrow('may only be used with gpt-6-astra');
  });
});
