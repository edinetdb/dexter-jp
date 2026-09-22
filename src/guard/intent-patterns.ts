/**
 * 入力ガードの第 2 層 — **構造**で助言の求めを捉える（決定論）。
 *
 * なぜ要るか（実測）: 語彙リストだけでは、見たことのない言い回しに届かない。
 * 別系譜が実装も語彙リストも見ずに書いた held-out 25 本に対し、
 * **語彙リスト単独の recall は 11/25（44%）**（対照群 15 本の誤検知は 0）。
 * 取りこぼしは「そろそろ入ってもよさそう？」「1株いくらくらいが妥当なんだろう」
 * 「100株にしておく？ 思い切って200株いっちゃう？」のように、
 * **禁止語を 1 つも使わずに助言を求める**型だった。
 *
 * 語をいくら足しても追いつかないので、層を変える。ここで見るのは 3 つの型:
 *   ① 自分の取引についての行動 × 判断を求める言い回し（「入って」×「よさそう？」）
 *   ② 株価・株数の水準を尋ねる形（「1株」×「いくら / 妥当」「どこまで上がる」）
 *   ③ 金額・株数 × 自分がどうするか（「30万円」×「使うか迷って」）
 *
 * design §4.2 の「語彙リスト **または** Judge の Noul」の、語彙リスト側の中身を厚くしたもの。
 * Judge(Noul) は引き続き追加票で、**この層の拒否も Judge の票では解除しない**。
 */

export interface IntentHit {
  /** どの型で当たったか */
  pattern: 'action-decision' | 'price-level' | 'amount-action' | 'foreign';
  /** 当たった箇所（報告用） */
  matched: string;
}

/** ① 自分の取引についての行動（語幹。開示の事実語に当たらない短さで切る） */
const ACTION_STEMS =
  '買っ|買う|買い|売っ|売る|売り|入れ|入っ|入る|入り|拾っ|拾う|拾い|手放|持っ|持つ|保有し|追いかけ|乗っ|突っ込|つっこ|ホールド|ロスカット|ナンピン|利確|損切';

/**
 * ① 判断を求める言い回し。
 * 「でしょうか」「ですか」「大丈夫」のような広い語尾は**入れない**
 * （「自己株式を持っているでしょうか」のような事実の確認に当たるため）。
 */
const DECISION_ENDINGS =
  'べき|ほうがいい|方がいい|ほうがよさ|方がよさ|していい|してもいい|しても大丈夫|ありか|あり\\?|あり？|' +
  'よさそう|いいかな|いいのかな|迷って|迷う|間に合う|間に合い|どっち|どちらがいい|' +
  'いっちゃ|ちゃおう|ちゃお|しようかな|そろそろ|タイミング|判断して|どうしよう|どう思う|おすすめ';

/** ② 株価・株数の水準を尋ねる形 */
const PRICE_LEVEL_PATTERNS: RegExp[] = [
  /(株価|価格|値段|水準|[0-9０-９一]株)[^。！？\n]{0,12}(いくら|妥当|適正|目安|めやす|相場)/,
  /(いくら|どのくらい|どれくらい)[^。！？\n]{0,10}(が妥当|が適正|なら買|なら売)/,
  /(どこまで|どのへん|どの辺|どこら|どれくらい|どのくらい)[^。！？\n]{0,12}(上が|下が|値上が|値下が|伸び|落ち|下げ|上げ|期待)/,
  /(底|天井|上値|下値)[^。！？\n]{0,6}(目安|めやす|目途|めど|は?どこ)/,
  /適正[なの]?価格|妥当[なの]?価格|フェア[なの]?価格/,
];

/** ③ 金額・株数 × 自分がどうするか */
const AMOUNT_PATTERNS: RegExp[] = [
  /[0-9０-９][0-9０-９,，]*\s*(万円|億円|円|万)[^。！？\n]{0,24}(使う|入れ|突っ込|つっこ|回す|振り|迷|買|買っ|どうし)/,
  /[0-9０-９][0-9０-９,，]*\s*株[^。！？\n]{0,20}(にしておく|いっちゃ|買|売|持|迷|どうし|ずつ)/,
  /(余裕資金|余剰資金|手元の?[0-9０-９]|軍資金)[^。！？\n]{0,30}(使|入れ|回|買|迷)/,
];

/**
 * ③-b 文をまたぐ「金額・株数の提示 × 自分の迷い」。
 * 「余裕資金が30万円あります。全部ここに使うか、半分にするかで迷っています。」の型。
 * 金額と迷いが別の文に分かれるので ③ では届かない。
 * 迷いの語は**自分の行動についての一人称**に限り、事実の確認には現れない形だけを置く。
 */
const AMOUNT_TOKEN = /[0-9０-９][0-9０-９,，]*\s*(万円|億円|円|万|株)/;
const DELIBERATION = /(迷って|迷いま|迷う|どうしよう|どうすべき|どうしたら|全部[^。！？\n]{0,8}使う|半分にする|どっちにする)/;

/** ④ 英語・ローマ字の言い回し（日本語側に誤爆しない） */
const FOREIGN_PATTERNS: RegExp[] = [
  /should i (buy|sell|hold|add|keep|get in|get out|invest)/i,
  /(tell me )?whether i should (buy|sell|hold|keep)/i,
  /is it a good time to (buy|sell|invest)/i,
  /how many shares (should|do) i/i,
  /(worth|good) (buy|sell|entry|time to)/i,
  /\b(ima )?(kau|uru|katta|utta|kaou|urou)\b/i,
  /\b(kaidoki|uridoki|kaimashi|songiri|rikaku|nanpin|takasugi|yasusugi)\b/i,
];

const ACTION_DECISION = new RegExp(
  `(${ACTION_STEMS})[^。！？\\n]{0,20}(${DECISION_ENDINGS})|(${DECISION_ENDINGS})[^。！？\\n]{0,20}(${ACTION_STEMS})`,
);

/**
 * 構造で助言の求めを捉える。当たりを全部返す（空なら当たらなかった）。
 */
export function findIntentHits(text: string): IntentHit[] {
  const hits: IntentHit[] = [];

  // 文をまたぐと「買収のリスク」+ 別の文の「どう思う」で誤爆するので、文単位で見る
  for (const sentence of text.split(/[。！？\n]/)) {
    if (!sentence.trim()) continue;
    const m = ACTION_DECISION.exec(sentence);
    if (m) hits.push({ pattern: 'action-decision', matched: m[0] });
  }

  for (const re of PRICE_LEVEL_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ pattern: 'price-level', matched: m[0] });
  }
  for (const re of AMOUNT_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ pattern: 'amount-action', matched: m[0] });
  }
  if (AMOUNT_TOKEN.test(text) && DELIBERATION.test(text)) {
    hits.push({ pattern: 'amount-action', matched: `${AMOUNT_TOKEN.exec(text)?.[0]} … ${DELIBERATION.exec(text)?.[0]}` });
  }

  for (const re of FOREIGN_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ pattern: 'foreign', matched: m[0] });
  }

  return hits;
}
