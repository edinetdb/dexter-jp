import { describe, expect, test } from 'bun:test';
import { getToolRegistry } from './registry.js';

describe('tool registry', () => {
  test('registers calculate_dcf as an actual runtime tool', () => {
    const tools = getToolRegistry('test-model');

    expect(tools.some((tool) => tool.name === 'calculate_dcf')).toBe(true);
  });

  test('registers write_memo only for explicit memo intent', () => {
    expect(getToolRegistry('test-model').some((tool) => tool.name === 'write_memo')).toBe(false);
    expect(getToolRegistry('test-model', { userQuery: '覚えておいて' })
      .some((tool) => tool.name === 'write_memo')).toBe(false);
    expect(getToolRegistry('test-model', { userQuery: 'これをメモにして' })
      .some((tool) => tool.name === 'write_memo')).toBe(true);
  });
});
