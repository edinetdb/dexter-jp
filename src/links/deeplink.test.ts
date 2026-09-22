import { describe, expect, test } from 'bun:test';
import { deepLinksFor, isTseFourDigit, UTM_CLI } from './deeplink.js';
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

  test('5 桁・英字混じりは 4 桁として扱わない', () => {
    expect(isTseFourDigit('72030')).toBe(false);
    expect(isTseFourDigit('720A')).toBe(false);
    expect(deepLinksFor({ secCode: '72030', edinetCode: 'E02144' })).toHaveLength(1);
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
