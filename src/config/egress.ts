/**
 * 送信先の台帳（single source of truth）。
 *
 * **README の表と起動画面の両方をここから作る**（go-decision G-D2、review r2 H1 / M8）。
 *
 * なぜ台帳にするか: 「README に必須 7 項が書いてある」を grep で固定しても、
 * **その文が正しいかは測れない**。実際、設計 v0.3 までの README 案は送信先を 2 つ
 * （LLM プロバイダと TypeSafe）としていたが、実コードには **5 つ目と 6 つ目**があった:
 *   - 会話履歴の埋め込み（`src/memory/index.ts` の既定 `enabled:true` / `indexSessions:true`）は
 *     **選択中の LLM とは独立に** `OPENAI_API_KEY` の有無で OpenAI → Gemini → Ollama を選ぶ。
 *     つまり `/model` で Claude を選んでいても、`.env` に OpenAI 鍵が残っていれば
 *     会話（= 仮説の文と有報の段落を含む）が OpenAI に行く
 *   - LangSmith（`LANGSMITH_TRACING=1` のとき、LangChain の全プロンプトとツール結果）
 *
 * だから台帳を 1 つ置き、テストは**許可リスト方式**にする =
 * ソースに現れる外部ホストのうち、ここに登録されていないものがあれば赤。
 * 「文があるか」ではなく「実態が台帳と合っているか」を測る。
 */

export type EgressCategory =
  | 'disclosure' // 開示データの取得
  | 'llm' // 文章の生成・要約
  | 'judge' // 判定
  | 'memory' // 会話履歴の埋め込み
  | 'search' // Web・SNS 検索
  | 'market' // 株価
  | 'telemetry' // トレース
  | 'messaging'; // ゲートウェイの相手先

export interface EgressDestination {
  /** 台帳の ID */
  id: string;
  /** 利用者に見せる名前 */
  label: string;
  /** 通信先のホスト（複数ありうる。LLM プロバイダのように SDK 任せのものは空でよい） */
  hosts: string[];
  category: EgressCategory;
  /** **何が送られるか**（利用者向けの日本語。曖昧にしない） */
  whatIsSent: string;
  /** **いつ有効になるか**（環境変数・設定の条件） */
  enabledWhen: string;
  /** 誰の鍵・契約か */
  credential: string;
  /** 既定で有効か（利用者が何もしなくても通信しうるか） */
  onByDefault: boolean;
}

export const EGRESS_DESTINATIONS: readonly EgressDestination[] = [
  {
    id: 'edinetdb',
    label: 'EDINET DB',
    hosts: ['edinetdb.jp'],
    category: 'disclosure',
    whatIsSent: '銘柄コードと API の要求（有価証券報告書の本文・財務データ・開示イベントの取得）',
    enabledWhen: 'EDINETDB_API_KEY',
    credential: 'あなたの EDINET DB の鍵',
    onByDefault: true,
  },
  {
    id: 'llm-provider',
    label: '選択中の LLM プロバイダ',
    hosts: [], // SDK 任せ（@langchain/anthropic 等）。プロバイダの一覧は src/providers.ts が正本
    category: 'llm',
    whatIsSent: 'あなたの仮説の文、有価証券報告書の段落、会話の内容（分解・要約・自由質問）',
    enabledWhen: '選んだプロバイダの鍵（/model で切り替え）',
    credential: 'あなたの鍵・契約',
    onByDefault: true,
  },
  {
    id: 'typesafe-jev',
    label: 'TypeSafe（Jev、米国）',
    hosts: ['api.typesafe.ai'],
    category: 'judge',
    whatIsSent: 'あなたの仮説から分けた主張と、有価証券報告書の段落（1 段落ずつ）',
    enabledWhen: 'TYPESAFE_API_KEY',
    credential: 'あなたの TypeSafe の鍵',
    onByDefault: false,
  },
  {
    id: 'memory-embeddings',
    label: '会話履歴の埋め込み（OpenAI → Gemini → Ollama の順で自動選択）',
    hosts: [],
    category: 'memory',
    whatIsSent:
      '会話の全文（あなたの入力とエージェントの応答）。' +
      '**選択中の LLM とは独立に決まります** — /model で Claude を選んでいても、' +
      'OPENAI_API_KEY があれば OpenAI に送られます',
    enabledWhen: '既定で有効。OPENAI_API_KEY / GOOGLE_API_KEY / OLLAMA_BASE_URL のいずれか',
    credential: 'あなたの鍵',
    onByDefault: true,
  },
  {
    id: 'langsmith',
    label: 'LangSmith',
    hosts: ['smith.langchain.com', 'api.smith.langchain.com'],
    category: 'telemetry',
    whatIsSent: 'LangChain のプロンプトとツールの結果（トレース）',
    enabledWhen: 'LANGSMITH_TRACING=1',
    credential: 'あなたの LangSmith の鍵',
    onByDefault: false,
  },
  {
    id: 'jquants',
    label: 'J-Quants',
    hosts: ['api.jquants.com'],
    category: 'market',
    whatIsSent: '銘柄コードと日付（株価の取得）',
    enabledWhen: 'JQUANTS_API_KEY',
    credential: 'あなたの J-Quants の契約',
    onByDefault: false,
  },
  {
    id: 'web-search',
    label: 'Web 検索プロバイダ（Tavily / Exa / Perplexity / LangSearch）',
    hosts: ['api.perplexity.ai', 'api.langsearch.com'],
    category: 'search',
    whatIsSent: '検索語（/search で選んだプロバイダにだけ送られます）',
    enabledWhen: '選んだプロバイダの鍵',
    credential: 'あなたの鍵',
    onByDefault: false,
  },
  {
    id: 'x-search',
    label: 'X（旧 Twitter）',
    hosts: ['api.x.com', 'api.x.ai'],
    category: 'search',
    whatIsSent: '検索語（あなたが入力した、またはエージェントが組み立てた検索の語句）',
    enabledWhen: 'X_BEARER_TOKEN',
    credential: 'あなたの鍵',
    onByDefault: false,
  },
  {
    id: 'ollama',
    label: 'Ollama（既定では手元、設定すれば別のホスト）',
    hosts: ['ollama.com'],
    category: 'llm',
    whatIsSent: '会話の内容・埋め込みの対象テキスト',
    enabledWhen: 'OLLAMA_BASE_URL / OLLAMA_CLOUD_API_KEY',
    credential: '—（手元で動かす場合は外に出ません）',
    onByDefault: false,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hosts: ['openrouter.ai'],
    category: 'llm',
    whatIsSent: '会話の内容（OpenRouter 経由のモデルを選んだ場合）',
    enabledWhen: 'OPENROUTER_API_KEY',
    credential: 'あなたの鍵',
    onByDefault: false,
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    hosts: ['api.moonshot.cn'],
    category: 'llm',
    whatIsSent: '会話の内容（Kimi を選んだ場合）',
    enabledWhen: 'MOONSHOT_API_KEY',
    credential: 'あなたの鍵',
    onByDefault: false,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hosts: ['api.deepseek.com'],
    category: 'llm',
    whatIsSent: '会話の内容（DeepSeek のモデルを選んだ場合）',
    enabledWhen: 'DEEPSEEK_API_KEY',
    credential: 'あなたの鍵',
    onByDefault: false,
  },
  {
    id: 'messaging-gateways',
    label: 'メッセージングのゲートウェイ（Slack / Discord / WhatsApp / LINE）',
    hosts: [],
    category: 'messaging',
    whatIsSent: 'エージェントの応答（ゲートウェイを起動した場合のみ）',
    enabledWhen: 'それぞれのゲートウェイを起動したとき',
    credential: 'あなたのトークン',
    onByDefault: false,
  },
];

/**
 * ソースに現れるが**送信先ではない**ホスト。
 * ここに置くものは「利用者に見せるリンク」か「説明文の中の例」だけ。
 * **通信する先をここに入れてはいけない**（許可リストの穴になる）。
 */
export const NON_EGRESS_HOSTS: readonly { host: string; why: string }[] = [
  { host: 'jp.tradingview.com', why: 'deep link。URL を画面に出すだけで、取得も認証もしない' },
  { host: 'x.com', why: '案内文の中のリンク' },
  { host: 'github.com', why: '案内文の中のリンク' },
  { host: 'company.com', why: '説明文の中の例' },
  { host: 'investors.company.com', why: '説明文の中の例' },
  { host: 'example.com', why: '説明文の中の例' },
];

/** 台帳に登録された全ホスト。 */
export function registeredHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const d of EGRESS_DESTINATIONS) for (const h of d.hosts) hosts.add(h);
  for (const { host } of NON_EGRESS_HOSTS) hosts.add(host);
  return hosts;
}

/** その環境で実際に有効になっている送信先だけを返す（起動画面用。G-D2）。 */
export function activeDestinations(env: NodeJS.ProcessEnv = process.env): EgressDestination[] {
  return EGRESS_DESTINATIONS.filter(d => {
    switch (d.id) {
      case 'edinetdb': return Boolean(env.EDINETDB_API_KEY);
      case 'llm-provider': return true; // 何かしらのモデルを選ばないと動かない
      case 'typesafe-jev': return Boolean(env.TYPESAFE_API_KEY);
      case 'memory-embeddings':
        return Boolean(env.OPENAI_API_KEY || env.GOOGLE_API_KEY || env.OLLAMA_BASE_URL);
      case 'langsmith': return env.LANGSMITH_TRACING === '1' || env.LANGSMITH_TRACING === 'true';
      // 鍵の名前は実装（stock-price.ts / registry.ts）と同じでないと、有効なのに一覧から消える（Codex T9 H4）
      case 'jquants': return Boolean(env.JQUANTS_API_KEY);
      case 'web-search':
        return Boolean(env.TAVILY_API_KEY || env.EXASEARCH_API_KEY || env.PERPLEXITY_API_KEY || env.LANGSEARCH_API_KEY);
      case 'x-search': return Boolean(env.X_BEARER_TOKEN);
      case 'ollama': return Boolean(env.OLLAMA_BASE_URL || env.OLLAMA_CLOUD_API_KEY);
      case 'openrouter': return Boolean(env.OPENROUTER_API_KEY);
      case 'moonshot': return Boolean(env.MOONSHOT_API_KEY);
      case 'deepseek': return Boolean(env.DEEPSEEK_API_KEY);
      case 'messaging-gateways': return false; // ゲートウェイの起動時にだけ出す
      default: return false;
    }
  });
}

/** 起動画面の 1 画面（design §4.0・G-D2）。プロバイダの切り替えに追随する。 */
export function renderEgressScreen(env: NodeJS.ProcessEnv = process.env): string[] {
  const active = activeDestinations(env);
  const lines = ['このセッションで外に出るもの:'];
  if (active.length === 0) {
    lines.push('  （鍵が 1 つも設定されていません。外には出ません）');
    return lines;
  }
  for (const d of active) {
    lines.push(`  ${d.label}`);
    lines.push(`    送るもの: ${d.whatIsSent}`);
    lines.push(`    条件: ${d.enabledWhen}（${d.credential}）`);
  }
  lines.push('  各サービスの規約はご自身でご確認ください。');
  return lines;
}

/** README の表（design §4.0 の表をここから作る）。 */
export function renderEgressTable(): string {
  const header = '| 送信先 | 何が送られるか | いつ | 誰の鍵・契約 | 既定 |';
  const sep = '|---|---|---|---|---|';
  const rows = EGRESS_DESTINATIONS.map(
    d => `| ${d.label} | ${d.whatIsSent} | ${d.enabledWhen} | ${d.credential} | ${d.onByDefault ? '有効' : '無効'} |`,
  );
  return [header, sep, ...rows].join('\n');
}
