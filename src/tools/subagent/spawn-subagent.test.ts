import { describe, expect, test } from 'bun:test';
import { resolveSubagentModel } from './spawn-subagent.js';

describe('subagent model policy', () => {
  test('keeps existing model inheritance and uses Luna for Astra workers', () => {
    expect(resolveSubagentModel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(resolveSubagentModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(resolveSubagentModel('gpt-6-astra')).toBe('gpt-5.6-luna');
  });
});
