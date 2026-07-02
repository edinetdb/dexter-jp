/**
 * Phase 2 plumbing PoC: prove the full SDK → in-process MCP tool → result →
 * answer path, and that built-in tools are denied, WITHOUT any external network
 * dependency. Uses a deterministic local tool through the exact same SDK options
 * the AgentSdkAgent uses (tools: [], disallowedTools, allowedTools, canUseTool,
 * scoped env). This validates acceptance #1's mechanism and #6 independently of
 * EDINET DB endpoint availability.
 *
 *   unset ANTHROPIC_API_KEY; bun run scripts/agent-sdk-plumbing-poc.ts [model]
 */
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { buildSdkEnv } from '../src/agent/sdk-env-guard.js';

const model = process.argv[2] ?? 'claude-sonnet-5';

if (process.env.ANTHROPIC_API_KEY) {
  console.error('[poc] refusing to run with ANTHROPIC_API_KEY set.');
  process.exit(2);
}

let toolWasCalled = false;

const getSecretNumber = tool(
  'get_secret_number',
  'Returns the secret number for a given company id. The only way to learn the secret number.',
  { company_id: z.string().describe('The company id to look up') },
  async (args) => {
    toolWasCalled = true;
    // Deterministic, no network.
    const n = args.company_id === 'ACME' ? 4242 : 1;
    return { content: [{ type: 'text' as const, text: JSON.stringify({ company_id: args.company_id, secret_number: n }) }] };
  },
  { annotations: { readOnlyHint: true } },
);

const server = createSdkMcpServer({ name: 'dexter', version: '1.0.0', tools: [getSecretNumber] });

async function main() {
  let sawInit = false;
  let apiKeySource: string | undefined;
  let initTools: string[] = [];
  let finalText = '';
  let resultSubtype: string | undefined;
  const builtinsAttempted: string[] = [];
  const toolUses: string[] = [];

  for await (const message of query({
    prompt:
      'Use the get_secret_number tool to look up the secret number for company id "ACME", then reply with just that number.',
    options: {
      model,
      systemPrompt: 'You are a lookup assistant. Use tools to find values; never guess.',
      settingSources: [],
      tools: [],
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Task', 'TodoWrite'],
      allowedTools: ['mcp__dexter__*'],
      mcpServers: { dexter: server },
      strictMcpConfig: true,
      permissionMode: 'default',
      maxTurns: 6,
      env: buildSdkEnv(),
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        if (toolName.startsWith('mcp__dexter__')) {
          return { behavior: 'allow' as const, updatedInput: input };
        }
        builtinsAttempted.push(toolName);
        return { behavior: 'deny' as const, message: 'not allowed in SDK mode' };
      },
    },
  })) {
    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
      sawInit = true;
      apiKeySource = (message as { apiKeySource?: string }).apiKeySource;
      initTools = (message as { tools?: string[] }).tools ?? [];
    } else if (message.type === 'assistant') {
      const content = (message as { message?: { content?: unknown[] } }).message?.content ?? [];
      for (const b of content as Array<{ type?: string; name?: string; text?: string }>) {
        if (b.type === 'tool_use' && b.name) toolUses.push(b.name);
      }
    } else if (message.type === 'result') {
      resultSubtype = (message as { subtype?: string }).subtype;
      if (resultSubtype === 'success') finalText = (message as { result?: string }).result ?? '';
    }
  }

  console.log('\n===== PLUMBING POC RESULT =====');
  console.log('saw system/init      :', sawInit);
  console.log('apiKeySource         :', apiKeySource ?? '(none)');
  const builtinsInContext = initTools.filter((t) => !t.startsWith('mcp__'));
  console.log('init tools           :', initTools.join(', ') || '(none)');
  console.log('builtins in context  :', builtinsInContext.join(', ') || '(none ✓)');
  console.log('tool_use blocks      :', toolUses.join(', ') || '(none)');
  console.log('dexter tool ran      :', toolWasCalled);
  console.log('builtins attempted   :', builtinsAttempted.join(', ') || '(none ✓)');
  console.log('result subtype       :', resultSubtype ?? '(none)');
  console.log('final answer         :', JSON.stringify(finalText));

  const answeredWith4242 = finalText.includes('4242');
  const ok =
    resultSubtype === 'success' &&
    toolWasCalled &&
    answeredWith4242 &&
    builtinsAttempted.length === 0 &&
    builtinsInContext.length === 0;
  console.log('verdict              :', ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[poc] threw:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
