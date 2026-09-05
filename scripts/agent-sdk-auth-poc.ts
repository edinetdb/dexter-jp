/**
 * Phase 1 auth PoC for the Claude Agent SDK mode.
 *
 * Purpose: establish the technical fact of whether `@anthropic-ai/claude-agent-sdk`
 * runs on this machine's Claude Code login credentials (OAuth), with NO
 * `ANTHROPIC_API_KEY` set, and whether the `model` option is honored.
 *
 * This is throwaway/diagnostic — it is NOT wired into the app. It exists only to
 * de-risk the full implementation. Run with:
 *   unset ANTHROPIC_API_KEY; bun run scripts/agent-sdk-auth-poc.ts [model]
 *
 * We deliberately pass NO tools and `tools: []` (all built-ins removed) so the
 * model must answer from its own knowledge — the smallest possible round trip.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const model = process.argv[2] ?? 'claude-fable-5';

// Fail loud if a paid metered credential is present — we want to prove the
// OAuth/login path, not silently bill an API key.
if (process.env.ANTHROPIC_API_KEY) {
  console.error(
    '[poc] ANTHROPIC_API_KEY is set in this shell. Unset it before running the PoC ' +
      'so we exercise the Claude Code login path, not the metered API key.',
  );
  process.exit(2);
}
for (const meteredFlag of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
  if (process.env[meteredFlag]) {
    console.error(`[poc] ${meteredFlag} is set — refusing to run (would use a metered provider).`);
    process.exit(2);
  }
}

// Scope the env the SDK sees. We keep only what the SDK subprocess plausibly
// needs plus the Claude Code OAuth context; we do NOT forward search/finance keys.
const OAUTH_ENV_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_'];
const BASE_ENV_KEYS = ['HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME', 'TERM', 'LANG', 'TMPDIR', 'XDG_CONFIG_HOME'];
const scopedEnv: Record<string, string | undefined> = {};
for (const key of BASE_ENV_KEYS) {
  if (process.env[key] !== undefined) scopedEnv[key] = process.env[key];
}
for (const [key, value] of Object.entries(process.env)) {
  if (OAUTH_ENV_PREFIXES.some((p) => key.startsWith(p))) scopedEnv[key] = value;
}

async function main() {
  console.log(`[poc] requesting model=${model} with NO ANTHROPIC_API_KEY, tools=[] ...`);

  let sawInit = false;
  let apiKeySource: string | undefined;
  let reportedModel: string | undefined;
  let finalText: string | undefined;
  let resultSubtype: string | undefined;
  let assistantError: string | undefined;
  let costUsd: number | undefined;
  const seenTypes = new Set<string>();

  const q = query({
    prompt: 'Reply with just the number. What is 1 + 1?',
    options: {
      model,
      systemPrompt: 'You are a calculator. Answer with only the number, nothing else.',
      settingSources: [],
      tools: [],
      maxTurns: 2,
      permissionMode: 'default',
      env: scopedEnv,
    },
  });

  for await (const message of q) {
    seenTypes.add(message.type);
    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
      sawInit = true;
      apiKeySource = (message as { apiKeySource?: string }).apiKeySource;
      reportedModel = (message as { model?: string }).model;
      console.log(`[poc] system/init: apiKeySource=${apiKeySource} model=${reportedModel}`);
    } else if (message.type === 'assistant') {
      const err = (message as { error?: string }).error;
      if (err) assistantError = err;
      const content = (message as { message?: { content?: unknown[] } }).message?.content ?? [];
      for (const block of content as Array<{ type?: string; text?: string }>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          finalText = (finalText ?? '') + block.text;
        }
      }
    } else if (message.type === 'result') {
      resultSubtype = (message as { subtype?: string }).subtype;
      costUsd = (message as { total_cost_usd?: number }).total_cost_usd;
      if (resultSubtype === 'success') {
        finalText = (message as { result?: string }).result ?? finalText;
      } else {
        const errs = (message as { errors?: string[] }).errors ?? [];
        console.error(`[poc] result error subtype=${resultSubtype}: ${errs.join('; ')}`);
      }
    }
  }

  console.log('\n===== PoC RESULT =====');
  console.log('message types seen:', [...seenTypes].sort().join(', '));
  console.log('saw system/init   :', sawInit);
  console.log('apiKeySource      :', apiKeySource ?? '(none)');
  console.log('model requested   :', model);
  console.log('model reported    :', reportedModel ?? '(none)');
  console.log('result subtype    :', resultSubtype ?? '(none)');
  console.log('assistant error   :', assistantError ?? '(none)');
  console.log('total_cost_usd    :', costUsd ?? '(none)');
  console.log('final answer      :', JSON.stringify(finalText ?? '(none)'));

  const ok = resultSubtype === 'success' && !!finalText && !assistantError;
  console.log('PoC verdict       :', ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('\n[poc] threw:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
