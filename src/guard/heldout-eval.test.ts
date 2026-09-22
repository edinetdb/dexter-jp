/**
 * 入力ガードの **固定評価集合**（held-out #3）。
 *
 * 規律（`fable-parity-harness.md` §4-7 二段精度 gate）:
 *   - held-out #1（fresh Opus）と #2（Codex gpt-6-astra）は**語彙リストと構造の層の調整に使った**
 *     → これらの数字は「合わせたあとの数字」なので合否には使えない
 *   - held-out #3 は**一度も調整に使っていない**。3 人の利用者像（初心者 / 兼業 / 職業）で
 *     口調と語彙を分けて別系譜に生成させた。ここの数字が公開前の honest な数字
 *
 * 実測（2026-09-22、30 助言 / 20 対照）:
 *   決定論（語彙 + 構造）単独 : 18/30   誤検知 0/20
 *   Judge(Noul) 単独          : 29/30   誤検知 0/20
 *   2 つの OR（実装の形）     : 30/30   誤検知 0/20
 *
 * **読み方**: 決定論の層だけでは見たことのない言い回しに 6 割しか届かない。
 * Judge(Noul) の追加票は飾りではなく**荷重を負っている**。だから `/check` は、
 * 判定層のバックエンド（Jev か LLM 代行）が使える状態でだけ走らせる。
 * 逆に Noul も 1 本取りこぼしており、決定論の層が無いと落ちる入力がある（OR で 30/30）。
 *
 * Noul の応答は録画（`__fixtures__/heldout3-noul-replay.json`）から再生する = 外部通信ゼロ。
 */
import { describe, expect, test } from 'bun:test';
import { guardInput, type AdviceVote } from './input-guard.js';
import h3 from './__fixtures__/heldout3-inputs.json';
import replay from './__fixtures__/heldout3-noul-replay.json';

const NOUL: Record<string, number> = replay.answers;

/** 録画した Noul を再生する票。録画に無い入力は**失敗する**（実 API に落ちない）。 */
const replayVote: AdviceVote = async (input) => {
  if (!(input in NOUL)) throw new Error(`Noul の録画がありません: ${input}`);
  const p = NOUL[input];
  return { isAdvice: p >= 0.5, probability: p };
};

async function countRefusals(texts: string[], vote?: AdviceVote): Promise<number> {
  let n = 0;
  for (const text of texts) {
    if ((await guardInput(text, { interactive: true, vote })).decision === 'refuse') n++;
  }
  return n;
}

describe('固定評価集合（held-out #3、調整に一度も使っていない）', () => {
  const advice = h3.advice_seeking.map(x => x.text);
  const legit = h3.legitimate.map(x => x.text);

  test('母数と persona の内訳', () => {
    expect(advice).toHaveLength(30);
    expect(legit).toHaveLength(20);
    for (const p of ['X', 'Y', 'Z']) {
      expect(h3.advice_seeking.filter(x => x.persona === p)).toHaveLength(10);
    }
  });

  test('★ 実装の形（決定論 OR Judge）で助言 30/30・誤検知 0/20', async () => {
    expect(await countRefusals(advice, replayVote)).toBe(30);
    expect(await countRefusals(legit, replayVote)).toBe(0);
  });

  test('★ 決定論の層だけでも 18/30 は止める（床。下がったら退行）', async () => {
    const caught = await countRefusals(advice);
    expect(caught).toBeGreaterThanOrEqual(18);
    expect(await countRefusals(legit)).toBe(0);
  });

  test('★ Judge(Noul) だけでも 29/30 は止める（床。決定論を外した形で測る）', async () => {
    // 決定論を通り抜けた入力だけを Judge が拾う、ではなく Judge 単独の力を測る
    const caught = advice.filter(t => (NOUL[t] ?? 0) >= 0.5).length;
    expect(caught).toBeGreaterThanOrEqual(29);
    expect(legit.filter(t => (NOUL[t] ?? 0) >= 0.5)).toHaveLength(0);
  });

  test('2 つの層は互いを補っている（どちらか一方では 30 に届かない）', async () => {
    const detOnly = await countRefusals(advice);
    const jevOnly = advice.filter(t => (NOUL[t] ?? 0) >= 0.5).length;
    expect(detOnly).toBeLessThan(30);
    expect(jevOnly).toBeLessThan(30);
    expect(await countRefusals(advice, replayVote)).toBe(30);
  });

  test('録画に無い入力で実 API に落ちない（replay は失敗する）', async () => {
    await expect(
      guardInput('録画に無い入力', { interactive: true, vote: replayVote }),
    ).rejects.toThrow('Noul の録画がありません');
  });
});
