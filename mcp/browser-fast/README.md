# browser-fast

`browser-fast` は、Codex と固定版 Jev Ultrafast の間に置くローカル stdio MCP server です。Jevを直接公開せず、URL security、domain boundary、action policy、step budget、独立verification、redacted JSON traceを強制します。Phase 1はread-onlyのnavigation/query専用です。

```text
Codex
  → browser_fast_run
  → URL / DNS / same-site security
  → Jev predict
  → action policy
  → act exactly once
  → fresh observation
  → independent verifier
  → structured result + JSON trace
```

設計は過剰設計・不足設計のどちらでもなく、Phase 1に**ぴったり**です。Jev固有APIは`jev_adapter.py`だけに閉じ込め、将来のbrowser engine交換時もMCP contractを維持できます。

## Requirements and setup

- Python 3.12以上
- `uv`
- Chromeでremote debuggingを許可できる環境
- TypeSafe API key
- safe query fieldsへ文字を生成するOpenAI-compatible text model key

```powershell
cd mcp/browser-fast
python -m uv sync
Copy-Item .env.example .env
# .envへTYPESAFE_API_KEYとTEXT_MODEL_API_KEYを設定
python -m uv run browser-harness --doctor
python -m uv run python scripts/check_environment.py
```

Jevは`UPSTREAM.lock`と`uv.lock`のcommit SHAへ固定されています。`main`を追従しません。

## stdio MCP startup and Codex registration

直接起動:

```powershell
python -m uv run browser-fast
```

Codex登録例（既存serverとは独立）:

```powershell
codex mcp add browser-fast -- `
  C:\Path\To\python.exe -m uv --directory C:\Path\To\dexter-jp\mcp\browser-fast run browser-fast
```

serverは同ディレクトリの`.env`を読みますが、既存process environmentを上書きしません。secretをrepositoryへcommitしないでください。

## Tool contract

公開toolは`browser_fast_run`の1つだけです。

```json
{
  "url": "https://en.wikipedia.org/wiki/Main_Page",
  "goal": "Search for and open Gödel's incompleteness theorems.",
  "expected_text_all": ["Gödel's incompleteness theorems"],
  "expected_text_any": [],
  "expected_url_regex": "wikipedia\\.org/wiki/.*incompleteness",
  "max_steps": 20
}
```

`max_steps`は1〜40、default 20です。Jev upstreamのbudgetとは別に強制され、自動増加しません。runsはshared Chrome profile保護と再現性のためglobal lockでserializeされます。

Status:

| status | meaning |
|---|---|
| `success` | Jev `DONE`かつfresh observationによる全verificationがPASS |
| `unverified_done` | `DONE`だがcriteriaなし、またはcriterion fail |
| `blocked` | URL/domain/Jev block |
| `policy_blocked` | unsafe actionをbrowser mutation前に拒否 |
| `max_steps` | browser-fast独自budget到達 |
| `error` | environment/model/browser/timeout error |

`DONE`だけで`success`にはなりません。`expected_text_all`は全件、`expected_text_any`は1件以上、`expected_url_regex`はfinal URLを検査します。

## Safety policy

許可対象は同一registrable domain内の通常navigation、search、filter、tab、checkbox/radio、native dropdown、sort、pagination、date/filter、expand/collapse、scroll/waitです。http/https以外、localhost、private/link-local/reserved IP、metadata endpoint、`.local`、別site navigationを拒否します。link hrefが観測できる場合はclick前にも検査します。

取引、buy/sell/order、payment、bank operation、message/email送信、publish/post/comment、upload、delete、account変更、login/logout、password/OTP/MFA/security code/API key/credit card入力、法的同意、application submissionは拒否します。既存Chrome profileがログイン済みでも例外にしません。曖昧な高risk actionはfail closedです。

Jevのmutation failureは同じpredictionでretryしません。fresh observationとfresh predictionへ戻ります。model-generated selector、arbitrary JavaScript、site-specific hardcoded action、Selenium/vision等へのhidden fallbackはありません。

## Traces

既定では`traces/<trace_id>/`へ次を保存します。

- `run.json`
- `actions.jsonl`
- `verification.json`

screenshotsは常に無効で、Jev `record_dir`も使いません。trace直前にtoken、cookie、authorization、email、card-like number、OTP-like value等をredactします。credentials、browser storage、raw cookiesは収集しません。必要なら`BROWSER_FAST_TRACE_DIR`でprivate directoryへ変更できます。

## Tests

Offline gatesはpaid APIを呼びません。

```powershell
python -m uv run ruff check .
python -m uv run pytest
```

Live smokeは分離されています。資格情報がなければPASSを偽装せず`BLOCKED_MISSING_CREDENTIALS`を返します。

```powershell
python -m uv run python scripts/smoke_wikipedia.py
```

## Browser Harness and upstream verification

```powershell
python -m uv run browser-harness --doctor
python -m uv run python scripts/check_environment.py
git ls-remote https://github.com/browser-use/jev-ultrafast.git HEAD
Get-Content UPSTREAM.lock
```

environment checkはPython、API keyの存在（値は表示しない）、Jev importとexact commit、MCP v2、Browser Harness、Chrome remote debuggingをPASS/FAIL表示します。

## Phase 1 limitations

未対応: Shadow DOM、frame/iframe、canvas、upload、popup tab、nested scrolling、arbitrary keyboard widget、screenshot vision fallback、login/auth flow、financial transaction、TradingView固有処理。Jev失敗時に別browser agentへfallbackせず、正確なfailureを返します。
