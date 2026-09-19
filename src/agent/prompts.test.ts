import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSystemPrompt } from './prompts.js';
import { buildSdkAgentSystemPrompt } from './sdk-prompt.js';
import { clearSkillCache } from '../skills/registry.js';

function buildPrompt({
  tools = new Set(['skill', 'calculate_dcf']),
  memoryContext = null,
  rulesContent = null,
  memoryEnabled = true,
  userQuery,
}: {
  tools?: ReadonlySet<string>;
  memoryContext?: string | null;
  rulesContent?: string | null;
  memoryEnabled?: boolean;
  userQuery?: string;
} = {}): string {
  clearSkillCache();
  return buildSystemPrompt(
    'gpt-5.5',
    null,
    'cli',
    undefined,
    [],
    memoryContext,
    rulesContent,
    tools,
    memoryEnabled,
    userQuery,
  );
}

describe('main system prompt boundaries', () => {
  test('preserves capability-filtered Skill discovery', () => {
    const withoutX = buildPrompt();
    expect(withoutX).toContain('**dcf-valuation**');
    expect(withoutX).not.toContain('write-memo');
    expect(withoutX).not.toContain('**x-research**');

    const withX = buildPrompt({ tools: new Set(['skill', 'calculate_dcf', 'x_search']) });
    expect(withX).toContain('**dcf-valuation**');
    expect(withX).toContain('**x-research**');
    expect(withX).not.toContain('write-memo');
  });

  test('shows write-memo only for an explicit memo turn with its required tool', () => {
    const tools = new Set(['skill', 'write_memo']);

    expect(buildPrompt({ tools, userQuery: '覚えておいて' })).not.toContain('**write-memo**');
    expect(buildPrompt({ tools, userQuery: 'Markdownにして' })).not.toContain('**write-memo**');
    expect(buildPrompt({ tools, userQuery: 'これをメモにして' })).toContain('**write-memo**');
  });

  test('does not duplicate the bound tool inventory', () => {
    const prompt = buildPrompt({ tools: new Set(['skill', 'get_financials', 'read_filings']) });
    expect(prompt).not.toContain('## Available Tools');
    expect(prompt).not.toContain('Japanese company financials, metrics, earnings');
  });

  test('retains data-integrity requirements', () => {
    const prompt = buildPrompt();
    expect(prompt).toContain('must come from tool evidence');
    expect(prompt).toContain('Verify listing status');
    expect(prompt).toContain('do not present it as active');
  });

  test('multi-part task contract requires every deliverable and validation', () => {
    const prompt = buildPrompt();

    expect(prompt).toContain('Complete every requested deliverable and required validation');
    expect(prompt).toContain('do not stop after a partial result');
    expect(prompt.match(/## Completion/g)).toHaveLength(1);
  });

  test('blocked task reports completed, incomplete, and blocker separately', () => {
    const prompt = buildPrompt();

    expect(prompt).toContain('distinguish completed work, incomplete work, and the blocker');
  });

  test('completion contract does not override approval refusal or safety budgets', () => {
    const prompt = buildPrompt();

    expect(prompt).toContain('Never bypass a denied approval');
    expect(prompt).toContain('a safety boundary, or a runtime/tool budget');
  });

  test('omits memory instructions when memory is irrelevant', () => {
    expect(buildPrompt()).not.toContain('## Memory');
    expect(buildPrompt({ tools: new Set(['skill', 'memory_search']), memoryEnabled: false }))
      .not.toContain('## Memory');
  });

  test('includes only memory behavior supported by the runtime', () => {
    const withTools = buildPrompt({
      tools: new Set(['skill', 'memory_search', 'memory_get', 'memory_update']),
    });
    expect(withTools).toContain('## Memory');
    expect(withTools).toContain('Use memory_search before personalized financial advice');
    expect(withTools).toContain('Use memory_get when exact stored text is needed');
    expect(withTools).toContain('Use memory_update—not file tools');

    const contextOnly = buildPrompt({ memoryContext: 'Risk tolerance: conservative.' });
    expect(contextOnly).toContain('Risk tolerance: conservative.');
    expect(contextOnly).not.toContain('Use memory_search');
  });

  test('does not inject ordinary heartbeat boilerplate', () => {
    const prompt = buildPrompt({ tools: new Set(['skill', 'heartbeat']) });
    expect(prompt).not.toContain('## Heartbeat');
    expect(prompt).not.toContain('what\'s my heartbeat doing?');
  });

  test('preserves non-empty project rules without management boilerplate', () => {
    expect(buildPrompt({ rulesContent: '  Verify primary sources.  ' }))
      .toContain('## Research Rules\n\nVerify primary sources.');
    expect(buildPrompt({ rulesContent: '   \n' })).not.toContain('## Research Rules');
    expect(buildPrompt({ rulesContent: 'Verify primary sources.' }))
      .not.toContain('Rules are stored in .dexter/RULES.md');
  });
});

describe('SDK prompt boundaries', () => {
  test('relies on bound MCP schemas instead of repeating the tool inventory', async () => {
    const prompt = await buildSdkAgentSystemPrompt('claude-sonnet', 'cli');
    expect(prompt).not.toContain('## Available data tools');
    expect(prompt).not.toContain('**get_key_ratios**');
    expect(prompt).toContain('**Identifier integrity**');
    expect(prompt).toContain('**Listing status**');
    expect(prompt).toContain('Complete every requested deliverable');
    expect(prompt.match(/## Completion/g)).toHaveLength(1);
  });

  test('uses the same explicit write-memo discovery boundary in SDK mode', async () => {
    const tools = new Set(['skill', 'write_memo']);
    const hidden = await buildSdkAgentSystemPrompt(
      'claude-sonnet',
      'cli',
      tools,
      'remember this',
    );
    const visible = await buildSdkAgentSystemPrompt(
      'claude-sonnet',
      'cli',
      tools,
      'Write this as a memo',
    );

    expect(hidden).not.toContain('**write-memo**');
    expect(visible).toContain('**write-memo**');
  });
});

describe('repository instruction safety boundaries', () => {
  test('keeps credential and external-release authorization explicit', () => {
    const instructions = readFileSync(join(import.meta.dir, '../../AGENTS.md'), 'utf8');
    expect(instructions).toContain('API keys');
    expect(instructions).toContain('Cookies');
    expect(instructions).toContain('Authorization headers');
    expect(instructions).toContain('OTPs');
    expect(instructions).toContain('payment/card data');
    expect(instructions).toContain('without explicit user authorization');
    expect(instructions).toContain('live or paid APIs or evaluations');
  });
});
