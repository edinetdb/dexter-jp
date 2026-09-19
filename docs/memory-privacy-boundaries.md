# Memory / runtime state / scratchpad の境界

## 保存クラス

| クラス | 内容 | 主な保持場所 | 再起動後 |
|---|---|---|---|
| durable memory | ユーザーが将来の会話で再利用するため明示的に保存した事実・嗜好・確定判断 | `.dexter/memory/MEMORY.md` と日次 Markdown、そこから派生する SQLite index | 復元される |
| conversation/runtime state | 現在の会話に必要な user/final assistant turn、queue、compaction summary | `InMemoryChatHistory` と現在の Agent run | 消える |
| scratchpad/transient state | tool call/result、途中思考、候補、compaction 前後の作業状態 | `Scratchpad` のメモリ内配列 | 消える |

CLI の `.dexter/messages/chat_history.json` は入力履歴と `/history` 表示のための UI archive であり、durable memory ではない。system prompt、会話 context、memory search index には注入しない。

## Durable memory の書込み

本番コードの書込み経路は次の一つに限定する。

`memory_update` tool → `MemoryManager.persistExplicitUpdate` → `DurableMemoryPersistence` → `MemoryStore`

`DurableMemoryPersistence` は origin が `memory_update_tool` でない mutation を拒否する。conversation message、tool result、scratchpad entry、compaction result は、それ自体ではこの contract を満たさない。

## Durable memory の読込み

LangChain Agent は起動時に `MEMORY.md`、当日、前日の日次 memory を token 上限内で system prompt の `User context` に注入する。`memory_search` と `memory_get` も同じ明示保存済みファイルだけを読む。

SQLite index は memory ファイルの派生データである。旧実装が作成した `sessions/chat_history.json` chunk と未参照 embedding は同期時に削除する。

## Scratchpad と tool result

`Scratchpad` は Agent run ごとに新規作成し、ディスクへ書かず、次の run から読み込まない。大きな tool result は現在の run 専用ディレクトリへ一時退避できるが、Agent の `finally` でディレクトリごと削除する。過去バージョンが作成した既存 artifact は読み込まず、この変更ではユーザーデータ保護のため自動削除しない。

## Compaction

データフローは次のとおり。

`conversation/runtime state` → summary-only の構造化 compaction → `compacted conversation/runtime state`

compaction は専用 system prompt と strict schema を使い、受理するフィールドは `summary` のみとする。raw response、analysis field、chain-of-thought は保持しない。compaction code は durable memory writer を呼ばない。

## SDK Agent runtime

Claude Agent SDK mode は durable memory を system prompt へ注入せず、memory tools も MCP tool set に含めない。SDK には現在の user query だけを渡し、SDK の内部 state を Dexter の durable memory へ保存しない。この Phase では既存 SDK behavior を変更していない。

## 再起動境界

- 残る: 明示保存した memory Markdown、memory 由来の SQLite index、CLI UI archive、gateway の routing metadata。
- runtime context としては復元しない: CLI UI archive、過去の一時 tool artifact。
- 消える: `InMemoryChatHistory`、gateway の会話 map/queue、scratchpad、compaction summary、run-scoped tool-result directory。