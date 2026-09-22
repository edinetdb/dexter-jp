/**
 * `/check` のパネル（design §4.2・§6、go-decision G-A2 / G-A3 / G-A5 / G-A6）。
 */
import { describe, expect, test } from 'bun:test';
import { buildCheckPanel, renderCheckPanel, renderScopeLine, ESTIMATE_CAPTION, UNDETERMINED_TEXT } from './panel.js';
import { lintOutput } from '../guard/output-linter.js';
import type { Claim, Paragraph, ParagraphJudgment } from './core/index.js';

const COMPANY = { name: '株式会社ファーストリテイリング', edinetCode: 'E03217', secCode: '9983' };

function paragraph(id: string, text: string, over: Partial<Paragraph> = {}): Paragraph {
  return {
    id,
    docId: 'S100X6X6',
    company: COMPANY.name,
    edinetCode: COMPANY.edinetCode,
    filer: COMPANY.name,
    docType: '有価証券報告書',
    section: 'mda',
    fiscalYear: 2025,
    text,
    ...over,
  };
}

function claim(id: string, over: Partial<Claim> = {}): Claim {
  return {
    id,
    quote: '中国事業は回復している',
    text: 'ファーストリテイリングの FY2025 のグレーターチャイナ事業は回復している',
    negated: false,
    kind: 'qualitative',
    degreeWords: [],
    ...over,
  };
}

const P_SUPPORT = paragraph('p1', '当第４四半期連結会計期間の事業利益は、売上総利益率の改善により約11％増益となりました。');
const P_CONTRA = paragraph('p2', 'グレーターチャイナの売上収益は6,502億円（同4.0％減）、事業利益は899億円（同12.5％減）となりました。');

/** 有報の「事業等のリスク」に実際に出うる言い回し（架空の提出会社の合成文）。 */
const P_RISKY_WORDS = paragraph(
  'p3',
  '当社株式が市場において割高に評価された場合、資金調達の条件が悪化する可能性があります。' +
    'また、資本の配分方針の見直しが必要となる可能性があります。',
  { section: 'risks' },
);

function judged(pairs: [string, ParagraphJudgment['verdict'], number][]): ParagraphJudgment[] {
  return pairs.map(([paragraphId, verdict, confidence]) => ({ paragraphId, verdict, confidence }));
}

const BASE_SCOPE = { fiscalYear: 2025, sections: ['mda', 'risks', 'policy'], total: 132, unchecked: 0 };

describe('パネルに出るもの（kickoff T3）', () => {
  const panel = buildCheckPanel({
    hypothesis: '中国事業は回復していると会社は説明している',
    company: COMPANY,
    claims: [claim('c1')],
    paragraphs: [P_SUPPORT, P_CONTRA],
    judgments: new Map([['c1', judged([['p1', 'supports', 0.94]])]]),
    scope: BASE_SCOPE,
  });

  test('仮説の原文が逐語で載る（書き換えない）', () => {
    expect(panel.hypothesis).toEqual({
      kind: 'quote',
      text: '中国事業は回復していると会社は説明している',
      source: 'user',
    });
  });

  test('主張と、その元になった原文の該当箇所が両方出る', () => {
    expect(panel.claims[0].text).toContain('グレーターチャイナ');
    expect(panel.claims[0].quote.text).toBe('中国事業は回復している');
  });

  test('証拠に doc_id・提出者・書類種別・節・期が付く', () => {
    const e = panel.claims[0].supporting[0];
    expect(e.docId).toBe('S100X6X6');
    expect(e.filer).toBe(COMPANY.name);
    expect(e.docType).toBe('有価証券報告書');
    expect(e.section).toBe('mda');
    expect(e.fiscalYear).toBe(2025);
    expect(e.text.kind).toBe('quote');
  });

  test('検査した範囲と未検査数が出る', () => {
    expect(renderScopeLine(panel.scope)).toBe(
      '検査した範囲: 有価証券報告書 FY2025 MD&A・リスク・方針、132 段落中 132',
    );
  });

  test('★ 未検査があるときは 0 を返さず、範囲の行にも出る', () => {
    const p = buildCheckPanel({
      hypothesis: 'x',
      company: COMPANY,
      claims: [claim('c1')],
      paragraphs: [P_SUPPORT],
      judgments: new Map([['c1', judged([['p1', 'supports', 0.94]])]]),
      scope: { ...BASE_SCOPE, unchecked: 17 },
    });
    expect(p.scope.unchecked).toBe(17);
    expect(p.scope.examined).toBe(115);
    expect(renderScopeLine(p.scope)).toContain('（未検査 17）');
  });

  test('推定値の説明が G-A6 の逐語（「正しい確率」「支持率」「的中」を使わない）', () => {
    expect(panel.estimateCaption).toBe('この段落と主張の関係についてのモデルの推定');
    expect(lintOutput(ESTIMATE_CAPTION, '$.caption').findings).toEqual([]);
  });

  test('deep link 2 行が末尾に付く（4 桁コードがあるので TradingView + EDINET DB）', () => {
    expect(panel.links).toHaveLength(2);
    expect(panel.links[0].url).toBe('https://jp.tradingview.com/symbols/TSE-9983/');
    expect(panel.links[1].url).toContain('edinetdb.jp/companies/E03217');
  });

  test('4 桁コードが無ければ EDINET DB の 1 行だけ', () => {
    const p = buildCheckPanel({
      hypothesis: 'x',
      company: { name: 'X', edinetCode: 'E99999' },
      claims: [claim('c1')],
      paragraphs: [P_SUPPORT],
      judgments: new Map([['c1', judged([['p1', 'supports', 0.94]])]]),
      scope: BASE_SCOPE,
    });
    expect(p.links).toHaveLength(1);
  });
});

describe('★ 出力 linter の対（逐語は走査しない / 当社生成は走査する）', () => {
  test('引用ブロックに「割高」を含む有報段落を入れても緑', () => {
    const panel = buildCheckPanel({
      hypothesis: '株主還元の方針は前期から変わったか',
      company: COMPANY,
      claims: [claim('c1')],
      paragraphs: [P_RISKY_WORDS],
      judgments: new Map([['c1', judged([['p3', 'supports', 0.91]])]]),
      scope: BASE_SCOPE,
    });
    expect(panel.claims[0].supporting).toHaveLength(1);
    expect(lintOutput(panel, '$.panel').findings).toEqual([]);
  });

  test('同じ語を要約フィールドに入れると捨てられる（パネルは残る）', () => {
    const panel = buildCheckPanel({
      hypothesis: '株主還元の方針は前期から変わったか',
      company: COMPANY,
      claims: [claim('c1')],
      paragraphs: [P_RISKY_WORDS],
      judgments: new Map([['c1', judged([['p3', 'supports', 0.91]])]]),
      scope: BASE_SCOPE,
      summary: 'この会社の株式は割高に評価されていると読めます。',
    });
    expect(panel.summary).toBeNull();
    expect(panel.summaryDropped).toBe(true);
    expect(panel.claims[0].supporting).toHaveLength(1); // 証拠は捨てない
    expect(lintOutput(panel, '$.panel').findings).toEqual([]);
  });

  test('問題のない要約はそのまま載る', () => {
    const summary = '会社は中国事業の減収を、消費意欲の低下によるものと説明しています。';
    const panel = buildCheckPanel({
      hypothesis: 'x',
      company: COMPANY,
      claims: [claim('c1')],
      paragraphs: [P_SUPPORT],
      judgments: new Map([['c1', judged([['p1', 'supports', 0.94]])]]),
      scope: BASE_SCOPE,
      summary,
    });
    expect(panel.summary).toBe(summary);
    expect(panel.summaryDropped).toBe(false);
  });

  test('★ 主張の言い換えが linter に当たったら、主張ごと捨てずに利用者の原文へ落とす', () => {
    const panel = buildCheckPanel({
      hypothesis: '下値が堅いと会社は書いているか',
      company: COMPANY,
      claims: [claim('c1', { quote: '下値が堅いと会社は書いているか', text: 'この株は割安である' })],
      paragraphs: [P_SUPPORT],
      judgments: new Map([['c1', judged([['p1', 'supports', 0.94]])]]),
      scope: BASE_SCOPE,
    });
    expect(panel.claims[0].text).toBe('下値が堅いと会社は書いているか'); // 原文に落ちた
    expect(panel.claims[0].supporting).toHaveLength(1); // 証拠は残る
    expect(lintOutput(panel, '$.panel').findings).toEqual([]);
  });
});

describe('判定不能（G-A3）— モデルに埋めさせない', () => {
  test('★ 証拠 0 件なら判定不能', () => {
    const panel = buildCheckPanel({
      hypothesis: 'x',
      company: COMPANY,
      claims: [claim('c1')],
      paragraphs: [],
      judgments: new Map([['c1', []]]),
      scope: { ...BASE_SCOPE, total: 0 },
    });
    expect(panel.undetermined).toBe(true);
    expect(panel.undeterminedText).toBe(UNDETERMINED_TEXT);
  });

  test('★ 全部が閾値未満なら判定不能（確定した段落が 0）', () => {
    const panel = buildCheckPanel({
      hypothesis: 'x',
      company: COMPANY,
      claims: [claim('c1')],
      paragraphs: [P_SUPPORT, P_CONTRA],
      judgments: new Map([['c1', judged([['p1', 'supports', 0.62], ['p2', 'contradicts', 0.55]])]]),
      scope: BASE_SCOPE,
    });
    expect(panel.undetermined).toBe(true);
    expect(panel.claims[0].status).toBe('unresolved');
  });

  test('★ 判定不能のときは要約を出さない（モデルが埋める余地を作らない）', () => {
    const panel = buildCheckPanel({
      hypothesis: 'x',
      company: COMPANY,
      claims: [claim('c1')],
      paragraphs: [],
      judgments: new Map([['c1', []]]),
      scope: { ...BASE_SCOPE, total: 0 },
      summary: 'おそらく回復しているのでしょう。',
    });
    expect(panel.summary).toBeNull();
  });

  test('数値の検算だけ確定していれば判定不能にしない', () => {
    const panel = buildCheckPanel({
      hypothesis: 'x',
      company: COMPANY,
      claims: [claim('c1')],
      paragraphs: [P_SUPPORT],
      judgments: new Map([['c1', judged([['p1', 'supports', 0.4]])]]),
      numeric: new Map([['c1', { result: 'match', claimId: 'c1' }]]),
      scope: BASE_SCOPE,
    });
    expect(panel.undetermined).toBe(false);
  });
});

describe('仕分け', () => {
  test('裏付けだけなら supports', () => {
    const p = buildCheckPanel({
      hypothesis: 'x', company: COMPANY, claims: [claim('c1')], paragraphs: [P_SUPPORT],
      judgments: new Map([['c1', judged([['p1', 'supports', 0.94]])]]), scope: BASE_SCOPE,
    });
    expect(p.claims[0].status).toBe('supports');
  });

  test('両方確定したら split（割れている）= どちらか一方に寄せない', () => {
    const p = buildCheckPanel({
      hypothesis: 'x', company: COMPANY, claims: [claim('c1')], paragraphs: [P_SUPPORT, P_CONTRA],
      judgments: new Map([['c1', judged([['p1', 'supports', 0.94], ['p2', 'contradicts', 0.9]])]]),
      scope: BASE_SCOPE,
    });
    expect(p.claims[0].status).toBe('split');
    expect(p.claims[0].supporting).toHaveLength(1);
    expect(p.claims[0].contradicting).toHaveLength(1);
  });

  test('否定つきの主張は結果が反転する（コードが反転、判定は肯定形）', () => {
    const p = buildCheckPanel({
      hypothesis: 'x', company: COMPANY, claims: [claim('c1', { negated: true })], paragraphs: [P_SUPPORT],
      judgments: new Map([['c1', judged([['p1', 'supports', 0.94]])]]), scope: BASE_SCOPE,
    });
    expect(p.claims[0].status).toBe('contradicts');
  });

  test('分解の時点で未判定なら not_judged（理由つき）', () => {
    const p = buildCheckPanel({
      hypothesis: 'x', company: COMPANY,
      claims: [claim('c1', { unresolvable: { reason: 'exclusivity_unconfirmed' } })],
      paragraphs: [P_SUPPORT],
      judgments: new Map([['c1', judged([['p1', 'supports', 0.94]])]]), scope: BASE_SCOPE,
    });
    expect(p.claims[0].status).toBe('not_judged');
    expect(p.claims[0].notJudgedReason).toContain('それ以外は寄与していない');
  });
});

describe('端末への表示', () => {
  const panel = buildCheckPanel({
    hypothesis: '中国事業は回復していると会社は説明している',
    company: COMPANY,
    claims: [claim('c1')],
    paragraphs: [P_SUPPORT, P_RISKY_WORDS],
    judgments: new Map([['c1', judged([['p1', 'supports', 0.94], ['p3', 'contradicts', 0.88]])]]),
    scope: { ...BASE_SCOPE, unchecked: 3 },
    footer: { requests: 132, elapsedMs: 8400 },
  });
  const text = renderCheckPanel(panel).join('\n');

  test('原文・主張・出典・検査範囲・推定の説明・deep link が全部出る', () => {
    expect(text).toContain('仮説: 中国事業は回復していると会社は説明している');
    expect(text).toContain('もとの言葉: 中国事業は回復している');
    expect(text).toContain('S100X6X6');
    expect(text).toContain('132 段落中 129（未検査 3）');
    expect(text).toContain('この段落と主張の関係についてのモデルの推定');
    expect(text).toContain('https://jp.tradingview.com/symbols/TSE-9983/');
  });

  test('★ 逐語の中の「割高」は表示に出る（証拠を捨てない）', () => {
    expect(text).toContain('割高に評価された場合');
  });

  test('★ それでも当社生成の行だけを見れば linter は緑', () => {
    // 逐語の行（段落の本文）を除いた行 = 当社が組み立てた行だけを検査する
    const ours = renderCheckPanel(panel).filter(
      l => !panel.claims.some(c => [...c.supporting, ...c.contradicting].some(e => l.includes(e.text.text))),
    );
    expect(lintOutput(ours, '$.rendered').findings).toEqual([]);
  });

  test('判定不能のときはその行が先に出る', () => {
    const p = buildCheckPanel({
      hypothesis: 'x', company: COMPANY, claims: [claim('c1')], paragraphs: [],
      judgments: new Map([['c1', []]]), scope: { ...BASE_SCOPE, total: 0 },
    });
    expect(renderCheckPanel(p)[3]).toBe(UNDETERMINED_TEXT);
  });
});
