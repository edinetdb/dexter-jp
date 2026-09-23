/**
 * 出力側 linter の合格基準（go-decision G-A2 / G-A4 / G-A5 / G-A6）。
 *
 * 芯は ★ の**対**: 同じ語を「逐語引用」に入れたら緑、「当社の要約」に入れたら赤。
 * この対が無いと、①パネル全体を走査して証拠段落を捨てる実装 ②逐語を裁量で除外する実装
 * のどちらも通ってしまう（review r2 H3）。
 */
import { describe, expect, test } from 'bun:test';
import { lintOutput, quote, acceptSummary, assertOutputClean } from './output-linter.js';

/**
 * 有報の「事業等のリスク」に実際に出うる言い回しを含む段落。
 * **架空の提出会社**の文として書いた合成テキスト（実在企業の開示を騙らないため）。
 * 目的は「逐語引用の中に禁止語があっても捨てない」ことの確認だけなので、
 * 出所の正しさではなく語の出現だけが要る。
 */
const QUOTED_PARAGRAPH =
  '当社株式が市場において割高に評価された場合、その後の株価の下落により、' +
  '資金調達の条件が悪化する可能性があります。また、当社は資本の配分方針を定めていますが、' +
  '想定を超える下値の変動が生じた場合には、当該方針の見直しが必要となる可能性があります。';

describe('出力 linter — ★ 対（逐語は走査しない / 当社生成は走査する）', () => {
  test('引用ブロックに「割高」を含む有報段落を入れても緑', () => {
    const panel = {
      heading: '検査した範囲: 有価証券報告書 FY2026 事業等のリスク',
      evidence: [quote(QUOTED_PARAGRAPH, { doc_id: 'S100TEST', source: 'edinet' })],
    };
    expect(lintOutput(panel, '$.panel')).toEqual({ clean: true, findings: [] });
  });

  test('同じ語を要約フィールドに入れると赤', () => {
    const panel = {
      heading: '検査した範囲: 有価証券報告書 FY2026 事業等のリスク',
      summary: 'この会社の株式は割高に評価されていると読めます。',
      evidence: [quote(QUOTED_PARAGRAPH, { doc_id: 'S100TEST', source: 'edinet' })],
    };
    const result = lintOutput(panel, '$.panel');
    expect(result.clean).toBe(false);
    expect(result.findings.map(f => f.term)).toContain('割高');
    // 赤の理由が「要約」であって「引用」ではないことまで確かめる
    expect(result.findings.every(f => f.path.includes('summary'))).toBe(true);
  });

  test('逐語を quote() で包まずに素の文字列で流すと赤（包み忘れを検出する）', () => {
    const wrapped = { evidence: [quote(QUOTED_PARAGRAPH)] };
    const unwrapped = { evidence: [{ text: QUOTED_PARAGRAPH }] };
    expect(lintOutput(wrapped).clean).toBe(true);
    expect(lintOutput(unwrapped).clean).toBe(false);
  });
});

describe('出力 linter — 何を見るか', () => {
  test('局面ラベルは当社生成なら赤（G-A5）', () => {
    expect(lintOutput({ label: '上昇基調' }).clean).toBe(false);
    expect(lintOutput({ label: '高値圏で推移' }).clean).toBe(false);
  });

  test('upstream の severity / critical / importance を通すと赤（G-A4・review r2 M10）', () => {
    expect(lintOutput({ record: { severity: 'critical' } }).clean).toBe(false);
    expect(lintOutput({ heading: '重要度: 高' }).clean).toBe(false);
    expect(lintOutput({ note: 'Importance score 3' }).clean).toBe(false);
  });

  test('確率の言い換えを間違えると赤（G-A6）', () => {
    expect(lintOutput({ caption: '仮説が正しい確率' }).clean).toBe(false);
    expect(lintOutput({ caption: '支持率 78%' }).clean).toBe(false);
    expect(lintOutput({ caption: 'この段落と主張の関係についてのモデルの推定' }).clean).toBe(true);
  });

  test('4 群の名前（design §5 の逐語）は緑', () => {
    const groups = [
      '経過・完了の報告',
      '組織・人事・軽微な取引',
      '業績予想・配当・自己株式・特別損益などの決定',
      '支配・上場・存続に関わる事項',
    ];
    expect(lintOutput(groups, '$.groups')).toEqual({ clean: true, findings: [] });
  });

  test('入れ子の配列・オブジェクトを最後まで降りる', () => {
    const deep = { a: [{ b: { c: ['問題なし', { d: '押し目' }] } }] };
    const result = lintOutput(deep);
    expect(result.clean).toBe(false);
    expect(result.findings[0].path).toBe('$.a[0].b.c[1].d');
  });
});

describe('出力 linter — 要約を捨てる（design §4.2）', () => {
  test('禁止語のある要約は捨て、理由を返す', () => {
    const got = acceptSummary('割安に見えます');
    expect(got.accepted).toBeNull();
    expect('droppedBecause' in got && got.droppedBecause.length).toBeGreaterThan(0);
  });

  test('問題のない要約はそのまま通す', () => {
    const text = '会社は中国事業の減収を、消費意欲の低下によるものと説明しています。';
    expect(acceptSummary(text)).toEqual({ accepted: text });
  });
});

describe('出力 linter — assert は投げる', () => {
  test('当社生成に禁止語があると投げる', () => {
    expect(() => assertOutputClean({ summary: '目標株価は…' }, 'panel')).toThrow();
  });
  test('逐語だけなら投げない', () => {
    expect(() => assertOutputClean({ evidence: [quote(QUOTED_PARAGRAPH)] }, 'panel')).not.toThrow();
  });
});
