/**
 * MAGIスクリーニング（自動投資/magi_batch.py）の本命候補を、
 * TUIを介さずDexterエージェントに1回だけ問い合わせて深掘りレポートを得るための
 * ヘッドレス実行スクリプト。
 *
 * 入力: 標準入力からJSON1件（下記 CandidateInput 形式）
 * 出力: 標準出力にレポート本文のみ（他のログはstderrへ）
 *
 * 使い方:
 *   echo '{"code":"7203","name":"トヨタ","result":"本命候補 (満場一致 3/3)","fin_text":"...","votes":[...]}' \
 *     | bun run src/scripts/magi-deep-dive.ts
 */
import 'dotenv/config';
import { Agent } from '../agent/agent.js';
import { getSetting } from '../utils/config.js';
import { DEFAULT_MODEL } from '../model/llm.js';

// 読み取り専用の財務リサーチに閉じる。write_file/edit_file/browser/spawn_subagent等は含めない。
const RESEARCH_TOOLS = [
  'get_financials',
  'read_filings',
  'company_screener',
  'get_stock_price',
  'web_search',
  'web_fetch',
  'x_search',
];

const MAX_ITERATIONS = 8;
const TIMEOUT_MS = 5 * 60 * 1000; // 1銘柄あたり最大5分で打ち切る

interface Vote {
  name: string;
  vote: boolean | null;
  reason: string;
}

interface CandidateInput {
  code: string;
  name?: string;
  result: string;
  fin_text: string;
  votes: Vote[];
}

export function voteLabel(vote: boolean | null): string {
  if (vote === true) return '賛成';
  if (vote === false) return '反対';
  return '判定不能';
}

export function buildPrompt(candidate: CandidateInput): string {
  const label = candidate.name ? `${candidate.code}（${candidate.name}）` : candidate.code;
  const votesText = candidate.votes
    .map((v) => `- ${v.name}: ${voteLabel(v.vote)} — ${v.reason}`)
    .join('\n');

  return [
    `MAGIスクリーニングで「${candidate.result}」と判定された銘柄 ${label} について、深掘りレポートを作成してください。`,
    '',
    '## MAGI判定官の所見',
    votesText || '(なし)',
    '',
    '## 財務データ',
    candidate.fin_text,
    '',
    '有報のリスク要因や直近の決算・ニュースも調べたうえで、',
    'この銘柄への投資判断の参考になる分析を日本語でまとめてください。',
  ].join('\n');
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    throw new Error('標準入力が空です。候補データ(JSON)をパイプで渡してください。');
  }

  const candidate = JSON.parse(raw) as CandidateInput;
  const prompt = buildPrompt(candidate);

  // TUIで最後に選択されたモデル/プロバイダをそのまま使う（ローカルLLM運用と一致させるため）
  const model = getSetting<string>('modelId', DEFAULT_MODEL);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const agent = await Agent.create({
      model,
      maxIterations: MAX_ITERATIONS,
      memoryEnabled: false, // バッチ実行の履歴で個人の長期記憶を汚さない
      toolAllowlist: RESEARCH_TOOLS,
      signal: controller.signal,
    });

    let answer = '';
    for await (const event of agent.run(prompt)) {
      if (event.type === 'done') {
        answer = event.answer;
      }
    }

    if (!answer) {
      throw new Error('エージェントから回答が得られませんでした。');
    }

    process.stdout.write(answer + '\n');
  } finally {
    clearTimeout(timer);
  }
}

// CLIとして直接実行された場合のみ起動する（テストからimportされた際に誤発火しないように）
if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[magi-deep-dive] 失敗: ${message}`);
    process.exit(1);
  });
}
