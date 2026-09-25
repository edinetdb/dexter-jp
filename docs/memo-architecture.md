# Memo architecture

## Boundary

`write-memo` is a file-artifact workflow, not durable memory. It is discoverable only when the current user turn passes the code-level `explicit_memo` activation check and the runtime has the dedicated `write_memo` capability. Requests to remember something, summarize, convert to Markdown, explain, or generally save a file do not activate it.

The production path is:

```text
explicit memo intent
→ write-memo Skill
→ validated structured document
→ deterministic Markdown renderer
→ normalized memo.create operation
→ exact-operation approval
→ create-only UTF-8 write
```

The old disabled path asked the model to fill an English/US-market HTML template and send arbitrary HTML/path content to the overwrite-capable `write_file` tool. It also relied on relative non-Markdown template links, had no schema or renderer boundary, and provided no code-owned escaping or collision policy. Those assets remain for history but are not used by the rebuilt workflow.

## Structured document and rendering

The model may supply only content fields: display title, summary, key points, titled details, decisions, next actions, tags, and curated source references. Unknown fields are rejected. The top-level section order is fixed by code: 概要, 要点, 詳細, 決定事項, 次のアクション, 出典.

`renderMemo(document, { created })` is pure. It performs no model, network, filesystem, random, or clock access. Frontmatter field order and YAML quoting are fixed. Markdown control characters are escaped as plain content. Rendering always uses LF and ends with exactly one newline.

## Storage and names

Memos are stored only under `.dexter/memos/`. The runtime injects the creation date; a model-supplied date is overwritten during operation normalization. Filenames use `YYYYMMDD-<sanitized-title>.md`. Japanese and emoji remain readable, while control characters, path separators, Windows-unsafe characters, trailing dots/spaces, reserved device names, empty names, and overlong components are handled deterministically.

Writes use create-only filesystem semantics. An existing date/title collision fails without overwriting, appending, updating, or silently selecting a numbered filename. A later update requires a separate explicit operation and approval.

## Privacy and approval

The renderer receives only the validated document. It has no access to conversation history, scratchpad, tool-state, compaction, or chain-of-thought. The strict schema rejects extra reasoning/scratchpad fields. The Skill instructs the model to pass final conclusions and curated sources only.

Memo files are not written through `DurableMemoryPersistence`, are outside `.dexter/memory/`, and are not added to `MEMORY.md`, daily memory, or the memory index. A memo and durable memory may both be requested, but they remain two explicit, independently approved operations.

Before execution, `write_memo` becomes a `memo.create` operation whose fingerprint binds the canonical document, runtime date, and derived absolute target. The same normalized arguments are claimed immediately before tool invocation. LangChain and Claude Agent SDK use the shared Phase 5 gate; SDK mode exposes both `skill` and `write_memo` only for an explicit memo turn.
