/**
 * 語彙リスト（決定論・fail-close）。
 *
 * 正本 = design-v0.md §4.2「ガード」/ go-decision-v0.md §9.2 G-A1・G-A5・G-A4。
 * 一次のガードはこの決定論のリストで、Jev(Noul) は**追加票**（OR）。Jev の票で
 * ここの拒否は解除しない（jev-review §3-B）。
 *
 * 2 つの面で使う:
 *   入力 (INPUT_*)  — 利用者の入力が「売買の助言」「価値の助言」を求めていたら判定に進めない
 *   出力 (OUTPUT_*) — 当社が生成した文字列に、売買系・価値系・局面ラベル・重要度の語が出ない
 *
 * 出力側の対象は **当社が生成した文字列だけ**（見出し・群名・ラベル・件数文・LLM の要約・
 * 記録 JSON の当社生成フィールド）。有報の逐語引用と upstream の開示タイトルは
 * `{kind:'quote'}` で持ち、走査しない（有報の原文には「割高」「下値」「配分」が普通に出る
 * = 芯の証拠段落を捨てないため。review r2 H3）。
 */

/** 売買の助言を求める語（go-decision G-A1 の前半 + design §4.2）。 */
export const TRADING_TERMS: readonly string[] = [
  // 名詞・定型
  '買い', '売り', '買い時', '売り時', '利確', '損切り', '利食い',
  '何株', '何株ずつ', '配分', 'ポートフォリオ', 'おすすめ銘柄', '推奨銘柄',
  'ナンピン', '塩漬け', '打診買い', '全力買い', '空売り', '信用買い',
  'エントリー', '指値', '逆指値', '成行', '配当狙い', '売却タイミング',
  '売却のタイミング', '買いタイミング', '買うタイミング',
  // 活用形をまたぐ語幹（「仕込む / 仕込み / 仕込んだ」「手放す / 手放し / 手放した」）
  '仕込', '手放', '買い増', '買増',
  // 「買って / 買った / 売って / 売った」（「買収」「売上」「売却」には一致しない）
  '買って', '買った', '買っと', '売って', '売った',
  // 助言を求める言い回し
  '買うべき', '売るべき', '持つべき', '買うなら', '売るなら', '買っていい',
  '売っていい', '入るべき', '入っていい', '入るタイミング', '振り分け',
  'どっちを買', 'どれを買',
  // 英語（多語で置く。単独の buy / sell は buyback 等に当たるため使わない）
  'should i buy', 'should i sell', 'buy or sell', 'worth buying', 'worth selling',
  'stop loss', 'take profit', 'position size', 'how many shares',
  'good entry', 'entry point', 'wait for a dip', 'buy the dip', 'average down',
  // ローマ字（日本語側に誤爆しない）
  'kaidoki', 'urandoki', 'uridoki', 'songiri', 'rikaku', 'nanpin', 'kaimashi',
];

/** 価値の助言を求める語（go-decision G-A1 の後半 = 本条件の追加分）。 */
export const VALUATION_TERMS: readonly string[] = [
  // 名詞・定型
  '割安', '割高', '妥当株価', '目標株価', '理論株価', 'フェアバリュー',
  '上昇余地', '下落余地', '下値目途', '下値めど', '上値目途', '上値めど',
  '適正株価', '株価水準', '過小評価', '過大評価',
  'アップサイド', 'ダウンサイド', '値ごろ', 'バリュエーション',
  // 助詞をはさむ形（「適正な株価」「妥当な株価」は「適正株価」に一致しない）
  '適正な株価', '妥当な株価', '適正な水準', '妥当な水準', '正しい株価',
  // 「安い / 高い」は単独では広すぎるので、株価・水準・値段の文脈に束ねる
  '株価は安い', '株価は高い', '株価が安い', '株価が高い',
  '水準は安い', '水準は高い', '水準が安い', '水準が高い',
  'この水準は', '今の水準は', '値段は高い', '値段は安い', '高すぎ', '安すぎ',
  // 到達点を尋ねる形
  'どこまで上が', 'どこまで下が', 'どこまで伸び', 'どこまで落ち',
  'いくらまで上が', 'いくらまで下が',
  // 英語
  'fair value', 'target price', 'price target', 'undervalued', 'overvalued',
  'upside', 'downside', 'at this price', 'too expensive', 'too cheap',
  // ローマ字
  'warayasu', 'takasugi', 'yasusugi', 'wariyasu', 'waridaka',
];

/** 局面ラベル（go-decision G-A5。design §2 案 C の捨て方に残っていた余地を閉じる）。 */
export const REGIME_TERMS: readonly string[] = [
  '上昇基調', '下降基調', '高値圏', '安値圏', '押し目', '天井圏', '底値圏',
  '上昇トレンド', '下降トレンド', '調整局面',
];

/** 「投資上の重要度」に読まれる語（go-decision G-A4）。upstream の英語 enum を含む（r2 M10）。 */
export const IMPORTANCE_TERMS: readonly string[] = [
  '重要度', '注目', '狙い目', '好材料', '悪材料',
  'severity', 'critical', 'importance',
];

/** 確率の表示で使ってはいけない語（go-decision G-A6）。 */
export const PROBABILITY_MISNOMERS: readonly string[] = [
  '正しい確率', '支持率', '的中',
];

/**
 * 語彙に一致しても**拒否しない**複合語。
 *
 * なぜ要るか: 開示の世界では「買い付け」「売り出し」は事実の記述で、助言の求めではない。
 * kickoff T3 の正常系 12 本は「自己株式の売却」「買収」「売上」を含むことを要求している
 * （これらは `買い` / `売り` に一致しない）が、「自己株式の買い付け」は `買い` に一致してしまう。
 *
 * 免除は**一致した位置**にアンカーする（`critical-change-review.md` §E-2 の作法:
 * 「文字列がどこかにあれば開く」形にしない）。ここに無い形は免除されない =
 * 「買い時」「買い増し」は一致したまま。
 */
export const EXEMPT_COMPOUNDS: readonly string[] = [
  '買い付け', '買付け', '買い取り', '買取り', '買い戻し', '買戻し',
  '売り出し', '売出し', '売り渡し', '売渡し', '売り上げ', '売上げ',
  '買い手', '売り手', '買い替え', '売り掛け', '売り場', '買い物',
  // 英語の開示語彙（`take profit` 等の多語は誤爆しないが、念のため）
  'buyback', 'buy-back', 'buyout', 'sell-off', 'selling, general',
];

export interface VocabularyHit {
  /** 一致した語 */
  term: string;
  /** 一致した位置（0 起点） */
  index: number;
  /** どのリスト由来か */
  list: 'trading' | 'valuation' | 'regime' | 'importance' | 'probability';
}

const LISTS: { list: VocabularyHit['list']; terms: readonly string[] }[] = [
  { list: 'trading', terms: TRADING_TERMS },
  { list: 'valuation', terms: VALUATION_TERMS },
  { list: 'regime', terms: REGIME_TERMS },
  { list: 'importance', terms: IMPORTANCE_TERMS },
  { list: 'probability', terms: PROBABILITY_MISNOMERS },
];

/**
 * 一致位置が免除複合語の一部かどうか。
 * 免除語が「その一致位置を覆っている」ときだけ真（部分一致の緩い判定にしない）。
 */
function isExempt(text: string, term: string, index: number): boolean {
  for (const compound of EXEMPT_COMPOUNDS) {
    const offset = compound.indexOf(term);
    if (offset < 0) continue;
    const start = index - offset;
    if (start < 0) continue;
    if (text.slice(start, start + compound.length) === compound) {
      return true;
    }
  }
  return false;
}

/**
 * テキストに含まれる語彙の一致を全部返す（免除済みを除く）。
 * 大文字小文字は区別しない（upstream の `CRITICAL` / `Severity` を拾うため）。
 */
export function findVocabularyHits(
  text: string,
  lists: readonly VocabularyHit['list'][],
): VocabularyHit[] {
  const haystack = text.toLowerCase();
  const hits: VocabularyHit[] = [];
  for (const { list, terms } of LISTS) {
    if (!lists.includes(list)) continue;
    for (const term of terms) {
      const needle = term.toLowerCase();
      let from = 0;
      for (;;) {
        const index = haystack.indexOf(needle, from);
        if (index < 0) break;
        if (!isExempt(text, term, index)) {
          hits.push({ term, index, list });
        }
        from = index + 1;
      }
    }
  }
  return hits.sort((a, b) => a.index - b.index || a.term.localeCompare(b.term));
}

/** 入力ガードが見るリスト = 売買系 + 価値系（G-A1）。 */
/**
 * 入力ガードが見るリスト = 売買系 + 価値系 + 局面ラベル（G-A1・G-A5）。
 *
 * 局面ラベルを入力側にも入れる理由: held-out（別系譜生成）の「押し目で拾いたいので、
 * 指値をいくらに置けばいいか教えてください」が、局面を入力側で見ていないと素通りした。
 * 局面ラベルは出力で出さないだけでなく、それを前提にした助言の求めも入口で止める。
 */
export const INPUT_LISTS: readonly VocabularyHit['list'][] = ['trading', 'valuation', 'regime'];

/** 出力 linter が見るリスト = 売買系 + 価値系 + 局面ラベル + 重要度 + 確率の言い換え。 */
export const OUTPUT_LISTS: readonly VocabularyHit['list'][] = [
  'trading', 'valuation', 'regime', 'importance', 'probability',
];
