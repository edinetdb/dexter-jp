#!/usr/bin/env bun
/**
 * `bun run demo` — 録画した `/check` を再生する。
 *
 * **鍵は要らない。外部通信もしない。** 判定層は録画の再生、開示と LLM の応答も
 * 同梱の録画から読む。画面に「録画の再生」と明示する（実走と取り違えないため）。
 *
 * ここが `/check` の初回体験を担う: 判定層（TypeSafe の Jev）の鍵が無いと `/check` は
 * 走らないので（固定評価集合で LLM 代行の票が助言 30 本中 8 本を取りこぼすため）、
 * 鍵を入れる前に何が返るかはここで見てもらう。
 *
 * 録画 = `src/check/__demo__/`。中身は有価証券報告書の逐語と、その段落に対する判定の記録。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runCheck, renderCheckPanel, type CheckPorts, type DisclosureSource } from '../src/check/index.js';
import type { JudgeBackend } from '../src/judge/index.js';
import { judgeQuestionHash } from '../src/judge/hash.js';

const DEMO_DIR = join(import.meta.dir, '..', 'src', 'check', '__demo__');

interface DemoRecording {
  hypothesis: string;
  ticker: string;
  disclosure: DisclosureSource;
  claims: { quote: string; text: string; negated?: boolean; company?: string; period?: string }[];
  /** 段落 ID → 主張 ID → 判定 */
  judgments: Record<string, Record<string, { choice: string; confidence: number }>>;
  /** 入口ガードの票 */
  adviceNoul: number;
  /** 判定を録ったときの Jev のモデル名（ハッシュの一部） */
  model?: string;
  /**
   * 段落 ID → 主張 ID → 録画したときに実際に投げた問いのハッシュ（state + instructions + criteria + model）。
   * 再生時に今のコードが組み立てた問いと照合し、違えば**失敗する**（Codex T9 r3 M1）。
   * 問いの形を変えたのに録画を取り直さないと、出荷するコードが出さない判定を demo が見せてしまう。
   */
  requestHashes?: Record<string, Record<string, string>>;
  summary: string | null;
}

export function loadRecording(dir = DEMO_DIR): DemoRecording {
  return JSON.parse(readFileSync(join(dir, 'check-recording.json'), 'utf-8')) as DemoRecording;
}

/** 録画から判定層を作る。録画に無いものを聞かれたら**失敗する**（実 API に落ちない）。 */
export function recordedBackend(rec: DemoRecording, mismatches: string[] = []): JudgeBackend {
  return {
    name: 'replay',
    call: async (request) => {
      if (request.key === 'guard') {
        return {
          answers: {
            advice: {
              type: 'noul',
              backend: 'jev',
              noul: rec.adviceNoul,
              probabilities: { true: rec.adviceNoul, false: 1 - rec.adviceNoul },
            },
          },
          inputTokens: 0,
        };
      }
      const perClaim = rec.judgments[request.key];
      if (!perClaim) throw new Error(`録画がありません: 段落 ${request.key}`);
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((q) => {
            const judged = perClaim[q];
            // 録画に無い主張を聞かれたら**失敗させる**（作り物の答えを返さない）
            if (!judged) {
              return [q, { error: `録画がありません: ${request.key}/${q}`, code: 'replay_miss' as const }];
            }
            const question = request.questions[q];
            const expected = rec.requestHashes?.[request.key]?.[q];
            const actual = judgeQuestionHash({
              state: request.state,
              instructions: question.instructions,
              criteria: question.criteria,
              model: rec.model ?? '',
            });
            if (!expected || expected !== actual) {
              // runJudgeBatch は判定層の例外を問いごとのエラーに変えて吸収するので、ここで記録して runDemo が止める
              mismatches.push(`${request.key}/${q}`);
              throw new Error(`録画の問いと今の問いが一致しません: ${request.key}/${q}（録画を取り直してください）`);
            }
            return [
              q,
              {
                type: 'choice' as const,
                backend: 'jev' as const,
                choice: judged.choice,
                confidence: judged.confidence,
                probabilities: { [judged.choice]: judged.confidence, other: 1 - judged.confidence },
              },
            ];
          }),
        ),
        inputTokens: 0,
      };
    },
  };
}

export function recordedPorts(rec: DemoRecording, recordDir: string, mismatches: string[] = []): CheckPorts {
  return {
    judge: recordedBackend(rec, mismatches),
    decompose: async () => rec.claims,
    fetchDisclosure: async () => rec.disclosure,
    summarize: async () => rec.summary,
    recordDir,
  };
}

export async function runDemo(rec: DemoRecording = loadRecording()): Promise<string[]> {
  const recordDir = mkdtempSync(join(tmpdir(), 'dexter-demo-'));
  try {
    const mismatches: string[] = [];
    const outcome = await runCheck(rec.ticker, rec.hypothesis, recordedPorts(rec, recordDir, mismatches));
    if (mismatches.length > 0) {
      throw new Error(`録画の問いと今の問いが一致しません（${mismatches.length} 問、例: ${mismatches[0]}）。録画を取り直してください`);
    }
    if (outcome.kind !== 'panel') {
      throw new Error(`録画の再生が panel になりませんでした: ${outcome.kind}`);
    }
    return [
      '━━━ 録画の再生 ━━━',
      'これは記録済みの実行を再生したものです。鍵は使っていません。外部への通信もありません。',
      `コマンド: /check ${rec.ticker} ${rec.hypothesis}`,
      '',
      ...renderCheckPanel(outcome.panel),
      '',
      '━━━ ここまで録画 ━━━',
      '自分の仮説で回すには、.env に EDINETDB_API_KEY と TYPESAFE_API_KEY を入れてください。',
    ];
  } finally {
    rmSync(recordDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  console.log((await runDemo()).join('\n'));
}
