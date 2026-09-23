🇬🇧 [English version](README.en.md)

# Dexter JP — 日本株の自律型リサーチエージェント

> 聞くだけで、勝手に計画を立てて、複数のデータソースを横断して、自分で検証しながらレポートまで仕上げる。

[EDINET DB](https://edinetdb.jp) + [J-Quants](https://jpx-jquants.com/) で動く、日本株特化の金融AIエージェント。
[virattt/dexter](https://github.com/virattt/dexter)（米国株版）をフォークし、日本市場向けに全面改修。

![Dexter JP Demo](docs/demo.png)

## ⚠️ 免責事項

本プロジェクトは**教育・娯楽・情報提供のみを目的**としています。実際の取引や投資判断のために使用することは意図していません。

- 金融、投資、税務、法律に関する助言ではありません
- 正確性、完全性、特定目的への適合性を保証するものではありません
- 出力結果には誤り、不完全な情報、古い情報が含まれる可能性があります
- 作成者および貢献者は、本ソフトウェアの利用によって生じたいかなる金銭的損失・損害についても責任を負いません
- 投資判断を行う前には、必ず有資格の金融アドバイザーにご相談ください
- 過去の実績は将来の成果を示すものではありません

本ソフトウェアを利用することにより、学習・情報提供の目的のみに使用することに同意し、利用に伴う一切のリスクを受け入れたものとします。

## 答え合わせ（v1.1.0-jp）

自分の仮説を、その会社の有価証券報告書の段落に 1 本ずつ当てて、「裏付ける」「食い違う」「無関係」を出典つきで返します。会社自身が何と書いたかを並べるだけで、売買の判断はしません。

```
/check 9983 中国事業は回復していると会社は説明している
```

仮説を主張に分け（原文と並べて見せます）、有報の対象節を段落に切り、段落ごとに主張を当てます。段落から確かめられなければ「判定不能」で止めます。モデルに埋めさせません。

パネルには、仮説の原文、分けた主張、判定の根拠になった会社自身の段落（doc_id・提出者・書類種別・節つき）、検査した範囲と未検査数が出ます。

### まず動かす

```bash
DEXTER_SKIP_BROWSER=1 bun install
bun run demo
```

`bun run demo` は記録済みの実行を再生します。鍵は要りません。外部への通信もありません。画面に「録画の再生」と出ます。

`DEXTER_SKIP_BROWSER=1` は Chromium（130MB 超）のダウンロードを飛ばします。`browser` ツールを使うときだけ入れ直してください。

### 自分の仮説で回すのに要るもの

| | 鍵 | できること |
|---|---|---|
| 1 | なし | `bun run demo`（録画の再生） |
| 2 | `EDINETDB_API_KEY` + `TYPESAFE_API_KEY` | `/check` が動く |

EDINET DB の鍵は[こちら](https://edinetdb.jp/developers?utm_source=github&utm_medium=readme&utm_campaign=dexter-kotaeawase)から無料で取れます（会員登録が要ります）。

**`/check` は `TYPESAFE_API_KEY` が無いと動きません。** 手元の LLM にラベルだけ代行させる構成でも動くようにはしていません。理由は測った結果です。

`/check` の入口には、売買や株価の水準についての助言を求める入力を判定に進めない検査があります。この検査は「決まった語彙と言い回しの検査」と「判定層の票」の 2 つでできていて、片方だけでは足りません。実装も語彙リストも見せずに別のモデルに書かせた 30 本の助言入力で測ると、こうなりました。

| 検査 | 素通りした数 | 正常な 20 本の誤検知 |
|---|---|---|
| 決まった語彙と言い回しだけ | 12/30 | 0/20 |
| 判定層（Jev）の票だけ | 1/30 | 0/20 |
| 2 つを合わせたもの（実装の形） | 0/30 | 0/20 |
| 決まった語彙 + 手元の LLM の票 | 8/30 | 0/20 |

手元の LLM で代行すると 30 本のうち 8 本が素通りします。素通りさせたまま動かすより、止まる方を選びました。鍵を入れる前に何が返るかは `bun run demo` で見てください。

### 出さないもの

- 本ツールは投資助言を行いません。`/check` と `/watch` は、売買の指示・目標株価・建玉の大きさを出力しません
- 割安か割高か、妥当な株価の水準は出しません。それを尋ねる入力は判定に進めず、開示で確かめられる言い換えを提案します
- 上昇基調・高値圏のような相場の局面を表す言葉は使いません
- 検査した段落の中での分類数は出しますが、「仮説の支持率」のような 1 つの数字にまとめることはしません
- 確率の表示は「この段落と主張の関係についてのモデルの推定」です。仮説が正しい確率ではありません
- `/check` の記録は端末内の `.dexter/checks/` に残ります。消したいときはこのディレクトリを消してください

### データがどこへ行くか

| 送信先 | 何が送られるか | いつ | 誰の鍵・契約 | 既定 |
|---|---|---|---|---|
| EDINET DB | 銘柄コードと API の要求（有価証券報告書の本文・財務データ・開示イベントの取得） | EDINETDB_API_KEY | あなたの EDINET DB の鍵 | 有効 |
| 選択中の LLM プロバイダ | あなたの仮説の文、有価証券報告書の段落、会話の内容（分解・要約・自由質問） | 選んだプロバイダの鍵（/model で切り替え） | あなたの鍵・契約 | 有効 |
| TypeSafe（Jev、米国） | あなたの仮説から分けた主張と、有価証券報告書の段落（1 段落ずつ） | TYPESAFE_API_KEY | あなたの TypeSafe の鍵 | 無効 |
| 会話履歴の埋め込み（OpenAI → Gemini → Ollama の順で自動選択） | 会話の全文（あなたの入力とエージェントの応答）。**選択中の LLM とは独立に決まります** — /model で Claude を選んでいても、OPENAI_API_KEY があれば OpenAI に送られます | 既定で有効。OPENAI_API_KEY / GOOGLE_API_KEY / OLLAMA_BASE_URL のいずれか | あなたの鍵 | 有効 |
| LangSmith | LangChain のプロンプトとツールの結果（トレース） | LANGSMITH_TRACING=1 | あなたの LangSmith の鍵 | 無効 |
| J-Quants | 銘柄コードと日付（株価の取得） | JQUANTS_API_KEY | あなたの J-Quants の契約 | 無効 |
| Web 検索プロバイダ（Tavily / Exa / Perplexity / LangSearch） | 検索語（/search で選んだプロバイダにだけ送られます） | 選んだプロバイダの鍵 | あなたの鍵 | 無効 |
| X（旧 Twitter） | 検索語（あなたが入力した、またはエージェントが組み立てた検索の語句） | X_BEARER_TOKEN | あなたの鍵 | 無効 |
| Ollama（既定では手元、設定すれば別のホスト） | 会話の内容・埋め込みの対象テキスト | OLLAMA_BASE_URL / OLLAMA_CLOUD_API_KEY | —（手元で動かす場合は外に出ません） | 無効 |
| OpenRouter | 会話の内容（OpenRouter 経由のモデルを選んだ場合） | OPENROUTER_API_KEY | あなたの鍵 | 無効 |
| Moonshot | 会話の内容（Kimi を選んだ場合） | MOONSHOT_API_KEY | あなたの鍵 | 無効 |
| DeepSeek | 会話の内容（DeepSeek のモデルを選んだ場合） | DEEPSEEK_API_KEY | あなたの鍵 | 無効 |
| メッセージングのゲートウェイ（Slack / Discord / WhatsApp / LINE） | エージェントの応答（ゲートウェイを起動した場合のみ） | それぞれのゲートウェイを起動したとき | あなたのトークン | 無効 |

TypeSafe（Jev）について、「保存しない」とは書きません。同社は入力を学習データに含めない旨を規約で定めていますが、Telemetry の生成・不正対策・法令対応のための処理権を留保しています。各サービスの規約はご自身でご確認ください。

会話履歴の埋め込みは既定で有効で、選択中の LLM とは独立に送信先が決まります。`/model` で Claude を選んでいても、`.env` に `OPENAI_API_KEY` があれば会話は OpenAI に送られます。起動時に、そのセッションで実際に外へ出る先の一覧が出ます。

### 同梱しているデータ

`bun run demo` が再生する段落は、有価証券報告書の本文です。同梱データ（`src/data/materials/`）の段落と一字一句同じで（テストで照合しています）、そちらの 1 件ずつに書類管理番号・提出者・書類種別・箇所・取得日・出典表記・編集加工の主体を持たせています。

> 出典：EDINET閲覧（提出）サイト（https://disclosure2.edinet-fsa.go.jp/）、PDL1.0（https://www.digital.go.jp/resources/open_data/public_data_license_v1.0）

**このデータは MIT ライセンスの対象外です。** 利用条件は `LICENSE-DATA` に別に書いてあります。提出会社から差し替え・削除の要請があった場合の手順も同ファイルにあります。

### 使う前に知っておいてほしいこと

このツールの出力を第三者に提供する形（公開のボットなど）で使う場合、あなた自身が金融商品取引法その他の規制を受ける可能性があります。

### この版に入っていないもの

- TradingView 接続。ウォッチリストを読み込む機能は次の版以降に回しました
- Agent SDK モードでの `/check`。分解と要約を SDK の単発呼び出しで回せるかを確かめていないので、この版では未対応です
- `/watch` は開示の取得と並べ替えまで実装済みですが、コマンドとしての配線は次の版です
- 数値の主張を財務データで検算する機能。検算の部品はありますが `/check` にまだ配線していないので、この版の `/check` は文章の主張だけを段落に当てます

### 判定が割れるとき

有価証券報告書の全文で回すと、セグメントや地域ごとの増益の段落を、連結の減益と食い違うと読み、判定が割れることがあります。トヨタ自動車の第122期の有報（MD&A・事業等のリスク・経営方針の 103 段落）で「営業利益が減ったのは為替の影響が主因だと会社は説明している」を回すと、3 つの主張とも「判定が割れている」になりました（減益は裏付け 12 / 食い違い 3）。`bun run demo` の録画は、同じ有報から選んだ 10 段落で回したものです。

## ただのツールではない

よくある金融ツールは「スクリーニングできます」「財務データ見れます」で終わる。Dexter JPは違う。

**「ソニーと任天堂、投資先としてどちらが優れているか分析して」** と聞くと:

1. まず計画を立てる — 比較に必要な指標（収益性、成長性、財務健全性、リスク）を自分で決める
2. 複数のツールを自律的に呼び出す — 両社の財務データ、有報のリスク要因、決算短信を並列取得
3. 途中で検証する — 数字とナラティブに矛盾がないか、データが足りているか自分で判断
4. レポートを仕上げる — 比較表と結論付きの構造化された分析結果を出力

これを1回の質問で、人間が介在せずにやる。ツールを1つ呼ぶだけの「データ取得」ではなく、複数のデータソースを横断した「分析」が自動で走る。

## セットアップ

### 必要なもの

- [Bun](https://bun.sh/)
- LLM APIキー（以下のいずれか1つ）
- [EDINET DB](https://edinetdb.jp) APIキー

### 環境変数

`.env`に設定するもの:

```bash
# === 必須 ===

# LLM（いずれか1つ。複数設定してもOK、CLI上で切替可能）
OPENAI_API_KEY=sk-...          # OpenAI（デフォルト）
ANTHROPIC_API_KEY=sk-ant-...   # Claude
GOOGLE_API_KEY=...             # Gemini
XAI_API_KEY=...                # Grok
OPENROUTER_API_KEY=...         # OpenRouter（複数モデル利用可）

# 日本株データ
EDINETDB_API_KEY=edb_...       # edinetdb.jp で取得（無料枠あり）

# === オプション ===

# 株価データ（設定すると get_stock_price ツールが有効化）
JQUANTS_API_KEY=...            # jpx-jquants.com で取得（無料、期限なし）

# Web検索（設定すると web_search ツールが有効化。優先順: Exa → Perplexity → Tavily）
EXASEARCH_API_KEY=...
PERPLEXITY_API_KEY=...
TAVILY_API_KEY=...

# X/Twitter検索
X_BEARER_TOKEN=...

# ローカルLLM
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

### インストール & 起動

```bash
git clone https://github.com/edinetdb/dexter-jp.git
cd dexter-jp
bun install
cp env.example .env  # 編集してAPIキーを設定
bun run start
```

## 使い方の例

### 自律的な分析（エージェントの真価）

複雑な問いを投げると、Dexterが自分で計画を立て、複数のデータソースを横断し、レポートを仕上げる:

```
トヨタの競争力を総合分析して。財務データ、有報のリスク要因、最新決算を踏まえてレポートにまとめて

ソニーと任天堂、投資先としてどちらが優れているか。財務健全性・収益性・成長性・リスクを比較して結論を出して

高ROE・高配当の割安銘柄を探して、トップ3の財務健全性と事業リスクを深掘り分析して

キーエンスのDCFバリュエーションをして。現在の株価水準が割高か割安か判断して
```

### シンプルな質問もOK

```
トヨタの直近5年の財務推移を見せて

ROE15%以上、自己資本比率50%以上の企業をスクリーニングして

任天堂の有報のリスク要因を読んで

配当利回り4%以上の高配当銘柄を探して
```

### 英語でも動く

```
Analyze Toyota's competitiveness. Cover financials, risk factors from the annual report, and latest earnings.

Compare Sony vs Nintendo as investment targets with a final recommendation.
```

## アーキテクチャ

```
ユーザーの質問
    ↓
エージェントループ（LangChain）
    ↓ 計画 → ツール選択 → 実行 → 検証 → 繰り返し
    ↓
┌─────────────────────────────────────────┐
│  get_financials（メタツール）             │
│    → get_financial_statements           │
│    → get_company_info                   │
│    → get_key_ratios                     │
│    → get_analysis                       │
│    → get_earnings                       │
├─────────────────────────────────────────┤
│  read_filings                           │
│    → text-blocks（有報テキスト）          │
│    → shareholders（大量保有報告書）       │
├─────────────────────────────────────────┤
│  company_screener（100+ 指標）           │
├─────────────────────────────────────────┤
│  get_stock_price（J-Quants V2）          │
├─────────────────────────────────────────┤
│  web_search / browser / skills          │
└─────────────────────────────────────────┘
    ↓
構造化されたレポート出力
```

### メタツールの仕組み

`get_financials`は単なるAPIラッパーではない。内部にLLMを持つ**ルーティングエージェント**:

1. ユーザーの自然言語クエリを受け取る
2. 内部LLMがどのサブツールを呼ぶべきか判断
3. 複数サブツールを並列実行
4. 結果を統合して返す

「ソニーとトヨタの利益率を比較して」→ 内部で4つのAPI呼び出しが自動で走る。

### スキルシステム

複雑な多段階ワークフローは`SKILL.md`で定義。DCFバリュエーションスキルを内蔵:
- 日本国債利回りベースのWACC計算
- 東証PBR1倍割れ問題の文脈
- 円建て分析

### リサーチルール（`.dexter/RULES.md`）

自分の投資スタイルや分析方針をMarkdownで定義できる。設定した内容がシステムプロンプトに自動で反映され、Dexterの行動指針になる。

```bash
mkdir -p .dexter
cp RULES.md.example .dexter/RULES.md
# 自分のルールに書き換える
```

CLIで `/rules` と入力すると現在のルールを確認できる。

設定例:
- 分析時は必ず同業他社5社と比較する
- 財務指標はJPY百万円で表示する
- バリュー投資基準（ROE > 10%、PBR < 1.5）でスクリーニングする

### コンテキスト圧縮

長時間のリサーチセッションで大量のデータを取得した場合、高速LLMが自動的にデータをサマリに圧縮してコンテキストを節約する。単純なデータ削除ではなく、重要な数値・結論を保持した要約を生成するため、セッションを通じた分析の整合性が保たれる。

### メモリ

セッション間で記憶を保持。投資方針、ポートフォリオ情報、過去の分析結果を覚える。

### 対応LLM

`/model`コマンドでCLI上から切替可能:

- OpenAI（GPT-4o, GPT-4o-mini 等）
- Anthropic（Claude）
- Google（Gemini）
- xAI（Grok）
- OpenRouter
- Ollama（ローカルLLM）
- Claude Agent SDK（後述）

### Claude Agent SDK モード

`@anthropic-ai/claude-agent-sdk` 経由で動く実行モード。エージェントのループを SDK に委譲し、**認証は SDK が解決する**（Dexter は認証フローを実装しない）。

- `/model` で **Claude Agent SDK** プロバイダを選び、モデル（claude-fable-5 / claude-opus-4-8 / claude-sonnet-4-6）を選ぶだけで使える。API キーの入力は求められない。
- 認証は SDK が解決する。**Claude Code のログイン**、`CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_API_KEY` のいずれでも動作する。どれが使われるかは SDK が環境から判断する。
- Claude プラン（Pro/Max）で Agent SDK を利用できるかの条件は Anthropic の公式ヘルプを参照（[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540)）。制度は変更される可能性がある。
- 個人の資格情報でのみ使うこと。マルチユーザー向けサービスとして提供しない。
- **課金経路の確認**: `ANTHROPIC_API_KEY` や `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` など従量課金の資格情報が環境にある場合、起動時に検出結果を表示し、意図しない課金経路で走らないよう停止する（fail-loud）。その経路で実行したい場合は `DEXTER_AGENT_SDK_ALLOW_METERED=1` を設定して再実行する。
- コスト上限を設けたい場合は `DEXTER_AGENT_SDK_MAX_BUDGET_USD`（USD）を設定する。SDK 側の見積りがこの値に達すると停止する。
- このモードでは Dexter の財務・データツールを「そのままのデータを返す」形で SDK に渡し、メインモデル自身が解釈する（ツール内部で LLM を再呼び出ししない）。SDK 組み込みのツール（Bash / Write / WebSearch 等）は使わない。

> 注: 本モードの利用可否・料金は Anthropic 側の仕様変更に依存する。ここでは「無料」「追加課金なし」といった断定はしない。実際にどの資格情報が使われるかは起動時の表示で確認できる。

### メッセージング連携

CLIだけでなく、Slack・Discord経由でも使える。`bun run gateway` で起動:

| チャネル | 方式 | 公開URL | 環境変数 |
|---------|------|---------|---------|
| **Slack** | Socket Mode (WebSocket) | 不要 | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` |
| **Discord** | Gateway (WebSocket) | 不要 | `DISCORD_BOT_TOKEN` |
| **LINE** | Webhook (HTTP) | 必要 | `LINE_CHANNEL_SECRET` + `LINE_CHANNEL_ACCESS_TOKEN` |
| WhatsApp | Baileys (WebSocket) | 不要 | QRコードでログイン |

設定された環境変数に応じて、対応するチャネルだけが起動する。複数チャネル同時稼働可能。

#### Slack Bot セットアップ

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From scratch
2. **Socket Mode** → Enable → App-Level Token を生成（`xapp-`で始まるトークン）
3. **OAuth & Permissions** → Bot Token Scopes に追加:
   - `chat:write`, `im:history`, `im:read`, `app_mentions:read`
4. **Event Subscriptions** → Enable Events → Subscribe to bot events:
   - `message.im`（DM受信）, `app_mention`（メンション受信）
5. **App Home** → Messages Tab を ON → 「Allow users to send Slash commands and messages from the messages tab」にチェック
6. **Install to Workspace** → Bot Token（`xoxb-`で始まる）をコピー
7. `.env` に設定:
   ```bash
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```

サーバー内ではスレッド返信、DMでは直接返信。

#### Discord Bot セットアップ

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. **Bot** → Reset Token → Bot Token をコピー
3. **Bot** → Privileged Gateway Intents → **Message Content Intent** を ON
4. **OAuth2** → URL Generator:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`, `Send Messages in Threads`
5. 生成されたURLをブラウザで開いてサーバーに招待
6. `.env` に設定:
   ```bash
   DISCORD_BOT_TOKEN=MTQ4...
   ```

サーバー内では `@Bot名` メンションでスレッド返信、DMでは直接返信。

#### LINE Bot セットアップ

LINEはWebhook方式のため、外部からアクセス可能なURLが必要（Slack/Discordとは異なる）。

1. [LINE Official Account Manager](https://manager.line.biz/) で **LINE公式アカウントを作成**
   - LINE Developersコンソールから直接Messaging APIチャネルは作成できない（2026年時点）
2. LINE Official Account Manager → **設定** → **Messaging API** → **「Messaging APIを利用する」**
   - プロバイダーを選択（既存でOK）
3. [LINE Developersコンソール](https://developers.line.biz/console/) → 該当チャネル → **Messaging API設定** タブ:
   - **チャネルアクセストークン（長期）** → 発行
   - **Webhook URL** → `https://{your-domain}/webhook/line` を設定
   - **Webhookの利用** → ON
   - **Webhookの再送** → OFF（重複処理防止）
4. LINE Official Account Manager → **設定** → **応答設定**:
   - **応答メッセージ** → OFF
   - **あいさつメッセージ** → OFF
5. **チャネル基本設定** タブからChannel Secretを取得
6. `.env` に設定:
   ```bash
   LINE_CHANNEL_SECRET=your-channel-secret
   LINE_CHANNEL_ACCESS_TOKEN=your-channel-access-token
   WEBHOOK_PORT=3000  # デフォルト
   ```

公開URL（Webhook）の用意:
- **ローカルテスト**: `ngrok http 3000` → 生成されたURL + `/webhook/line` をWebhook URLに設定
- **本番運用**: 長寿命プロセスを維持できるサービスにデプロイ（サーバーレス不可）
  - [Railway](https://railway.app/) — `Dockerfile` 追加するだけ。無料枠あり。最も手軽
  - [Fly.io](https://fly.io/) — `fly launch` で数分。無料枠あり
  - [Render](https://render.com/) — Background Worker として起動。無料枠あり
  - Google Cloud Run（min-instances=1）
  - 自前のVPS / VPC
  - **Vercel / Netlify は不可**（サーバーレスのため長寿命プロセスを維持できない）

#### 起動

```bash
bun run gateway    # 設定済みの全チャネルが同時に起動
```

## データソース

| ソース | 内容 | 必須？ |
|--------|------|--------|
| [EDINET DB](https://edinetdb.jp) | 財務データ、有報テキスト、スクリーニング、AI分析（~3,800社） | 必須 |
| [J-Quants](https://jpx-jquants.com/) | 株価OHLC（東証公式） | オプション |
| Web検索 | Exa / Perplexity / Tavily | オプション |

## オリジナル版（米国株）との違い

| | Original (US) | JP Version |
|---|---|---|
| データソース | Financial Datasets API | EDINET DB API |
| 市場 | 米国株 | 日本株（~3,800社） |
| 開示書類 | SEC 10-K/10-Q/8-K | 有価証券報告書 (EDINET) |
| 決算 | 8-K earnings | TDNet 決算短信 |
| 株主情報 | SEC Form 4（インサイダー） | 大量保有報告書（5%超） |
| 株価 | Financial Datasets | J-Quants V2（TSE公式） |
| スクリーニング | GICS分類 | 33業種、100+指標 |
| DCF | 米国金利（~4%） | 日本国債（~1%） |
| 言語 | 英語 | 日本語 + 英語 |

## ライセンス

MIT

## クレジット

- オリジナル [Dexter](https://github.com/virattt/dexter) by [@virattt](https://github.com/virattt)（現在 [v1.0.5](https://github.com/virattt/dexter/releases/tag/v1.0.5) に追従）
- 財務データ: [EDINET DB](https://edinetdb.jp)
- 株価データ: [J-Quants](https://jpx-jquants.com/)
