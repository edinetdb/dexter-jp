import { describe, expect, test } from 'bun:test';
import { parseSlashCommand, parseCheckArgs, parseWatchArgs } from './parse.js';

describe('parseSlashCommand', () => {
  test('引数なしは従来どおり（名前だけ・小文字化）', () => {
    expect(parseSlashCommand('/model')).toEqual({ name: 'model', rest: '' });
    expect(parseSlashCommand('/MODEL')).toEqual({ name: 'model', rest: '' });
    expect(parseSlashCommand('/help  ')).toEqual({ name: 'help', rest: '' });
  });

  test('引数つきが名前と残りに分かれる（これまでは黙って何も起きなかった）', () => {
    expect(parseSlashCommand('/check 7203 中国事業は回復している')).toEqual({
      name: 'check',
      rest: '7203 中国事業は回復している',
    });
  });

  test('★ 仮説の本文は小文字化されない（固有名詞が壊れない）', () => {
    const parsed = parseSlashCommand('/check 6758 PlayStation Network の売上は伸びている');
    expect(parsed?.rest).toBe('6758 PlayStation Network の売上は伸びている');
    expect(parsed?.rest).toContain('PlayStation');
  });

  test('コマンド名だけは大文字でも当たる', () => {
    expect(parseSlashCommand('/Check 7203 …')?.name).toBe('check');
  });

  test('スラッシュで始まらない入力は null', () => {
    expect(parseSlashCommand('check 7203')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });

  test('改行を含む仮説も落とさない', () => {
    const parsed = parseSlashCommand('/check 7203 一行目\n二行目');
    expect(parsed?.rest).toBe('7203 一行目\n二行目');
    expect(parseCheckArgs(parsed!.rest).hypothesis).toBe('一行目\n二行目');
  });

  test('スラッシュだけは空の名前（使い方を出す側に渡る）', () => {
    expect(parseSlashCommand('/')).toEqual({ name: '', rest: '' });
  });
});

describe('parseCheckArgs', () => {
  test('銘柄と仮説に分かれる', () => {
    expect(parseCheckArgs('7203 中国事業は回復している')).toEqual({
      ticker: '7203',
      hypothesis: '中国事業は回復している',
    });
  });

  test('企業名でも銘柄として受ける（resolver が解決する）', () => {
    expect(parseCheckArgs('トヨタ 為替の影響が主因だ')).toEqual({
      ticker: 'トヨタ',
      hypothesis: '為替の影響が主因だ',
    });
  });

  test('足りない側は空文字（黙って何も起きない、をやめる）', () => {
    expect(parseCheckArgs('7203')).toEqual({ ticker: '7203', hypothesis: '' });
    expect(parseCheckArgs('')).toEqual({ ticker: '', hypothesis: '' });
  });

  test('仮説の中の空白と大文字を保つ', () => {
    expect(parseCheckArgs('6758  PlayStation の  売上').hypothesis).toBe('PlayStation の  売上');
  });
});

describe('parseWatchArgs', () => {
  test('引数なし', () => {
    expect(parseWatchArgs('')).toEqual({ all: false, unknown: '' });
  });
  test('all で全件', () => {
    expect(parseWatchArgs('all')).toEqual({ all: true, unknown: '' });
    expect(parseWatchArgs('ALL')).toEqual({ all: true, unknown: '' });
  });
  test('解釈できない残りは持ち帰る', () => {
    expect(parseWatchArgs('all もっと')).toEqual({ all: true, unknown: 'もっと' });
  });
});
