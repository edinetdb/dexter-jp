/**
 * Adapts Dexter's LangChain tools into an in-process Claude Agent SDK MCP server.
 *
 * Design constraints (from the SDK-mode design doc §4-1):
 *   - Tools return RAW data. No tool re-invokes an LLM internally; the main SDK
 *     model interprets the raw results itself. So we expose the leaf finance
 *     tools (which hit EDINET DB directly) rather than the NL-routing meta-tools
 *     (`get_financials`, `company_screener`) that call `callLlm()` internally.
 *   - The resulting MCP server is registered under the name `dexter`, so tools are
 *     namespaced `mcp__dexter__<tool_name>` to the SDK.
 */
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

import {
  getFinancials,
  getCompanyInfo,
  getKeyRatios,
  getAnalysis,
  getEarnings,
  getShareholders,
  getTextBlocks,
  getStockPrice,
  isJQuantsAvailable,
  createReadFilings,
} from '../tools/finance/index.js';
import { createRawScreener } from '../tools/finance/raw-screener.js';
import { buildWebSearchToolForSdk } from '../tools/search/index.js';

/** Server name → tool names are exposed to the model as `mcp__dexter__<name>`. */
export const DEXTER_MCP_SERVER_NAME = 'dexter';

/**
 * Extract a plain zod raw shape (`{ field: ZodType }`) from a LangChain tool's
 * schema. The SDK's `tool()` wants a raw shape, not a `z.object(...)`. Leaf tools
 * in this repo all use `z.object({...})`, so `.shape` is present. If a tool ever
 * ships a bare JSON schema instead, we fall back to a permissive passthrough so
 * the adapter never throws at construction time.
 */
function extractRawShape(schema: unknown): z.ZodRawShape {
  const s = schema as { shape?: z.ZodRawShape; _def?: { shape?: unknown } } | undefined;
  if (s && typeof s === 'object') {
    if (s.shape && typeof s.shape === 'object') {
      return s.shape;
    }
    // zod v4 keeps shape under _def in some builds; probe defensively.
    const defShape = s._def?.shape;
    if (typeof defShape === 'function') {
      try {
        const resolved = (defShape as () => z.ZodRawShape)();
        if (resolved && typeof resolved === 'object') return resolved;
      } catch {
        /* fall through to passthrough */
      }
    } else if (defShape && typeof defShape === 'object') {
      return defShape as z.ZodRawShape;
    }
  }
  // Permissive fallback: accept an arbitrary JSON args object.
  return { input: z.record(z.string(), z.unknown()).optional().describe('Tool arguments') };
}

/** Stringify whatever a LangChain tool returns into a single text block. */
function stringifyToolResult(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/**
 * Wrap one LangChain StructuredTool as an SDK tool. The handler invokes the
 * underlying tool and returns its raw output as a text block, mapping thrown
 * errors to `isError: true` so the SDK agent loop keeps going (per SDK docs:
 * an uncaught throw ends the whole query()).
 */
function adaptLangChainTool(lcTool: StructuredToolInterface, readOnly: boolean) {
  const shape = extractRawShape(lcTool.schema);
  return tool(
    lcTool.name,
    typeof lcTool.description === 'string' ? lcTool.description : lcTool.name,
    shape,
    async (args: Record<string, unknown>) => {
      try {
        const raw = await lcTool.invoke(args as never);
        return { content: [{ type: 'text' as const, text: stringifyToolResult(raw) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: readOnly } },
  );
}

/**
 * The raw, no-internal-LLM tools we expose in SDK mode. All are read-only
 * (financial data reads), so the SDK may batch them in parallel.
 */
export function buildDexterSdkTools(): ReturnType<typeof adaptLangChainTool>[] {
  const rawTools: StructuredToolInterface[] = [
    // Leaf finance tools — hit EDINET DB directly, no internal LLM.
    getKeyRatios,
    getAnalysis,
    getFinancials,
    getCompanyInfo,
    getEarnings,
    getShareholders,
    getTextBlocks,
    // read_filings ignores its `model` arg (no internal LLM), safe as-is.
    createReadFilings(''),
    // Structured screener — main model supplies conditions directly (no NL→LLM step).
    createRawScreener(),
  ];

  // Optional raw tools gated by env.
  if (isJQuantsAvailable()) {
    rawTools.push(getStockPrice);
  }
  const webSearch = buildWebSearchToolForSdk();
  if (webSearch) {
    rawTools.push(webSearch);
  }

  return rawTools.map((t) => adaptLangChainTool(t, /* readOnly */ true));
}

/** The fully-qualified tool names the SDK should auto-approve (allowlist). */
export function dexterAllowedToolNames(tools: { name: string }[]): string[] {
  // The `tool()` helper stores the tool name; the SDK namespaces it as
  // mcp__<server>__<name>. A wildcard covers all tools on the server.
  return [`mcp__${DEXTER_MCP_SERVER_NAME}__*`, ...tools.map((t) => `mcp__${DEXTER_MCP_SERVER_NAME}__${t.name}`)];
}

/** Build the in-process MCP server holding the raw Dexter tools. */
export function buildDexterMcpServer(): {
  server: McpSdkServerConfigWithInstance;
  toolNames: string[];
} {
  const tools = buildDexterSdkTools();
  const server = createSdkMcpServer({
    name: DEXTER_MCP_SERVER_NAME,
    version: '1.0.0',
    tools,
  });
  return { server, toolNames: tools.map((t) => (t as { name?: string }).name ?? '') };
}
