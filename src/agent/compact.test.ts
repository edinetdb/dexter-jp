import { describe, expect, test } from 'bun:test';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  buildCompactSummaryMessage,
  buildCompactionSource,
  buildCompactionPrompt,
  compactionSummarySchema,
  parseCompactionSummaryPayload,
} from './compact.js';

describe('compaction privacy boundary', () => {
  test('preserves the required conversation context', () => {
    const prompt = buildCompactionPrompt(
      'User message:\nCompare Company A and Company B\n\n' +
      'Tool evidence:\nCompany A revenue: 100. Company B revenue: 80. Pending: verify margins.',
    );

    expect(prompt).toContain('Compare Company A and Company B');
    expect(prompt).toContain('Company A revenue: 100');
    expect(prompt).toContain('Pending work and concrete next steps');

    const message = buildCompactSummaryMessage(
      'Evidence: Company A revenue is 100. Pending: verify both operating margins.',
    );
    expect(message).toContain('Company A revenue is 100');
    expect(message).toContain('verify both operating margins');
    expect(message).toContain('Continue working toward the original query');
  });

  test('excludes system prompt content and tool-call reasoning structurally', () => {
    const source = buildCompactionSource(
      [
        new SystemMessage('durable memory and private system instructions'),
        new HumanMessage('current user request'),
        new AIMessage({
          content: 'private intermediate reasoning',
          tool_calls: [{ id: 'call-1', name: 'web_search', args: { query: 'x' } }],
        }),
        new AIMessage('prior final conclusion'),
      ],
      '### web_search(query=x)\nverified tool evidence',
    );

    expect(source).toContain('current user request');
    expect(source).toContain('prior final conclusion');
    expect(source).toContain('verified tool evidence');
    expect(source).not.toContain('durable memory and private system instructions');
    expect(source).not.toContain('private intermediate reasoning');
  });

  test('accepts only the summary field and never requests an analysis block', () => {
    expect(parseCompactionSummaryPayload({ summary: 'Final evidence and pending work.' }))
      .toBe('Final evidence and pending work.');
    expect(compactionSummarySchema.safeParse({
      summary: 'Safe continuation context.',
      analysis: 'private chain of thought',
    }).success).toBe(false);

    const prompt = buildCompactionPrompt('User message:\\nquery\\n\\nTool evidence:\\ntool output');
    expect(prompt).not.toContain('<analysis>');
    expect(prompt).not.toContain('<summary>');
    expect(prompt).toContain('Do not include private chain-of-thought');
  });
});