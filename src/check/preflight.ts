/**
 * `/check` を走らせてよいかの事前判定。
 *
 * ## なぜ判定層を要求するか（実測、2026-09-22）
 * 入力ガードは「決定論の語彙 + 構造」と「判定層の追加票」の 2 層で、**どちらか一方では足りない**。
 * 調整に一度も使っていない固定評価集合（別系譜が実装も語彙リストも見ずに生成した
 * 助言 30 / 対照 20）での実測:
 *
 * | 層 | 助言の見逃し | 対照群の誤検知 |
 * |---|---|---|
 * | 決定論（語彙 + 構造）単独 | 12/30 | 0/20 |
 * | Jev(Noul) 単独 | 1/30 | 0/20 |
 * | 決定論 OR Jev（実装の形） | **0/30** | 0/20 |
 * | 決定論 OR **LLM 代行**（ZGX Qwen3-VL-32B） | **8/30** | 0/20 |
 *
 * LLM 代行の票は見逃し 13/30（単独）で、決定論と OR にしても 8/30 が素通りする。
 * 「どちらの層も助言を素通りさせる」構成で `/check` を出すと、README の
 * 「売買の指示・目標株価・建玉の大きさは出力しません」と実態が食い違う（go-decision E-5）。
 *
 * だから **判定層が Jev（または Jev の録画）でないときは `/check` を走らせない**
 * （小池裁定 B、親 = ED グロース HQ 第22代 経由、2026-09-22）。
 * LLM 代行は分解・要約・段落化には使う。入口ガードの票には使わない。
 *
 * 鍵なしの初回体験は `bun run demo`（録画の再生）が担う。
 */
import { resolveJudgeBackend } from '../judge/index.js';
import type { JudgeBackend } from '../judge/index.js';

/** 入口ガードの票に使ってよいバックエンド。`llm` は**入っていない**。 */
export const VOTE_CAPABLE_BACKENDS = ['jev', 'replay'] as const;

export type CheckPreflight =
  | { ok: true; backend: JudgeBackend }
  | { ok: false; reason: 'no_vote_capable_judge'; backendName: string; message: string };

const GUIDANCE = [
  '/check は判定層（TypeSafe の Jev）が使えるときだけ走ります。',
  '',
  '  .env に TYPESAFE_API_KEY を足してください。',
  '  鍵なしで動きを見るだけなら: bun run demo（録画の再生。外部通信はありません）',
  '',
  'なぜ鍵が要るか: /check の入口は、売買や株価の水準についての助言を求める入力を',
  '判定に進めない検査を通ります。この検査は決定論の語彙・構造の検査と判定層の票の',
  '2 つで成り立っていて、手元の LLM にラベルだけ代行させる構成では',
  '固定評価集合 30 本のうち 8 本を取りこぼすことが実測で分かっています。',
  '取りこぼしたまま動かすより、止まる方を選んでいます。',
].join('\n');

/**
 * `/check` の事前判定。
 *
 * @param backend テスト・呼び出し側での明示指定。省略時は env から選ぶ
 */
export function preflightCheck(backend?: JudgeBackend): CheckPreflight {
  const resolved = backend ?? resolveJudgeBackend();
  if ((VOTE_CAPABLE_BACKENDS as readonly string[]).includes(resolved.name)) {
    return { ok: true, backend: resolved };
  }
  return {
    ok: false,
    reason: 'no_vote_capable_judge',
    backendName: resolved.name,
    message: GUIDANCE,
  };
}
