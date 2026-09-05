/**
 * Phase 2 acceptance harness: run the real AgentSdkAgent against a live query
 * that should trigger a Dexter EDINET DB tool call, with NO ANTHROPIC_API_KEY.
 *
 * Proves acceptance criteria #1 (real task completes on login creds), #6 (no SDK
 * built-in tools invoked). Prints the AgentEvent stream and the tools observed.
 *
 *   unset ANTHROPIC_API_KEY; EDINETDB_API_KEY=... bun run scripts/agent-sdk-tool-poc.ts
 */
import { AgentSdkAgent } from '../src/agent/agent-sdk-agent.js';
import type { AgentEvent } from '../src/agent/types.js';

const model = process.argv[2] ?? 'claude-sonnet-5';
const userQuery =
  process.argv.slice(3).join(' ') ||
  'What industry is Toyota (7203) in? Use get_company_info and state the industry.';

if (process.env.ANTHROPIC_API_KEY) {
  console.error('[poc] refusing to run with ANTHROPIC_API_KEY set (would use metered path).');
  process.exit(2);
}

async function main() {
  const agent = await AgentSdkAgent.create({ model, channel: 'cli' });

  const events: AgentEvent[] = [];
  let answer = '';
  const toolStarts: string[] = [];

  for await (const ev of agent.run(userQuery)) {
    events.push(ev);
    if (ev.type === 'tool_start') {
      toolStarts.push(ev.tool);
      console.log(`  [tool_start] ${ev.tool} ${JSON.stringify(ev.args)}`);
    } else if (ev.type === 'tool_end') {
      const preview = ev.result.slice(0, 120).replace(/\s+/g, ' ');
      console.log(`  [tool_end]   ${ev.tool} (${ev.duration ?? '?'}ms): ${preview}…`);
    } else if (ev.type === 'thinking') {
      console.log(`  [thinking]   ${ev.message.slice(0, 200)}`);
    } else if (ev.type === 'done') {
      answer = ev.answer;
    }
  }

  const observed = agent.observedToolNames;
  const builtinsCalled = observed.filter(
    (n) => !n.startsWith('mcp__dexter__') && n !== 'AskUserQuestion',
  );

  console.log('\n===== TOOL POC RESULT =====');
  console.log('event types      :', [...new Set(events.map((e) => e.type))].sort().join(', '));
  console.log('tool_starts      :', toolStarts.join(', ') || '(none)');
  console.log('tools observed   :', observed.join(', ') || '(none)');
  console.log('builtins invoked :', builtinsCalled.join(', ') || '(none)  ✓');
  console.log('final answer     :', JSON.stringify(answer.slice(0, 400)));

  const spinnerClosed = events.some((e) => e.type === 'done');
  const ok = spinnerClosed && !!answer && builtinsCalled.length === 0;
  console.log('verdict          :', ok ? 'PASS' : 'CHECK');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[poc] threw:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
