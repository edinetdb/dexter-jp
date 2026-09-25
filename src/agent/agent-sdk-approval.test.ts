import { describe, expect, test } from 'bun:test';
import {
  AgentSdkAgent,
  ASK_USER_QUESTION_TOOL,
} from './agent-sdk-agent.js';
import { DEXTER_MCP_SERVER_NAME } from './sdk-tool-adapter.js';

interface TestableSdkAgent {
  allowedTools(): string[];
  canUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ behavior: string; updatedInput?: Record<string, unknown>; message?: string }>;
}

describe('AgentSdkAgent operation approval boundary', () => {
  test('does not place Dexter MCP tools on the SDK approval allowlist', async () => {
    const agent = await AgentSdkAgent.create({ model: 'test-model' });
    const testable = agent as unknown as TestableSdkAgent;

    expect(testable.allowedTools()).toEqual([ASK_USER_QUESTION_TOOL]);
    expect(testable.allowedTools().some((name) => name.endsWith('__*'))).toBe(false);
  });

  test('allows classified read-only MCP operations through the shared gate', async () => {
    const agent = await AgentSdkAgent.create({ model: 'test-model' });
    const testable = agent as unknown as TestableSdkAgent;
    const result = await testable.canUseTool(
      'mcp__' + DEXTER_MCP_SERVER_NAME + '__get_key_ratios',
      { ticker: '7203' },
    );

    expect(result.behavior).toBe('allow');
    expect(result.updatedInput).toEqual({ ticker: '7203' });
  });

  test('normalizes explicit memo writes before requesting exact approval', async () => {
    let approvedKind = '';
    const agent = await AgentSdkAgent.create({
      model: 'test-model',
      userQuery: 'これをメモにして',
      requestToolApproval: async (request) => {
        approvedKind = request.operation.kind;
        return 'allow-once';
      },
    });
    const testable = agent as unknown as TestableSdkAgent;
    const result = await testable.canUseTool(
      'mcp__' + DEXTER_MCP_SERVER_NAME + '__write_memo',
      { document: { title: 'SDKメモ', summary: '確定内容' } },
    );

    expect(result.behavior).toBe('allow');
    expect(approvedKind).toBe('memo.create');
    expect(result.updatedInput?.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.updatedInput).not.toHaveProperty('path');
  });

  test('fails closed for an unknown SDK mutation without an approval bridge', async () => {
    const agent = await AgentSdkAgent.create({ model: 'test-model' });
    const testable = agent as unknown as TestableSdkAgent;
    const result = await testable.canUseTool(
      'mcp__' + DEXTER_MCP_SERVER_NAME + '__future_mutator',
      { action: 'delete', target: 'remote' },
    );

    expect(result.behavior).toBe('deny');
    expect(result.message).toContain('not approved');
  });
});
