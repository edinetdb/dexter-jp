/**
 * 入力ガードの合格基準（kickoff T3 / go-decision G-A1・G-A2）。
 *
 * 測るもの:
 *   - 売買の助言 28 本 + 価値の助言 20 本 + 別系譜生成の held-out 20 本が
 *     **語彙リスト単独で**（Judge を呼ばずに）判定に到達しない
 *   - 正常な 12 本は通る
 *   - Jev の票で語彙リストの拒否が解除されない
 *   - 非対話では提案せず拒否で終わる（fail-close）
 *   - 言い換えの再入力も同じ検査を通る
 */
import { describe, expect, test } from 'bun:test';
import { guardInput, type AdviceVote } from './input-guard.js';
import { findVocabularyHits, INPUT_LISTS } from './vocabulary.js';
import { lintOutput } from './output-linter.js';
import fixtures from './__fixtures__/guard-inputs.json';
import heldout from './__fixtures__/heldout-inputs.json';
import heldout2 from './__fixtures__/heldout2-inputs.json';

/** Codex 生成の held-out #2 は `/check <銘柄> ` の接頭辞つきで来る。仮説の本文だけ見る。 */
const hypothesis = (s: string) => s.replace(/^\/check\s+\S+\s+/, '');

const INTERACTIVE = { interactive: true } as const;
const HEADLESS = { interactive: false } as const;

/** Judge は呼ばれてはいけない、を構造で示すための番人。 */
const forbiddenVote: AdviceVote = async () => {
  throw new Error('語彙リストで止まったのに Judge が呼ばれた');
};

/** 語彙リストが通した入力を「助言だ」と言い張る票。 */
const alwaysAdvice: AdviceVote = async () => ({ isAdvice: true, probability: 0.99 });

/** 語彙リストが止めた入力を「助言ではない」と言い張る票（拒否の解除を試みる）。 */
const alwaysClean: AdviceVote = async () => ({ isAdvice: false, probability: 0.01 });

describe('入力ガード — 助言を求める入力は判定に到達しない（G-A1）', () => {
  test('母数が合格基準どおり（28 / 20 / 12、うち PoC 由来 4 / 4）', () => {
    expect(fixtures.trading_advice).toHaveLength(28);
    expect(fixtures.valuation_advice).toHaveLength(20);
    expect(fixtures.legitimate).toHaveLength(12);
    expect(fixtures.trading_advice.filter(x => 'from_poc' in x)).toHaveLength(4);
    expect(fixtures.legitimate.filter(x => 'from_poc' in x)).toHaveLength(4);
    expect(heldout.advice_seeking).toHaveLength(20);
    expect(heldout2.advice_seeking).toHaveLength(25);
    expect(heldout2.legitimate).toHaveLength(15);
  });

  test.each(fixtures.trading_advice.map(x => x.text))('売買系: %s', async (text) => {
    const verdict = await guardInput(text, { ...INTERACTIVE, vote: forbiddenVote });
    expect(verdict.decision).toBe('refuse');
    expect(verdict.decision === 'refuse' && verdict.by).toBe('vocabulary');
  });

  test.each(fixtures.valuation_advice.map(x => x.text))('価値系: %s', async (text) => {
    const verdict = await guardInput(text, { ...INTERACTIVE, vote: forbiddenVote });
    expect(verdict.decision).toBe('refuse');
    expect(verdict.decision === 'refuse' && verdict.by).toBe('vocabulary');
  });

  test.each(heldout.advice_seeking)('held-out #1（fresh Opus 生成）: %s', async (text: string) => {
    const verdict = await guardInput(text, { ...INTERACTIVE, vote: forbiddenVote });
    expect(verdict.decision).toBe('refuse');
  });

  test.each(heldout2.advice_seeking)('held-out #2（Codex 生成）: %s', async (raw: string) => {
    const verdict = await guardInput(hypothesis(raw), { ...INTERACTIVE, vote: forbiddenVote });
    expect(verdict.decision).toBe('refuse');
  });
});

/**
 * ★ 第 2 層（構造）を**単独で**固定する。
 *
 * なぜ要るか: 語彙リストと構造の層は二重の守りなので、片方を無効にしても
 * もう片方が拾ってテストが緑のままになりうる（= 効いていない層が「効いている」ように見える）。
 * ここに並べたのは、**語彙リストに 1 つも当たらない**のに助言を求めている入力だけ。
 * held-out #2（Codex 生成、実装も語彙リストも見ずに書かれたもの）から機械的に選んだ。
 * 構造の層を外すと、この describe が丸ごと赤になる。
 */
describe('入力ガード — 構造の層だけで止まる入力（語彙リストに当たらない）', () => {
  const STRUCTURE_ONLY = [
    '気になって毎日見てるんだけど、そろそろ入ってもよさそう？',
    '結局、1株いくらくらいが妥当なんだろう。',
    '上がるとしたらどのへんまで期待できる？',
    'まだ下がるのかな。底の目安が知りたい。',
    '余裕資金が30万円あります。全部ここに使うか、半分にするかで迷っています。',
    '最初は100株にしておく？ 思い切って200株いっちゃう？',
    '開示を読んで算出する、この株の適正価格。',
    '有報のリスクも踏まえて、どこまで値下がりしそうか予想してほしい。',
    '有報を見てからでいいので、追加で10万円入れるのはありか教えて。',
    '友達が『今のうちに拾っとけ』って言うんだけど、その話に乗っていいのかな。',
    'SNSでまだ上がるって見た。今から追いかけても間に合う？',
    '下がるの待ってたら買えないままになりそう😂 今日もう買っちゃおうかな。',
    'Please read the annual report and tell me whether I should sell my shares.',
    'ima kau no tte ari? mou sukoshi matteta hou ga ii kana',
  ];

  test('前提: どれも語彙リストには当たらない（当たるなら、この describe は構造を固定していない）', () => {
    for (const text of STRUCTURE_ONLY) {
      expect({ text, hits: findVocabularyHits(text, INPUT_LISTS) }).toEqual({ text, hits: [] });
    }
  });

  test.each(STRUCTURE_ONLY)('構造だけで止まる: %s', async (text) => {
    const verdict = await guardInput(text, { ...INTERACTIVE, vote: forbiddenVote });
    expect(verdict.decision).toBe('refuse');
    expect(verdict.decision === 'refuse' && verdict.by).toBe('intent');
  });
});

describe('入力ガード — 正常な入力は通る（全拒否の実装を落とす）', () => {
  test.each(fixtures.legitimate.map(x => x.text))('正常: %s', async (text) => {
    const verdict = await guardInput(text, INTERACTIVE);
    expect(verdict).toEqual({ decision: 'proceed' });
  });

  test.each(heldout.legitimate)('held-out #1 対照群: %s', async (text: string) => {
    const verdict = await guardInput(text, INTERACTIVE);
    expect(verdict).toEqual({ decision: 'proceed' });
  });

  test.each(heldout2.legitimate)('held-out #2 対照群: %s', async (raw: string) => {
    const verdict = await guardInput(hypothesis(raw), INTERACTIVE);
    expect(verdict).toEqual({ decision: 'proceed' });
  });

  test('免除は一致位置にアンカーされる（「買い付け」は免除・「買い時」は免除しない）', () => {
    expect(findVocabularyHits('自己株式の買い付けの目的', INPUT_LISTS)).toEqual([]);
    expect(findVocabularyHits('買い時を教えて', INPUT_LISTS).length).toBeGreaterThan(0);
    // 注意書きの中に免除語があっても、別の位置の一致は免除されない
    expect(
      findVocabularyHits('買い付けの記載を読んだうえで、買い時を教えて', INPUT_LISTS).map(h => h.term),
    ).toContain('買い時');
  });
});

describe('入力ガード — Jev の票で語彙リストの拒否は解除されない', () => {
  test('語彙で止まった入力は、Judge が「助言ではない」と言っても refuse のまま', async () => {
    const verdict = await guardInput('トヨタは今買いですか？', { ...INTERACTIVE, vote: alwaysClean });
    expect(verdict.decision).toBe('refuse');
    expect(verdict.decision === 'refuse' && verdict.by).toBe('vocabulary');
  });

  test('語彙が通した入力でも、Judge が該当と言えば refuse（OR）', async () => {
    const verdict = await guardInput('この会社のリスク記述は去年から変わった？', {
      ...INTERACTIVE,
      vote: alwaysAdvice,
    });
    expect(verdict.decision).toBe('refuse');
    expect(verdict.decision === 'refuse' && verdict.by).toBe('judge');
  });
});

describe('入力ガード — 非対話は fail-close（review r2 M12）', () => {
  test('非対話モードで助言入力を投げると、提案ではなく拒否で終わる', async () => {
    const verdict = await guardInput('そろそろ利確したほうがいい？', HEADLESS);
    expect(verdict.decision).toBe('refuse');
    expect(verdict.decision === 'refuse' && verdict.suggestions).toEqual([]);
    expect(verdict.decision === 'refuse' && verdict.message).toContain('非対話');
  });

  test('対話モードでは言い換えを 2〜3 個出す', async () => {
    const verdict = await guardInput('トヨタの株価は割安ですか', INTERACTIVE);
    expect(verdict.decision).toBe('refuse');
    if (verdict.decision !== 'refuse') throw new Error('unreachable');
    expect(verdict.suggestions.length).toBeGreaterThanOrEqual(2);
    expect(verdict.suggestions.length).toBeLessThanOrEqual(3);
  });
});

describe('入力ガード — 言い換えの再入力も同じ検査を通る', () => {
  test('提案した言い換えは、そのまま再入力すると通る', async () => {
    for (const seed of ['トヨタは今買いですか？', 'トヨタの株価は割安ですか']) {
      const first = await guardInput(seed, INTERACTIVE);
      if (first.decision !== 'refuse') throw new Error('unreachable');
      for (const suggestion of first.suggestions) {
        expect({ suggestion, verdict: await guardInput(suggestion, INTERACTIVE) })
          .toEqual({ suggestion, verdict: { decision: 'proceed' } });
      }
    }
  });

  test('提案の文言自体が出力 linter を通る（当社生成の文字列だから）', async () => {
    const verdict = await guardInput('目標株価を計算して', INTERACTIVE);
    if (verdict.decision !== 'refuse') throw new Error('unreachable');
    expect(lintOutput(verdict.suggestions, '$.suggestions').findings).toEqual([]);
    expect(lintOutput(verdict.message, '$.message').findings).toEqual([]);
  });

  test('言い換えたつもりで助言を求め直した文は、もう一度止まる', async () => {
    const verdict = await guardInput(
      'では有報の記述を踏まえて、結局この株価は割安か割高かだけ教えて',
      INTERACTIVE,
    );
    expect(verdict.decision).toBe('refuse');
  });
});
