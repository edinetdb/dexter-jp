/**
 * G-E1 = 「README・RELEASE-NOTES の数値は bench 出力から生成する。ハードコードは赤」。
 *
 * 設計: ベンチ数値の主張は `<!-- BENCH:JUDGE:START/END -->` で囲む契約にし、その中を検査する
 * （README には ROE・PBR のようなスクリーニング例の数値も出るので、全文を無差別に見ると常に赤になる）。
 * **マーカーの外に「ベンチの語 + 数値」が出ていたら、それも違反**にする（マーカー運用の抜け道封じ）。
 *
 * ここで大事なのは**判別力**: 本当にハードコードを入れたら赤になること、対象ファイルが
 * 1 つも無いときに skip でなく赤になること、を対で置く。
 */
import { describe, expect, test } from 'bun:test';
import {
  findHardcodedBenchNumbers,
  findNumberClaims,
  extractMarkedBlocks,
  extractOutsideBlocks,
  findUnmarkedBenchClaims,
  isSourcedFromBench,
  BENCH_JUDGE_MARKER_START as START,
  BENCH_JUDGE_MARKER_END as END,
} from './hardcode-guard.js';

const BENCH = JSON.stringify({
  backends: [{ name: 'jev', judgeOnlyMs: 550, endToEndMs: 8400, requests: 132, jpy: 0.48 }],
});

/** fs を差し替えた検査。実ファイルに触らない。 */
function guard(files: Record<string, string>, benchJson: string | null = BENCH) {
  return findHardcodedBenchNumbers({
    scanDir: '/repo',
    benchResultPath: '/repo/bench.json',
    readDirSync: () => Object.keys(files),
    existsSync: (p) => (p === '/repo/bench.json' ? benchJson !== null : p in files),
    readFileSync: (p) => {
      if (p === '/repo/bench.json') return benchJson ?? '';
      const name = p.replace('/repo/', '');
      if (!(name in files)) throw new Error(`no such file: ${p}`);
      return files[name];
    },
  });
}

describe('マーカーの中の数値', () => {
  test('bench 出力にある数値は通る', () => {
    const md = `# x\n${START}\n判定だけで 550 ms、費用は ¥0.48 でした。\n${END}\n`;
    expect(guard({ 'README.md': md })).toEqual([]);
  });

  test('★ bench 出力に無い数値は赤（ハードコードの検出 = 判別力）', () => {
    const md = `# x\n${START}\n判定だけで 120 ms でした。\n${END}\n`;
    const v = guard({ 'README.md': md });
    expect(v).toHaveLength(1);
    expect(v[0].match).toBe('120');
  });

  test('マーカーの外の「無関係な数値」は見ない（ROE 15% 等で常時赤にしない）', () => {
    const md = `# x\nROE 15%以上・PBR 1.0倍以下でスクリーニングできます。\n`;
    expect(guard({ 'README.md': md })).toEqual([]);
  });

  test('表示の丸めは許す（実測 0.48 を「0.5」と書くのは正当な丸め）', () => {
    expect(isSourcedFromBench('0.48', [0.48])).toBe(true);
    expect(isSourcedFromBench('550', [550])).toBe(true);
    expect(isSourcedFromBench('0.5', [0.48])).toBe(true); // 1 桁に丸めれば一致
  });

  test('★ どう丸めても実測と一致しない数値は通らない', () => {
    expect(isSourcedFromBench('0.3', [0.48])).toBe(false);
    expect(isSourcedFromBench('0.45', [0.48])).toBe(false);
    expect(isSourcedFromBench('120', [550])).toBe(false);
  });
});

describe('★ マーカーの外の抜け道を塞ぐ', () => {
  test('マーカー無しで本文に「判定にかかった時間は 0.55 秒」と書くと赤', () => {
    const md = `# x\n判定にかかった時間は 0.55 秒でした。\n`;
    const v = guard({ 'README.md': md });
    expect(v).toHaveLength(1);
    expect(v[0].reason).toContain('マーカーの外');
  });

  test('同じ文をマーカーで囲み、値が bench にあれば通る', () => {
    const md = `# x\n${START}\n判定にかかった時間は 550 ms でした。\n${END}\n`;
    expect(guard({ 'README.md': md })).toEqual([]);
  });

  test('ベンチの語が無い行の数値は拾わない（行単位で見ている）', () => {
    expect(findUnmarkedBenchClaims('売上は 100 億円です。\n')).toEqual([]);
  });

  test('ベンチの語があっても数値が無ければ拾わない', () => {
    expect(findUnmarkedBenchClaims('判定にかかった時間はベンチの出力をご覧ください。\n')).toEqual([]);
  });

  test('マーカーの外側だけを取り出せている', () => {
    const md = `外1\n${START}\n中\n${END}\n外2\n`;
    expect(extractOutsideBlocks(md)).toContain('外1');
    expect(extractOutsideBlocks(md)).toContain('外2');
    expect(extractOutsideBlocks(md)).not.toContain('中');
  });
});

describe('★ 対象ファイルが無いときは skip でなく赤', () => {
  test('README も RELEASE-NOTES も無ければ違反 1 件', () => {
    const v = guard({ 'CONTRIBUTING.md': 'x' });
    expect(v).toHaveLength(1);
    expect(v[0].reason).toContain('must fail, not be skipped');
  });
});

describe('bench 結果ファイルが無い / 壊れている', () => {
  test('★ 無ければ「照合できる数値ゼロ」= マーカー内の主張は必ず赤（fail-close）', () => {
    const md = `${START}\n判定だけで 550 ms\n${END}`;
    expect(guard({ 'README.md': md }, null)).toHaveLength(1);
  });

  test('★ 壊れていても同じ（黙って通さない）', () => {
    const md = `${START}\n判定だけで 550 ms\n${END}`;
    expect(guard({ 'README.md': md }, '{ broken')).toHaveLength(1);
  });
});

describe('部品', () => {
  test('数値 + 単位と通貨記号を拾う', () => {
    // 出現順（index 昇順）で返る
    expect(findNumberClaims('550 ms と ¥0.48 と 12 リクエスト').map(c => c.raw))
      .toEqual(['550', '0.48', '12']);
  });

  test('マーカーが閉じていなければブロックとして扱わない', () => {
    expect(extractMarkedBlocks(`${START}\n中身だけ\n`)).toEqual([]);
  });

  test('複数ブロックを全部拾う', () => {
    expect(extractMarkedBlocks(`${START}a${END}x${START}b${END}`)).toEqual(['a', 'b']);
  });
});

describe('実リポジトリ', () => {
  test('いまの README / RELEASE-NOTES に、説明できないベンチ数値が無い', () => {
    const repo = new URL('../../..', import.meta.url).pathname;
    const violations = findHardcodedBenchNumbers({ scanDir: repo });
    expect(violations).toEqual([]);
  });
});
