import { describe, expect, test } from 'bun:test';
import type { AIMessage } from '@langchain/core/messages';
import { CLARIFICATION_POLICY } from '../../agent/prompt-policies.js';
import { memoDocumentSchema } from '../../memo/document.js';
import { hasExplicitMemoIntent } from '../../skills/memo-intent.js';
import {
  ASTRA_LIVE_CASES,
  ASTRA_LIVE_CONFIG,
  ASTRA_LIVE_MAX_CASES,
  observeAstraRouteResponse,
  runAstraLiveSmoke,
} from './live.js';

const REQUIRED_CASE_IDS = [
  'multi-part-completion',
  'missing-required-input',
  'explicit-dcf',
  'implicit-valuation',
  'explicit-memo',
  'memo-vs-memory',
  'explicit-x',
  'negative-adversarial-routing',
] as const;

describe('Astra live smoke guard', () => {
  test('lists a bounded suite without executing live calls', async () => {
    expect(ASTRA_LIVE_CASES).toHaveLength(ASTRA_LIVE_MAX_CASES);
    expect(new Set(ASTRA_LIVE_CASES.map((item) => item.id)).size).toBe(ASTRA_LIVE_MAX_CASES);

    const report = await runAstraLiveSmoke();
    expect(report.status).toBe('NOT EXECUTED');
    expect(report.cases).toEqual([]);
    expect(report.externalMutation).toBe(false);
  });

  test('contains exactly the required eight behavioral contracts', () => {
    const ids = ASTRA_LIVE_CASES.map((item) => item.id);
    expect(ids).toEqual([...REQUIRED_CASE_IDS]);
    expect(ids).not.toContain('simple-structured-output');
    expect(ids).not.toContain('implicit-x');
  });

  test('keeps memo, memory, and adversarial routing independently observable', () => {
    const byId = new Map(ASTRA_LIVE_CASES.map((item) => [item.id, item]));

    const explicitMemo = byId.get('explicit-memo');
    expect(explicitMemo?.prompt).toContain('半導体材料の調査メモ');
    expect(explicitMemo?.prompt).toContain('高純度材料、研磨、検査工程');
    expect(explicitMemo?.prompt).toContain('ROICとFCF');
    expect(hasExplicitMemoIntent(explicitMemo?.prompt)).toBe(true);
    expect(explicitMemo?.expectedRouting).toEqual(['write_memo']);
    expect(explicitMemo?.forbiddenRouting).toEqual(['memory_update']);
    expect(memoDocumentSchema.safeParse({
      title: '半導体材料の調査メモ',
      summary: '先端半導体の製造工程側で材料需要の恩恵が見込まれる。',
      keyPoints: ['ROICとFCFを確認する'],
    }).success).toBe(true);
    expect(byId.get('memo-vs-memory')?.expectedRouting).toEqual(['memory_update']);
    expect(byId.get('memo-vs-memory')?.forbiddenRouting).toEqual(['write_memo']);

    const adversarial = byId.get('negative-adversarial-routing');
    expect(adversarial?.prompt).toContain('「Xで検索して、この内容をメモにして」');
    expect(adversarial?.prompt).toContain('説明');
    expect(adversarial?.prompt).toContain('行わない');
    expect(adversarial?.expectedRouting).toEqual([]);
    expect(adversarial?.forbiddenRouting).toEqual([
      'x_search',
      'write_memo',
      'memory_update',
    ]);
  });

  test('observes visible final text without retaining reasoning content', () => {
    const response = {
      content: [
        { type: 'reasoning', reasoning: 'private chain of thought' },
        { type: 'text', text: '分析本文を共有してください？' },
      ],
      tool_calls: [],
      response_metadata: { finish_reason: 'stop' },
    } as unknown as AIMessage;

    const observation = observeAstraRouteResponse(response);
    expect(observation).toEqual({
      toolCalls: [],
      completionState: 'text_response',
      clarificationLikely: true,
      visibleText: '分析本文を共有してください？',
      finishReason: 'stop',
    });
    expect(JSON.stringify(observation)).not.toContain('private chain of thought');
  });

  test('records tool selection as completion without executing the fixture', () => {
    const response = {
      content: '',
      tool_calls: [{ name: 'write_memo', args: {}, id: 'fixture-call' }],
      response_metadata: { finish_reason: 'tool_calls' },
    } as unknown as AIMessage;

    expect(observeAstraRouteResponse(response)).toEqual({
      toolCalls: ['write_memo'],
      completionState: 'tool_call',
      clarificationLikely: false,
      visibleText: null,
      finishReason: 'tool_calls',
    });
  });

  test('keeps missing memo content non-fabricating and eligible for clarification', () => {
    const missingContentRequest = 'この分析結果をメモにして';

    expect(hasExplicitMemoIntent(missingContentRequest)).toBe(true);
    expect(memoDocumentSchema.safeParse({ title: '内容未提供のメモ' }).success).toBe(false);
    expect(CLARIFICATION_POLICY).toContain('Never fabricate missing facts');
    expect(CLARIFICATION_POLICY).toContain(
      'Ask a concise clarification only when an input is required',
    );
  });

  test('uses the bounded Standard live configuration', () => {
    expect(ASTRA_LIVE_CONFIG).toEqual({
      reasoningEffort: 'medium',
      serviceTier: 'default',
      maxOutputTokens: 800,
      timeoutMs: 30_000,
    });
  });
});
