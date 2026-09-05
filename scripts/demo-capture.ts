/**
 * Demo capture harness: run AgentSdkAgent on a real query and persist the FULL
 * AgentEvent stream (JSONL) + final answer (md) for article material.
 *
 *   EDINETDB_API_KEY=... bun run scripts/demo-capture.ts <model> <outBase> <query...>
 */
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AgentSdkAgent } from '../src/agent/agent-sdk-agent.js';

const model = process.argv[2] ?? 'claude-fable-5';
const outBase = process.argv[3] ?? '/tmp/demo-run';
const query = process.argv.slice(4).join(' ');

if (!query) {
  console.error('[demo] query is required');
  process.exit(2);
}
if (process.env.ANTHROPIC_API_KEY) {
  console.error('[demo] refusing to run with ANTHROPIC_API_KEY set (would use metered path).');
  process.exit(2);
}

mkdirSync(dirname(outBase), { recursive: true });
const eventsPath = `${outBase}.events.jsonl`;
const answerPath = `${outBase}.answer.md`;
writeFileSync(eventsPath, '');

const agent = await AgentSdkAgent.create({ model, channel: 'cli' });
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
let answer = '';
let toolCalls = 0;

for await (const ev of agent.run(query)) {
  appendFileSync(eventsPath, `${JSON.stringify({ elapsedMs: Date.now() - t0, ...ev })}\n`);
  const e = ev as Record<string, unknown>;
  if (ev.type === 'tool_start') {
    toolCalls += 1;
    console.log(`[${secs()}s] tool#${toolCalls} ${String(e.tool)} ${JSON.stringify(e.args).slice(0, 160)}`);
  } else if (ev.type === 'thinking') {
    console.log(`[${secs()}s] thinking: ${String(e.message).slice(0, 120)}`);
  } else if (ev.type === 'done') {
    answer = typeof e.answer === 'string' ? e.answer : '';
  }
}

writeFileSync(answerPath, answer);
console.log(`\n[demo] model=${model} finished in ${secs()}s, ${toolCalls} tool calls`);
console.log(`[demo] events: ${eventsPath}`);
console.log(`[demo] answer: ${answerPath} (${answer.length} chars)`);
