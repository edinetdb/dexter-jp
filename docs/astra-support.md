# GPT-6 Astra support

Dexter supports GPT-6 Astra as an explicit OpenAI model selection. The registered model ID is `gpt-6-astra`. GPT-5.6 Sol remains the OpenAI default, and GPT-5.6 Luna remains the OpenAI fast model used for compaction, fetch helpers, and isolated Astra workers.

## Official API contract

The implementation follows the current OpenAI documentation:

- [GPT-6 Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [Model guidance and migration notes](https://developers.openai.com/api/docs/guides/latest-model)
- [Responses API reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)

The documented model ID is `gpt-6-astra`. It has a 1,050,000-token context window, a 128,000-token maximum output, and API access from usage Tier 1 upward; the Free tier is not supported. Dexter routes it to OpenAI and uses the Responses API because Astra function calling requires Responses. Streaming, function calling, and Structured Outputs are supported. The supported reasoning efforts are `low`, `medium`, `high`, `xhigh`, and `max`; `none` and `minimal` are rejected. Dexter exposes `auto`, `default`, `flex`, `fast`, and `priority` as validated service-tier values for explicit runtime callers. The installed LangChain version represents the official `fast` alias as `priority`, so Dexter normalizes that alias explicitly before the request. Fast/priority availability can also depend on OpenAI data-residency settings, so Dexter does not enable either by default.

Dexter sends no Astra reasoning or service-tier override during normal product use. It uses the API defaults. It does not send `temperature`, `top_p`, `top_logprobs`, `logprobs`, or `message.output_text.logprobs` for Astra. Explicit unsupported values fail before a request instead of being downgraded. Because @langchain/openai 1.3.1 predates the GPT-6 model-name pattern, Dexter places explicit Astra effort in the Responses `reasoning.effort` payload through validated model kwargs; an offline test locks this mapping.

## Runtime behavior

Selecting Astra changes only the main LangChain model. It does not change approval, exact-operation binding, DCF calculation, X activation, memo, memory, Bash, compaction, or prompt policy. The same shared system prompt and Skill discovery path are used for all LangChain models.

Astra workers use the existing OpenAI fast-model policy (`gpt-5.6-luna`). This keeps the expensive reasoning model on the orchestration path while isolated read-only research workers and existing lightweight helper calls use Luna. Other parent models keep their existing worker inheritance behavior.

Claude Agent SDK is a separate Anthropic runtime and does not accept Astra. CLI and gateways share the same provider/model settings; Astra uses the existing `OPENAI_API_KEY` and requires no new environment variable.

## Offline compatibility evidence

`bun run eval` includes Astra in the provider-neutral Phase 7 matrix and runs ten Astra-specific deterministic cases:

1. multi-part completion;
2. missing required input;
3. four distinct successful retrievals;
4. repeated no-progress operation;
5. Skill recovery after full compaction;
6. explicit deterministic DCF;
7. implicit valuation without DCF activation;
8. explicit X with capability availability;
9. implicit sentiment without X activation;
10. memo and durable-memory separation.

The report labels this result exactly as:

```text
ASTRA OFFLINE COMPATIBILITY: PASS
ASTRA LIVE VALIDATION: NOT EXECUTED
```

Offline PASS validates repository contracts and adapters. It is not evidence of live Astra behavior.

## Opt-in live smoke

List the bounded, read-only cases without making an API call:

```text
bun run eval:astra-live
```

Live execution requires both an explicit flag and environment guard:

```bash
DEXTER_ASTRA_LIVE=1 bun run eval:astra-live -- --execute
```

PowerShell:

```powershell
$env:DEXTER_ASTRA_LIVE='1'
bun run eval:astra-live -- --execute
```

The live suite is limited to eight behavioral cases, uses medium reasoning, standard processing, an 800-token output cap per case, a 30-second timeout, and the existing bounded retry path. It binds only deterministic or nonexecuting read-only fixture tools and performs no file write, memo write, memory update, browser action, X request, publish, or destructive operation. It is never called by `bun test`, `bun run eval`, or `bun run acceptance`.

## Validated live smoke evidence

The bounded live suite completed successfully against `gpt-6-astra` on 2026-09-20:

```text
ASTRA LIVE VALIDATION: PASS
Model: gpt-6-astra
Reasoning: medium
Processing: standard
Cases: 8 passed / 8 total
Critical failures: 0
```

The live smoke verified multi-part completion structure, missing-input non-fabrication behavior, explicit and implicit DCF activation, memo and durable-memory separation, explicit X activation, adversarial non-action routing, and Skill/tool routing. The fixture tools were nonexecuting, so the run observed model selection and arguments without performing external mutation.

The run did not fully validate DCF argument preservation through a real calculation, propagation of an actual DCF result, a real X API request, a real memo filesystem write, a real durable-memory write, long multi-turn continuation after compaction, exact clarification wording, or the OpenAI client's internal HTTP retry count. Those remain separate end-to-end validation targets and do not weaken the bounded smoke result.

The `negative-adversarial-routing` case selected no tools as required. Its text heuristic reported `clarificationLikely=true` because the explanatory response contained the word `確認`; the response did not ask a clarification question. This is a non-blocking observability false positive rather than a routing or model-behavior failure.
