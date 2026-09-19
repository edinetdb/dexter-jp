---
name: write-memo
description: 明示的に「メモを書いて・メモとして保存して」と依頼された内容を、構造化データから決定論的な日本語Markdownメモとして保存する。記憶、要約、Markdown変換、一般的なファイル保存では使用しない。
status: stable
activation: explicit_memo
requires:
  tools:
    - write_memo
---

# Write Memo Skill

明示的なmemo作成依頼だけを、安全で予測可能なMarkdownファイルへ変換する。

## 境界

- 「メモにして」「memoとして保存して」「Write this as a memo」のような明示依頼でのみ使う。
- 「覚えておいて」「記憶して」はdurable memoryの依頼であり、このSkillでは扱わない。
- 単なる要約、Markdown化、説明、一般的なファイル保存では使わない。
- memo storageとdurable memoryは別物。`memory_update`を自動実行しない。
- memo作成を理由に`MEMORY.md`、daily memory、memory indexへ登録しない。

## Workflow

1. ユーザーが渡した確定内容と、必要なら調査で得た最終的な事実だけを整理する。
2. 下記schemaに沿った構造化contentを作る。
3. `write_memo`を1回呼ぶ。`write_file`や`edit_file`でmemoを組み立てない。
4. Phase 5のexact-operation approvalを待つ。
5. 成功時はtoolが返したpathを簡潔に報告する。

## Structured content

`write_memo`の`document`へ次を渡す。トップレベル章順はrendererが固定するため、生のMarkdown、frontmatter、filename、pathは生成しない。

- `title`（必須）: 表示用タイトル。日本語、英数字、全角記号、emojiを使用できる。
- `summary`（任意）: 短い概要。
- `keyPoints`（任意）: 要点の配列。
- `details`（任意）: `{ title, body }`の配列。
- `decisions`（任意）: 確定した判断の配列。
- `nextActions`（任意）: 次の行動の配列。
- `tags`（任意）: タグの配列。
- `sourceContext`（任意）: 最終成果物に必要な`{ label, reference? }`だけ。

`created`はruntimeが注入するため指定しない。

## Privacy

- chain-of-thought、内部推論、scratchpad、探索途中の候補、失敗した仮説をdocumentへ含めない。
- toolのraw outputをそのまま貼らない。memoに必要な最終結論または出典だけを構造化する。
- 会話内容をmemoへ保存するのは、ユーザーがmemo化を明示した範囲だけに限定する。

## Write behavior

- 保存先は`.dexter/memos/`で固定される。
- filename、frontmatter、章順、Markdown escapingはrendererが決定する。
- UTF-8（BOMなし）で新規作成する。
- 同名memoが既にある場合は失敗する。自動上書き、自動追記、連番への変更をしない。
- overwrite、append、updateが必要な場合は、ユーザーの別の明示依頼と別operation approvalが必要。

## Chat response

本文を重複して貼らず、作成結果と保存pathだけを簡潔に返す。失敗時は理由をそのまま伝え、別名や上書きを自動選択しない。
