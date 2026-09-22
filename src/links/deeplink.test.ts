import { describe, expect, test } from 'bun:test';
import { deepLinksFor, isTseFourDigit, toTseFourDigit, UTM_CLI } from './deeplink.js';
import { lintOutput } from '../guard/output-linter.js';

describe('deep link（URL 組み立てだけ）', () => {
  test('4 桁コードがあれば 2 行', () => {
    expect(deepLinksFor({ secCode: '7203', edinetCode: 'E02144' })).toEqual([
      { label: 'チャート（TradingView）', url: 'https://jp.tradingview.com/symbols/TSE-7203/' },
      { label: '企業ページ（EDINET DB）', url: `https://edinetdb.jp/companies/E02144?${UTM_CLI}` },
    ]);
  });

  test('4 桁コードが無ければ EDINET DB の 1 行だけ（東証以外・非上場）', () => {
    const links = deepLinksFor({ secCode: null, edinetCode: 'E12345' });
    expect(links).toHaveLength(1);
    expect(links[0].url).toContain('edinetdb.jp');
  });

  /**
   * 旧: 「5 桁は 4 桁として扱わない」= `72030` でリンクを出さない。
   * 新: 末尾が 0 の 5 桁は 4 桁に落とす（下の describe で正面から固定）。
   * 理由: **EDINET DB の `sec_code` は 5 桁で返る**（トヨタ = `72030`、2026-09-23 実測）。
   *   旧の線のままだと、実データでは TradingView のリンクが 1 本も出ない。
   *   旧のテストは実応答を見る前に書いたもので、守りたい性質ではなく当時の思い込みを固定していた。
   */
  test('4 桁でも「末尾 0 の 5 桁」でもない形は 4 桁として扱わない', () => {
    expect(isTseFourDigit('720A')).toBe(false);
    expect(isTseFourDigit('723')).toBe(false);
    expect(deepLinksFor({ secCode: '720A', edinetCode: 'E02144' })).toHaveLength(1);
  });

  test('どちらも無ければ 0 行（無理にリンクを作らない）', () => {
    expect(deepLinksFor({})).toEqual([]);
  });

  test('utm は CLI 用のものだけが CLI の出力に入る', () => {
    const url = deepLinksFor({ edinetCode: 'E02144' })[0].url;
    expect(url).toContain('utm_source=dexter-cli');
    expect(url).not.toContain('utm_medium=readme');
  });

  test('ラベルは出力 linter を通る（当社生成の文字列）', () => {
    expect(lintOutput(deepLinksFor({ secCode: '7203', edinetCode: 'E02144' }), '$.links').findings)
      .toEqual([]);
  });
});

describe('EDINET DB の 5 桁 sec_code（実データの形）', () => {
  test('★ 72030（トヨタ、EDINET DB の実応答）は TSE-7203 になる', () => {
    // 4 桁だけを受ける実装だと、実データでは TradingView のリンクが 1 本も出ない
    expect(toTseFourDigit('72030')).toBe('7203');
    const links = deepLinksFor({ secCode: '72030', edinetCode: 'E02144' });
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe('https://jp.tradingview.com/symbols/TSE-7203/');
  });

  test('4 桁はそのまま', () => {
    expect(toTseFourDigit('9983')).toBe('9983');
  });

  test('末尾が 0 でない 5 桁は落とさない（別物へ飛ばさない）', () => {
    expect(toTseFourDigit('72031')).toBeNull();
  });

  test('英字付きの新形式は 4 桁に落とさず、リンクを出さない側に倒す', () => {
    expect(toTseFourDigit('7203A')).toBeNull();
    expect(deepLinksFor({ secCode: '7203A', edinetCode: 'E02144' })).toHaveLength(1);
  });

  test('空白は落とす', () => {
    expect(toTseFourDigit(' 72030 ')).toBe('7203');
  });
});
