/**
 * スラッシュコマンドの解析。
 *
 * これを書くまでの実態（review r2 L1）: `src/cli.ts` は
 * `query.slice(1).trim().toLowerCase()` を `handleSlashCommand` に渡し、
 * `switch (command)` が**完全一致**で分岐していた。つまり
 *   - `/check 7203 中国事業は回復している` は**どの case にも当たらず黙って何も起きない**
 *   - `.toLowerCase()` が**仮説の本文にも掛かる**（英字の固有名詞が壊れる）
 * 引数を取るコマンドを足す前に、ここを直す。
 */

export interface ParsedSlashCommand {
  /** コマンド名。小文字に正規化する */
  name: string;
  /** 残り全部。**大文字小文字も空白も原文のまま**（仮説の本文が入る） */
  rest: string;
}

/**
 * `/name rest...` を分ける。スラッシュで始まらない入力は null。
 *
 * 正規化するのは**コマンド名だけ**。`rest` は trim 以外なにもしない。
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  if (!input.startsWith('/')) return null;
  const body = input.slice(1);
  const match = /^([^\s]*)\s*([\s\S]*)$/.exec(body);
  if (!match) return null;
  return { name: match[1].toLowerCase(), rest: match[2].trim() };
}

/** `/check <銘柄> <仮説>` の引数。銘柄は先頭のひとかたまり、残りが仮説。 */
export interface CheckArgs {
  ticker: string;
  hypothesis: string;
}

/**
 * `/check` の引数を分ける。銘柄だけ・引数なしのときは足りない側を空文字で返し、
 * 呼び出し側が使い方を出せるようにする（黙って何も起きない、をやめる）。
 */
export function parseCheckArgs(rest: string): CheckArgs {
  const match = /^([^\s]*)\s*([\s\S]*)$/.exec(rest.trim());
  if (!match) return { ticker: '', hypothesis: '' };
  return { ticker: match[1], hypothesis: match[2].trim() };
}

/** `/watch` の引数。`all` を付けると低い群も全件出す（design §4.2）。 */
export interface WatchArgs {
  all: boolean;
  /** 解釈できなかった残り（使い方の表示に使う） */
  unknown: string;
}

export function parseWatchArgs(rest: string): WatchArgs {
  const words = rest.trim().split(/\s+/).filter(Boolean);
  const all = words.some(w => w.toLowerCase() === 'all');
  const unknown = words.filter(w => w.toLowerCase() !== 'all').join(' ');
  return { all, unknown };
}
