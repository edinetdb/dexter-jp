import { describe, expect, test } from 'bun:test';
import { containsPersonName, detectPersonNames } from './person-names.js';
import valid from './__fixtures__/valid.json';
import validArray from './__fixtures__/valid-array.json';
import personName from './__fixtures__/person-name.json';

describe('detectPersonNames — 役職 + 姓名', () => {
  test('「代表取締役社長　山田　太郎」を検出する', () => {
    const matches = detectPersonNames('代表取締役社長　山田　太郎は次のとおり説明しました。');
    expect(matches.some((m) => m.pattern === 'title_name')).toBe(true);
  });

  test('半角スペース区切りの「取締役 佐藤 花子」も検出する', () => {
    const matches = detectPersonNames('取締役 佐藤 花子が説明した。');
    expect(matches.some((m) => m.pattern === 'title_name')).toBe(true);
  });

  test('★ 変異: 人名を含む段落を fixture として使うと検出される（G-D1 が build を落とす対象）', () => {
    expect(containsPersonName((personName as { text: string }).text)).toBe(true);
  });
});

describe('detectPersonNames — 姓名 + 敬称', () => {
  test('「山田　太郎氏」を検出する', () => {
    const matches = detectPersonNames('山田　太郎氏のコメントを引用します。');
    expect(matches.some((m) => m.pattern === 'honorific_name')).toBe(true);
  });

  test('「山田 太郎様」を検出する', () => {
    expect(containsPersonName('山田 太郎様へのインタビューより。')).toBe(true);
  });
});

describe('detectPersonNames — 氏名ラベル', () => {
  test('「氏名：」ラベルの行を検出する', () => {
    const matches = detectPersonNames('役員の状況\n氏名：山田太郎\n生年月日：省略');
    expect(matches.some((m) => m.pattern === 'name_label')).toBe(true);
  });
});

describe('detectPersonNames — 陰性対照（実際の有報 MD&A・リスク文には人名は出ない）', () => {
  test('valid fixture の text は検出 0 件', () => {
    expect(containsPersonName((valid as { text: string }).text)).toBe(false);
  });

  test('valid-array fixture の text は全件検出 0 件', () => {
    for (const item of validArray as { text: string }[]) {
      expect(containsPersonName(item.text)).toBe(false);
    }
  });

  test('財務・リスクの一般的な文言だけでは誤検知しない', () => {
    const text =
      '当連結会計年度における取締役会は、事業ポートフォリオの見直しについて審議しました。' +
      '為替の変動、原材料価格の上昇、金融市場の低迷などのリスク要因があります。';
    expect(containsPersonName(text)).toBe(false);
  });
});

describe('detectPersonNames — 複合役職の重複（alternation の先勝ち対策）', () => {
  test('「取締役会長」は「取締役」の途中一致で崩れない', () => {
    const matches = detectPersonNames('取締役会長　山田　太郎は次のとおり説明しました。');
    const titleMatch = matches.find((m) => m.pattern === 'title_name');
    expect(titleMatch).toBeDefined();
    // 「会長　山田」ではなく「取締役会長　山田　太郎」の全体で一致していること
    expect(titleMatch?.matchedText.startsWith('取締役会長')).toBe(true);
  });
});

describe('★取りこぼしうることの明示（完璧な NER ではない）', () => {
  test('姓名の間にスペースが無い表記は検出できない（既知の限界）', () => {
    // 「代表取締役社長山田太郎」のようにスペースが無いと NAME_PAIR のパターンに一致しない。
    // この検出は一次防御であって唯一の防御ではない（person-names.ts のコメント参照）。
    expect(containsPersonName('代表取締役社長山田太郎は説明しました。')).toBe(false);
  });
});
