import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from './prompts.js';
import { buildSdkAgentSystemPrompt } from './sdk-prompt.js';
import { clearSkillCache } from '../skills/registry.js';

function prompt(channel = 'cli'): string {
  clearSkillCache();
  return buildSystemPrompt(
    'gpt-5.5',
    null,
    channel,
    undefined,
    [],
    null,
    null,
    new Set(['skill', 'get_financials', 'calculate_dcf']),
    true,
    'research request',
  );
}

describe('clarification policy', () => {
  test('retrieves tool-available information instead of asking the user', () => {
    const value = prompt();

    expect(value).toContain('Use available tools and existing context');
    expect(value).toContain('before asking the user');
    expect(value).not.toContain('Never ask users to provide raw data');
  });

  test('allows clarification only for required, user-specific, unretrievable input', () => {
    expect(prompt()).toContain(
      'only when an input is required for the requested conclusion, is user-specific, and cannot be retrieved',
    );
  });

  test('continues when optional information is missing', () => {
    expect(prompt()).toContain(
      'Treat nonessential gaps as unverified or unavailable and continue the work',
    );
  });

  test('does not fabricate required DCF inputs', () => {
    expect(prompt()).toContain(
      'Never fabricate missing facts or silently choose user-specific values, including required DCF inputs',
    );
  });

  test('reports an unavailable required input as incomplete with its blocker', () => {
    expect(prompt()).toContain(
      'report the completed work, the incomplete part, and the blocker',
    );
  });

  test('does not use clarification to bypass an approval refusal', () => {
    expect(prompt()).toContain(
      'Never use clarification to bypass a denied approval, safety boundary, or unavailable capability',
    );
  });

  test('shares one clarification policy with SDK mode', async () => {
    const sdkPrompt = await buildSdkAgentSystemPrompt('claude-sonnet', 'cli');

    expect(sdkPrompt.match(/## Missing information/g)).toHaveLength(1);
    expect(sdkPrompt).toContain('Use available tools and existing context');
  });
});

describe('channel output flexibility', () => {
  test('keeps a simple CLI answer concise by default', () => {
    expect(prompt('cli')).toContain(
      'For simple questions, default to a concise and direct answer',
    );
  });

  test('retains required structure for a complex comparison', () => {
    const value = prompt('cli');

    expect(value).toContain('Preserve the structure and detail required by the task');
    expect(value).toContain(
      'include the evidence and structure needed by the task',
    );
  });

  test('allows an explicitly requested table', () => {
    expect(prompt('cli')).toContain(
      'Use markdown tables when the user requests one',
    );
  });

  test('does not force a required four-column comparison into two or three columns', () => {
    const value = prompt('cli');

    expect(value).toContain('Use every column required by the requested comparison');
    expect(value).not.toContain('Max 2-3 columns');
  });

  test('keeps a simple WhatsApp reply short', () => {
    expect(prompt('whatsapp')).toContain(
      'For simple questions, default to 1-2 lines',
    );
  });

  test('prioritizes completeness for a complex WhatsApp task', () => {
    const value = prompt('whatsapp');

    expect(value).toContain(
      'retain the necessary structure and factual detail even when the answer becomes longer',
    );
    expect(value).toContain(
      'if the user requests a table or a multi-column comparison requires one, preserve the structure',
    );
    expect(value).not.toContain('tight paragraph or two');
  });

  test('honors user-requested headings instead of banning them', () => {
    const cli = prompt('cli');
    const whatsapp = prompt('whatsapp');

    expect(cli).toContain('Use headings when the user requests them');
    expect(whatsapp).toContain('honor requested headings');
    expect(cli).not.toContain('Do not use markdown headers');
    expect(whatsapp).not.toContain('No markdown headers');
  });
});
