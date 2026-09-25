import { isKnownToolOperation, OperationApprovalGate } from '../approval/operation-policy.js';
import { describe, expect, test } from 'bun:test';
import {
  buildDexterSdkTools,
  buildDexterMcpServer,
  dexterMcpToolNames,
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
  'calculate_dcf',
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

  test('exposes write_memo and Skill only for explicit memo intent', () => {
    const ordinaryNames = buildDexterSdkTools(undefined, { userQuery: '覚えておいて' })
      .map((tool) => (tool as { name?: string }).name ?? '');
    const memoNames = buildDexterSdkTools(undefined, { userQuery: 'これをメモにして' })
      .map((tool) => (tool as { name?: string }).name ?? '');

    expect(ordinaryNames).not.toContain('write_memo');
    expect(ordinaryNames).not.toContain('skill');
    expect(memoNames).toContain('write_memo');
    expect(memoNames).toContain('skill');
    expect(memoNames.filter((name) => !isKnownToolOperation(name))).toEqual([]);
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

  test('every SDK tool has a deterministic operation classification', () => {
    expect(names.filter((name) => !isKnownToolOperation(name))).toEqual([]);
  });
  test('the MCP handler executes the exact operation claimed by the shared gate', async () => {
    const gate = new OperationApprovalGate();
    const guarded = buildDexterSdkTools(
      (toolName, args) =>
        gate.claim(toolName, args).arguments as Record<string, unknown>,
    );
    const dcf = guarded.find((item) =>
      (item as { name?: string }).name === 'calculate_dcf'
    ) as unknown as {
      handler(args: Record<string, unknown>): Promise<{
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      }>;
    };
    const args = {
      forecastFreeCashFlows: [
        { period: 'FY2027', value: 100 },
        { period: 'FY2028', value: 110 },
      ],
      wacc: 0.1,
      terminalGrowthRate: 0.02,
      netDebt: 50,
      dilutedSharesOutstanding: 10000000,
      unit: 'JPY_million',
    };
    const authorization = await gate.authorize('calculate_dcf', args);
    const result = await dcf.handler(
      authorization.operation.arguments as Record<string, unknown>,
    );

    expect(authorization.allowed).toBe(true);
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('intrinsicValuePerShare');
  });
  test('the MCP handler fails closed when the exact execution claim is missing', async () => {
    const guarded = buildDexterSdkTools(() => {
      throw new Error('exact operation claim missing');
    });
    const first = guarded[0] as unknown as {
      handler(args: Record<string, unknown>): Promise<{
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      }>;
    };

    const result = await first.handler({ ticker: '7203' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('exact operation claim missing');
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

  test('scopes the memo MCP tools to an explicit memo turn', () => {
    const hidden = buildDexterMcpServer({ userQuery: '要約して' }).toolNames;
    const visible = buildDexterMcpServer({ userQuery: 'Save this as a memo' }).toolNames;

    expect(hidden).not.toContain('write_memo');
    expect(visible).toContain('write_memo');
    expect(visible).toContain('skill');
  });
});

describe('dexterMcpToolNames', () => {
  test('produces exact diagnostic names without an approval wildcard', () => {
    const names = dexterMcpToolNames([{ name: 'get_key_ratios' }, { name: 'read_filings' }]);
    expect(names).toContain(`mcp__${DEXTER_MCP_SERVER_NAME}__get_key_ratios`);
    expect(names).toContain(`mcp__${DEXTER_MCP_SERVER_NAME}__read_filings`);
    expect(names.some((name) => name.endsWith('__*'))).toBe(false);
  });
});
