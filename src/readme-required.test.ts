/**
 * README の必須記載（go-decision §9.2「README に置く」= 文言そのものを grep テストで固定）。
 *
 * 7 項のうち 2（各自の契約・株価は遅延）と 4（TradingView の契約要件・帰属）は TradingView 接続に
 * 掛かる項で、この版（β）は TradingView 接続を含まないので対象外。接続を足す版でここに戻す。
 */
import { describe, expect, test } from 'bun:test';

const readme = await Bun.file(new URL('../README.md', import.meta.url)).text();

const REQUIRED: Array<[string, string[]]> = [
  ['1 投資助言を行わない（当社が何をしないかの事実で）', ['本ツールは投資助言を行いません', '売買の指示・目標株価・建玉の大きさを出力しません']],
  ['3 送信先の全経路と TypeSafe の処理権の留保（「保存しない」と書かない）', ['学習データに含めない', '処理権を留保', '「保存しない」とは書きません', '| 送信先 | 何が送られるか |']],
  ['5 EDINET の出典表記', ['出典：EDINET閲覧（提出）サイト', 'PDL1.0']],
  ['6 出力を第三者に提供する利用者への注記', ['金融商品取引法その他の規制を受ける可能性があります']],
  ['7 同梱データのライセンスが MIT と別', ['MIT ライセンスの対象外', 'LICENSE-DATA']],
];

describe('README の必須記載（go-decision §9.2）', () => {
  for (const [item, phrases] of REQUIRED) {
    test(`★ ${item}`, () => {
      for (const p of phrases) expect({ item, phrase: p, present: readme.includes(p) }).toEqual({ item, phrase: p, present: true });
    });
  }
});
