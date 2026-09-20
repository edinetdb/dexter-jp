# Offline cross-model behavioral evaluation

Phase 7 adds an offline-first behavioral contract harness. It does not invoke a model, a paid API, X, a browser, or a market-data service, and it does not change product routing or tool behavior.

## Audited runtime surface

The formal provider registry is `src/providers.ts`; selectable static model IDs come from `src/utils/model.ts`. OpenAI's static matrix includes explicitly selectable GPT-6 Astra while GPT-5.6 Sol remains the default. LangChain supports OpenAI, Anthropic, Google, xAI, Moonshot, DeepSeek, OpenRouter, and Ollama. OpenRouter accepts a user-supplied model ID and Ollama discovers local IDs, so the offline matrix records those entries without inventing a model name. Claude Agent SDK is a separate runtime/provider selection with its three registered Claude model IDs.

The LangChain loop binds tools from `src/tools/registry.ts`, receives provider-normalized `AIMessage.tool_calls`, executes through `AgentToolExecutor`, and emits `AgentEvent` records. Provider-specific details are handled before that boundary: Anthropic system-message cache annotations, Gemini schema sanitization, OpenAI-compatible endpoints, and Ollama's local model adapter. LangChain calls use provider defaults for sampling because no general temperature/top-p override is set. The wrapper retries transient calls up to three attempts with 500 ms and 1,000 ms backoff. DeepSeek thinking models explicitly request high reasoning effort as an existing provider option.

Claude Agent SDK registers raw Dexter tools as an in-process MCP server, receives SDK `tool_use` records with `mcp__dexter__` names, and translates SDK messages to Dexter events. The SDK controls its own retry/sampling behavior. Its environment is allowlisted and its billing path is guarded before a live query. SDK mode exposes `calculate_dcf` directly, does not expose the general Skill meta-tool, X search, or durable-memory tools, and exposes `skill` plus `write_memo` only on an explicit memo turn. This is reported as runtime capability variance rather than hidden or ranked.

The LangChain system prompt contains the channel profile, available Skill metadata, optional durable-memory context, and research rules. The SDK prompt has a smaller raw-tool policy, no durable-memory context, and only renders Skill metadata when its Skill tool is present. Both use the current user turn for the code-enforced memo boundary.

The pre-existing `src/evals/run.ts` is a separate live LangSmith/OpenAI evaluation with an LLM judge. It remains unchanged and is not invoked by `bun run eval` or `bun test`.

## Architecture

The evaluation path is:

```text
safe data-driven case
→ scripted observable behavior
→ LangChain/SDK recorded shape
→ provider-neutral EvalEvent
→ deterministic assertions
→ category and critical-failure report
```

Recorded fixtures contain only user input, tool names, structured arguments, approval descriptors, sanitized tool outcomes, and final semantic markers. They contain no API values, authentication material, chain-of-thought, scratchpad, or hidden reasoning.

Layer 1 runs the actual deterministic architecture baseline once. It covers operation policy and fingerprints, the DCF calculator, memo schema/rendering/filename/write behavior, memory persistence and restart behavior, compaction-source sanitization, and Skill capability filtering. It is explicitly excluded from cross-model scores.

Layers 2–4 replay the same behavioral cases through each formally registered configuration. Assertions compare Skill activation, tool calls and counts, argument/schema status, operation risk and approvals, exact-operation binding, persistence-class effects, deterministic byte hashes, numeric propagation, and required semantic markers. They do not exact-match natural-language answers and do not require an LLM judge.

## Scores and failure semantics

Reports keep routing, tools, approval, privacy, and deterministic-output scores separate. A configuration fails when any assertion fails. It also fails independently of averages when any of these critical conditions is observed:

- approval bypass or destructive mutation without approval;
- changed target/arguments escaping the approved fingerprint;
- scratchpad/transient state entering durable memory;
- hidden reasoning persistence;
- memo-to-memory silent promotion;
- credential exposure;
- explicit DCF bypassing `calculate_dcf`.

No model ranking is produced. Offline fixture PASS means the architecture, adapters, and evaluator enforce the recorded contract for that registered configuration shape; it is not a claim about unexecuted live model quality.

## Japanese contract

Japanese cases are native cases, not translations. They cover pure Japanese, mixed Japanese/English, polite and short requests, negation, quoted instructions, ambiguous save wording, memo wording, and memory wording. Phase 7 preserves the Phase 6 matcher unchanged. Therefore `メモにして` is explicit memo intent, `これ覚えといて` is memory intent rather than memo intent, and the currently unsupported colloquial spelling `これメモっといて` remains outside the deterministic memo gate. Expanding that boundary is a product behavior change and is not part of this phase.

## Commands

- `bun run eval` prints the human-readable offline report.
- `bun run eval:json` prints the complete machine-readable JSON report.
- `bun test src/evals/behavioral/behavioral-eval.test.ts src/evals/astra/offline.test.ts` runs the harness and Astra offline regression tests.
- `bun run eval:astra-live` lists the bounded Astra live smoke cases and prints `ASTRA LIVE VALIDATION: NOT EXECUTED` without using credentials.
- `DEXTER_ASTRA_LIVE=1 bun run eval:astra-live -- --execute` is the explicit paid/live entry point and is never called by normal tests.

The human report prints `ASTRA OFFLINE COMPATIBILITY: PASS` only for deterministic repository compatibility. It separately prints `ASTRA LIVE VALIDATION: NOT EXECUTED`; the offline result is not a claim about live model behavior. Credentials being absent never fails the offline command.
