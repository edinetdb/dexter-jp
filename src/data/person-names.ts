/**
 * 人名検出（決定論、完璧な固有表現抽出ではない）。
 *
 * go-decision-v0.md §9.2 G-D1: demo 録画・自社ベンチの素材に個人名を含む段落を
 * 使わない。build 時にこの検査で引っかかったら fail する（D-2「Cabocia が自社の
 * 鍵で demo 録画・ベンチを回すとき、開示段落に役員氏名・大株主名が含まれる」への
 * 回避策 = 「素材を個人名を含まない段落に限定し、テストで固定する」）。
 *
 * 有報の文章でよく出る「個人名が現れる形」だけを決定論で拾う:
 *   - 役職に続く姓名（全角/半角スペース区切り）: 「代表取締役社長　山田　太郎」
 *   - 姓名 + 敬称: 「山田　太郎氏」「山田　太郎様」「山田　太郎君」
 *   - 「氏名」ラベルの行（役員名簿の断片が紛れ込んだ場合の目印）
 *
 * ★取りこぼしうる（完璧な NER ではない）。姓名の間にスペースが無い表記、
 * 役職を伴わない単独の姓名、外国人名のカタカナ表記、ひらがな表記の姓名などは
 * 拾えないことがある。これは一次防御であって唯一の防御ではない —
 * 実データを `src/data/materials/` に投入する前に人手でもレビューすること。
 */

const TITLES = [
  '代表取締役社長',
  '代表取締役会長',
  '代表取締役副社長',
  '代表取締役',
  '取締役会長',
  '取締役副社長',
  '取締役専務',
  '取締役常務',
  '社外取締役',
  '取締役',
  '執行役員',
  '執行役',
  '常務執行役員',
  '専務執行役員',
  '常勤監査役',
  '社外監査役',
  '監査役',
  '会長',
  '社長',
  '副社長',
  '専務',
  '常務',
  'CEO',
  'CFO',
  'COO',
  'CTO',
];

// 姓・名それぞれ 1〜4 文字（漢字 / ひらがな / カタカナ / 長音記号ー）、
// 間を全角スペース（U+3000）または半角スペースで区切る想定。
const NAME_CHAR = '[\\u4E00-\\u9FFF\\u3041-\\u3096\\u30A1-\\u30FA\\u30FC]';
const NAME_SEGMENT = `${NAME_CHAR}{1,4}`;
const NAME_PAIR = `${NAME_SEGMENT}[\\u3000 ]${NAME_SEGMENT}`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 長い順に並べてから alternation を組む。「取締役」が「取締役会長」より先に
// マッチすると、残った「会長」が次の NAME_PAIR に誤って取り込まれるため
// （正規表現の alternation は先勝ちで最長一致ではない）。
const titleAlternation = [...TITLES].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');

/** 役職 + 姓名。例: 「代表取締役社長　山田　太郎」「取締役 佐藤 花子」 */
const TITLE_NAME_RE = new RegExp(`(?:${titleAlternation})[\\u3000 ]?(${NAME_PAIR})`, 'g');

/** 姓名 + 敬称。例: 「山田　太郎氏」「山田 太郎様」「山田　太郎君」 */
const HONORIFIC_NAME_RE = new RegExp(`(${NAME_PAIR})(?:氏|様|君)`, 'g');

/** 役員名簿の断片が混入した目印（「氏名：」「氏名:」）。 */
const NAME_LABEL_RE = /氏名[　 ]*[:：]/;

export type PersonNamePattern = 'title_name' | 'honorific_name' | 'name_label';

export interface PersonNameMatch {
  pattern: PersonNamePattern;
  matchedText: string;
}

/** テキスト中の「個人名らしき表現」を全部返す。空配列なら検出なし。 */
export function detectPersonNames(text: string): PersonNameMatch[] {
  const matches: PersonNameMatch[] = [];

  for (const m of text.matchAll(TITLE_NAME_RE)) {
    matches.push({ pattern: 'title_name', matchedText: m[0] });
  }
  for (const m of text.matchAll(HONORIFIC_NAME_RE)) {
    matches.push({ pattern: 'honorific_name', matchedText: m[0] });
  }
  const labelMatch = text.match(NAME_LABEL_RE);
  if (labelMatch) {
    matches.push({ pattern: 'name_label', matchedText: labelMatch[0] });
  }

  return matches;
}

/** `detectPersonNames` の結果が 1 件でもあるか。 */
export function containsPersonName(text: string): boolean {
  return detectPersonNames(text).length > 0;
}
