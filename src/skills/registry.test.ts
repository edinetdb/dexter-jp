import { describe, expect, test } from 'bun:test';
import type { SkillMetadata } from './types.js';
import { parseSkillFile } from './loader.js';
import {
  buildSkillMetadataSection,
  clearSkillCache,
  discoverSkills,
  getSkill,
  isSkillDiscoverable,
} from './registry.js';

function metadata(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    name: 'example',
    description: 'Example Skill',
    path: '/skills/example/SKILL.md',
    source: 'builtin',
    ...overrides,
  };
}

describe('skill metadata parsing', () => {
  test('keeps a legacy skill without status or requirements discoverable', () => {
    const skill = parseSkillFile(
      '---\nname: example\ndescription: Example Skill\n---\n\nInstructions',
      '/skills/example/SKILL.md',
      'builtin',
    );

    expect(skill.status).toBeUndefined();
    expect(skill.requires).toBeUndefined();
    expect(isSkillDiscoverable(skill)).toBe(true);
  });

  test('parses supported status and tool requirements', () => {
    const skill = parseSkillFile(
      '---\nname: example\ndescription: Example Skill\nstatus: stable\nrequires:\n  tools:\n    - x_search\n---\n',
      '/skills/example/SKILL.md',
      'builtin',
    );

    expect(skill.status).toBe('stable');
    expect(skill.requires?.tools).toEqual(['x_search']);
  });

  test('parses the explicit memo activation boundary', () => {
    const skill = parseSkillFile(
      '---\nname: memo\ndescription: Memo\nactivation: explicit_memo\n---\n',
      '/skills/memo/SKILL.md',
      'builtin',
    );

    expect(skill.activation).toBe('explicit_memo');
  });

  test('ignores unknown optional metadata', () => {
    const skill = parseSkillFile(
      '---\nname: example\ndescription: Example Skill\nfuture_option: true\n---\n',
      '/skills/example/SKILL.md',
      'builtin',
    );

    expect(isSkillDiscoverable(skill)).toBe(true);
  });

  test('rejects malformed requires.tools metadata', () => {
    expect(() => parseSkillFile(
      '---\nname: example\ndescription: Example Skill\nrequires:\n  tools: x_search\n---\n',
      '/skills/example/SKILL.md',
      'builtin',
    )).toThrow("invalid 'requires.tools'");
  });
});

describe('skill discovery eligibility', () => {
  test('discovers stable and experimental skills', () => {
    expect(isSkillDiscoverable(metadata({ status: 'stable' }))).toBe(true);
    expect(isSkillDiscoverable(metadata({ status: 'experimental' }))).toBe(true);
  });

  test('does not discover a disabled skill', () => {
    expect(isSkillDiscoverable(metadata({ status: 'disabled' }))).toBe(false);
  });

  test('discovers a required-tool skill only when every tool is present', () => {
    const skill = metadata({ requires: { tools: ['tool_a', 'tool_b'] } });

    expect(isSkillDiscoverable(skill, { availableTools: new Set(['tool_a']) })).toBe(false);
    expect(isSkillDiscoverable(skill, { availableTools: new Set(['tool_a', 'tool_b']) })).toBe(true);
  });

  test('requires explicit memo intent for an intent-gated skill', () => {
    const skill = metadata({ activation: 'explicit_memo' });

    expect(isSkillDiscoverable(skill, { userQuery: '覚えておいて' })).toBe(false);
    expect(isSkillDiscoverable(skill, { userQuery: 'これをメモにして' })).toBe(true);
  });

  test('cannot bypass write-memo activation by overriding its metadata', () => {
    const overridden = metadata({ name: 'write-memo', activation: undefined });

    expect(isSkillDiscoverable(overridden, { userQuery: '要約して' })).toBe(false);
    expect(isSkillDiscoverable(overridden, { userQuery: 'Save this as a memo' })).toBe(true);
  });

  test('treats an empty tool requirement like no requirement', () => {
    expect(isSkillDiscoverable(metadata({ requires: { tools: [] } }))).toBe(true);
  });

  test('keeps a disabled skill hidden even when its required tool is present', () => {
    const skill = metadata({ status: 'disabled', requires: { tools: ['x_search'] } });
    expect(isSkillDiscoverable(skill, { availableTools: new Set(['x_search']) })).toBe(false);
  });
});

describe('built-in skill discovery', () => {
  test('filters built-in skills by their actual required tools', () => {
    clearSkillCache();

    const withoutCapabilities = discoverSkills({ availableTools: new Set() });
    expect(withoutCapabilities.map((skill) => skill.name)).not.toContain('dcf-valuation');
    expect(withoutCapabilities.map((skill) => skill.name)).not.toContain('x-research');
    expect(withoutCapabilities.map((skill) => skill.name)).not.toContain('write-memo');

    const withCalculator = discoverSkills({ availableTools: new Set(['calculate_dcf']) });
    expect(withCalculator.map((skill) => skill.name)).toContain('dcf-valuation');
    expect(withCalculator.map((skill) => skill.name)).not.toContain('x-research');
    expect(buildSkillMetadataSection({ availableTools: new Set(['calculate_dcf']) })).toContain('dcf-valuation');
    expect(getSkill('dcf-valuation', { availableTools: new Set(['calculate_dcf']) })).toBeDefined();

    const withX = discoverSkills({ availableTools: new Set(['x_search']) });
    expect(withX.map((skill) => skill.name)).not.toContain('dcf-valuation');
    expect(withX.map((skill) => skill.name)).toContain('x-research');
    expect(getSkill('x-research', { availableTools: new Set(['x_search']) })).toBeDefined();

    const withBoth = discoverSkills({ availableTools: new Set(['calculate_dcf', 'x_search']) });
    expect(withBoth.map((skill) => skill.name)).toContain('dcf-valuation');
    expect(withBoth.map((skill) => skill.name)).toContain('x-research');
    expect(withBoth.map((skill) => skill.name)).not.toContain('write-memo');
    expect(getSkill('write-memo', { availableTools: new Set(['calculate_dcf', 'x_search']) })).toBeUndefined();

    const memoTools = new Set(['write_memo']);
    expect(discoverSkills({ availableTools: memoTools }).map((skill) => skill.name))
      .not.toContain('write-memo');
    expect(discoverSkills({
      availableTools: memoTools,
      userQuery: 'これをメモにして',
    }).map((skill) => skill.name)).toContain('write-memo');
    expect(getSkill('write-memo', {
      availableTools: memoTools,
      userQuery: 'Save this as a memo',
    })).toBeDefined();
  });
});
