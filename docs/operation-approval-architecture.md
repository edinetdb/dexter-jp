# Operation-based approval architecture

Phase 5 replaces tool-name approval with a deterministic operation boundary shared by the LangChain and Claude Agent SDK runtimes.

## Runtime flow

1. A tool call and its arguments are cloned and normalized.
2. The normalizer resolves the operation kind, action, risk, target, batch scope, and canonical arguments.
3. A pure policy maps the risk to either no approval or user approval.
4. Allowed calls receive a one-use claim keyed by a SHA-256 fingerprint of the complete normalized operation.
5. Immediately before invocation, the runtime normalizes the approved arguments again and consumes the matching claim.
6. A changed action, target, batch, or argument set has a different fingerprint and cannot use the previous approval.

Session approval stores only exact operation fingerprints. It is not a tool-wide or global bypass. An identical retry can reuse its fingerprint; a changed retry must be evaluated again.

## Risk classes

| Risk | Examples | Runtime behavior |
| --- | --- | --- |
| read_only | file read, search, inspect, deterministic calculation, cron list, heartbeat view | no approval |
| local_mutation | file edit, memory append/edit | exact-operation approval |
| external_mutation | browser click/type/press, cron add/update/run, heartbeat update | exact-operation approval |
| destructive | file create-or-overwrite, memory delete, cron remove | exact-operation approval |
| sensitive | unknown or unclassified capability | fail closed; approval is required and absence of an approval bridge denies execution |

Browser navigation/read operations remain read-only. Browser interactions that can submit or modify remote state are external mutations.

Bounded runtime housekeeping such as caches, logs, temporary result files, and UI history is not a user-directed operation and does not create an approval capability. Those paths remain fixed by the runtime, cannot select arbitrary user targets, and are never treated as approval receipts.

## Legacy compatibility

Resolution order is:

1. explicit argument-aware resolvers for multi-operation and mutation tools;
2. a deterministic allowlist for audited legacy read-only tools;
3. a sensitive, approval-required fallback for unknown tools.

The tool registry and SDK tool set are covered by tests that reject an unclassified current tool. New tools must therefore be deliberately classified or will fail closed.

## SDK boundary

Dexter MCP tools are no longer included in the SDK approval wildcard. Every MCP call passes through the shared operation gate. The MCP handler then consumes the one-use exact-operation claim before invoking the underlying LangChain tool. SDK built-in tools and shell access remain denied.

## Persistence and privacy

Approval requests, decisions, fingerprints, rejected calls, and normalized arguments are runtime state only. They are not written through the durable-memory persistence boundary and are not added to scratchpad persistence or compaction.