# Dexter JP v1.0.5-jp — upstream sync (virattt/dexter v1.0.0 → v1.0.5)

Dexter JP を本家 [virattt/dexter](https://github.com/virattt/dexter) の最新リリース `v1.0.5` に追従させました。前回の同期基準は `v1.0.0`（JP `v1.0.0-jp`）でした。

## 本家から取り込んだ機能

- **Bash ツール**: 人間承認ゲート付きのシェル実行ツール（`allow-once` / `allow-session` / `allow-always` / `deny`）。新設の permission engine（`src/permissions/`）がコマンドを分類し、危険なコマンドは承認を要求します。CLI 専用（`CLI_ONLY_TOOLS`）。
- **サブエージェント委譲の system prompt 拡充**: 独立したサブタスクは同一ターンで並列に `spawn_subagent` を呼べるというガイダンスを追加。
- **検索プロバイダ選択 UI**（`/search` コマンド、`SearchSelectionController`）: Exa / Perplexity / Tavily / LangSearch から優先プロバイダを選択可能に。
- **Microcompact**（`src/agent/microcompact.ts`）: 会話が肥大化する前に古いツール結果を軽量にクリアする仕組み。JP のツール名（`get_financials` / `get_stock_price` / `read_filings` / `company_screener` 等）に合わせて対象ツール名を調整済み。
- **Permission rules 永続化**（`.dexter/settings.json` の `permissions` セクション）。
- スピナー描画の高頻度化（フレーム前進を tick と分離、体感の滑らかさ向上）。
- OpenAI モデルラインナップを `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` に更新（デフォルトモデルも `gpt-5.6-sol` に追従）。
- Ollama Cloud プロバイダ追加。

## 意図的に取り込まなかったもの（米国固有・EDINET DB非対応）

以下は本家 v1.0.1〜v1.0.5 で追加/変更された米国株向け機能で、EDINET DB (日本市場) には対応するデータ源がないため見送りました:

- `get_market_data` / `stock_screener`（米国株価・スクリーニング。JP は `get_stock_price`(J-Quants) / `company_screener`(EDINET DB) を継続使用）
- `insider_ownership.ts` / `institutional_holdings.ts` / `beneficial_ownership.ts`（SEC の Form 3/4/5, 13F, 13D/G ベースの米国固有ツール。CIK 前提で EDINET DB では提供不可）
- `formatters.ts`（米国データ整形ロジック、以前から未使用）
- `getStockPrices`（Financial Datasets 提供の米国ティッカー向け価格取得。JP は J-Quants 専用実装 `getStockPrice` を継続）
- `get_earnings` のノーティッカー "latest earnings feed" モード（EDINET DB 側に全社横断フィード API が無いため見送り。将来 API 対応があれば再検討）

## JP オリジナル機能（今回のマージで保持を確認したもの）

- EDINET DB / J-Quants 連携全般（`get_financials`, `read_filings`, `company_screener`, `get_stock_price`, `get_earnings` (TDNet 決算短信), `getShareholders` (大量保有報告書)）
- メッセージングゲートウェイ（Slack / Discord / LINE / WhatsApp）と `DEXTER_PUBLIC_GATEWAY` による公開ゲートウェイモード（危険なツール群を除外するセキュリティゲート）
- `/rules` 直接ファイル読み込み（`.dexter/RULES.md`）
- Claude Agent SDK モード（`claude-agent-sdk` プロバイダ）
- 識別子整合性・上場状態確認の system prompt ルール（誤った証券コード/EDINET codeの記憶からの捏造を防止）
- DCF バリュエーションスキルの日本市場向けパラメータ（JGB金利、EDINET DB ベースのデータ取得）

## 既知の残課題

- `src/skills/write-memo/SKILL.md` は本家からそのまま移植された未ローカライズのスキルで、米国ティッカー・SEC 前提のままです（TODO コメントで明示済み、今回のマージ対象外）。

## ゲート結果

- `bun install`: 成功（lockfile 再生成）
- `bun run typecheck`: 成功（エラーなし）
- `bun test`: 362 pass / 0 fail（`src/evals/dataset.test.ts` の閾値・期待値を JP データセット規模に合わせて調整）
- CLI 起動スモークテスト: 成功（`Welcome to Dexter v1.0.5-jp`、モデル表示 `GPT 5.6 Sol` を確認）。EDINET DB API キー未設定環境のため実データ呼び出しは未実施。
