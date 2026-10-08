import { describe, expect, test } from 'bun:test';
import { hasExplicitMemoIntent } from './memo-intent.js';

const explicitRequests = [
  'これをメモにして',
  'この内容をmemoとして保存して',
  '日本語でメモを書いて',
  '調査結果をメモ化して',
  'メモを作成してください',
  '要点をメモして',
  'この会話をメモに取って',
  'Write this as a memo',
  'Save this as a memo',
  'Draft an investment memo on 7203',
  'memo on Toyota',
  '"Write this as a memo"',
  'Write "this research" as a memo',
];

const excludedRequests = [
  '覚えておいて',
  'これを記憶して',
  'remember this',
  '要約して',
  'Markdownにして',
  '説明して',
  'ファイルに保存して',
  'このメモを読んで',
  'このメモを要約して',
  'memoizationを説明して',
  'write-memo Skillの仕組みを説明して',
  'Do not write this as a memo',
  'Examples: "Write this as a memo" and "remember this"',
];

describe('explicit memo intent boundary', () => {
  test.each(explicitRequests)('activates for: %s', (request) => {
    expect(hasExplicitMemoIntent(request)).toBe(true);
  });

  test.each(excludedRequests)('does not activate for: %s', (request) => {
    expect(hasExplicitMemoIntent(request)).toBe(false);
  });
});
