import { describe, expect, test } from 'bun:test';
import {
  buildDexterSdkTools,
  buildDexterMcpServer,
  dexterAllowedToolNames,
  DEXTER_MCP_SERVER_NAME,
} from './sdk-tool-adapter.js';

/** The raw (no-internal-LLM) tools that must always be present in SDK mode. */
const CORE_TOOL_NAMES = [
  'get_key_ratios',
  'get_analysis',
  'get_financial_statements',
  'get_company_info',
  'get_earnings',
  'get_shareholders',
  'get_text_blocks',
  'read_filings',
  'screen_companies',
];

/** Meta-tools that route via an internal LLM — must NOT be exposed raw. */
const EXCLUDED_TOOL_NAMES = ['get_financials', 'company_screener', 'web_fetch', 'browser', 'spawn_subagent', 'skill'];

describe('buildDexterSdkTools', () => {
  const tools = buildDexterSdkTools();
  const names = tools.map((t) => (t as { name?: string }).name ?? '');

  test('exposes all core raw finance tools', () => {
    for (const name of CORE_TOOL_NAMES) {
      expect(names).toContain(name);
    }
  });

  test('does not expose internal-LLM meta-tools or SDK-builtin overlaps', () => {
    for (const name of EXCLUDED_TOOL_NAMES) {
      expect(names).not.toContain(name);
    }
  });

  test('every tool carries a non-empty description and an object input schema', () => {
    for (const t of tools) {
      const def = t as { name?: string; description?: string; inputSchema?: unknown };
      expect(typeof def.name).toBe('string');
      expect(def.name && def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe('string');
      expect(def.description && def.description.length).toBeGreaterThan(0);
      // Raw zod shape object (name → ZodType). Must be a plain object, not undefined.
      expect(def.inputSchema).toBeDefined();
      expect(typeof def.inputSchema).toBe('object');
    }
  });

  test('tool names are unique', () => {
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('buildDexterMcpServer', () => {
  test('builds an in-process (sdk) server named "dexter" holding the raw tools', () => {
    const { server, toolNames } = buildDexterMcpServer();
    const s = server as { type?: string; name?: string; instance?: unknown };
    expect(s.type).toBe('sdk');
    expect(s.name).toBe(DEXTER_MCP_SERVER_NAME);
    expect(s.instance).toBeDefined();
    for (const name of CORE_TOOL_NAMES) {
      expect(toolNames).toContain(name);
    }
  });
});

describe('dexterAllowedToolNames', () => {
  test('produces the wildcard plus fully-qualified names', () => {
    const allowed = dexterAllowedToolNames([{ name: 'get_key_ratios' }, { name: 'read_filings' }]);
    expect(allowed).toContain(`mcp__${DEXTER_MCP_SERVER_NAME}__*`);
    expect(allowed).toContain(`mcp__${DEXTER_MCP_SERVER_NAME}__get_key_ratios`);
    expect(allowed).toContain(`mcp__${DEXTER_MCP_SERVER_NAME}__read_filings`);
  });
});
