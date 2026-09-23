/**
 * `/check` を CLI から呼ぶ層（review T9 H6）。
 *
 * `runCheck` は判定層（TypeSafe の 429 3 連・認証失敗・ネットワーク断）・EDINET DB（401 / 404 /
 * レート制限）・LLM の失敗・記録の書き出しのどれでも例外を上げる。以前の `cli.ts` はこれを
 * 握っておらず、TUI の入力ハンドラで unhandled rejection = 何も出ないか生のスタックになっていた。
 *
 * ここで**必ず**画面に出す形（行の配列）に落とす。例外を呼び出し側へ返さない。
 * cli.ts の closure から切り出したのは、テストから直接呼べるようにするため。
 */
import { parseCheckArgs } from '../commands/parse.js';
import { JudgeUnavailableError } from '../judge/errors.js';
import { runCheck, type CheckPorts } from './index.js';
import { renderCheckPanel } from './panel.js';

export interface CheckMessage {
  text: string;
  /** 補足（薄く出す） */
  muted: boolean;
}

export const JUDGE_UNAVAILABLE_AT_RUN = [
  '判定層（TypeSafe の Jev）から応答が得られなかったため、/check を止めました。',
  '時間をおいてもう一度お試しください。続く場合は .env の TYPESAFE_API_KEY を確認してください。',
  '判定層の票が無いまま先へ進めることはしません。記録はしていません。',
].join('\n');

export const CHECK_FAILED_PREFIX = '/check を最後まで実行できませんでした';

/**
 * Agent SDK モードでは `/check` を走らせない（Codex T9 r2 H1）。
 * 分解・要約は `callLlm`（LangChain）を通るので、SDK を選んでいても同じ `claude-*` のモデル名が
 * 通常の Anthropic API に送られ、SDK 側の課金ガード・予算上限を通らない。README の「未対応」を通信前に強制する。
 */
export const SDK_MODE_UNSUPPORTED =
  '/check は Claude Agent SDK モードに対応していません（この版では未対応です）。/model で SDK 以外のプロバイダを選ぶと使えます。何も送信していません。';

/** 例外の 1 行目だけを短く出す（スタックは出さない）。 */
function briefReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const first = raw.split('\n')[0]?.trim() ?? '';
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
}

export async function runCheckCommand(
  rest: string,
  ports: CheckPorts,
  options: { interactive: boolean; provider?: string } = { interactive: true },
): Promise<CheckMessage[]> {
  if (options.provider === 'claude-agent-sdk') return [{ text: SDK_MODE_UNSUPPORTED, muted: true }];
  const { ticker, hypothesis } = parseCheckArgs(rest);
  try {
    const outcome = await runCheck(ticker, hypothesis, ports, { interactive: options.interactive });
    switch (outcome.kind) {
      case 'usage':
      case 'judge_unavailable':
        return [{ text: outcome.message, muted: true }];
      case 'refused': {
        const lines = [outcome.verdict.message];
        if (outcome.verdict.suggestions.length > 0) {
          lines.push('', '開示で確かめられる形だと、たとえば:');
          for (const s of outcome.verdict.suggestions) lines.push(`  ・${s}`);
        }
        return [{ text: lines.join('\n'), muted: false }];
      }
      case 'panel':
        return [
          { text: renderCheckPanel(outcome.panel).join('\n'), muted: false },
          { text: `記録: ${outcome.recordPath}`, muted: true },
        ];
    }
  } catch (error) {
    if (error instanceof JudgeUnavailableError) {
      return [{ text: JUDGE_UNAVAILABLE_AT_RUN, muted: true }];
    }
    const reason = briefReason(error);
    return [{
      text: `${CHECK_FAILED_PREFIX}${reason ? `（${reason}）` : ''}。記録はしていません。`,
      muted: true,
    }];
  }
}
