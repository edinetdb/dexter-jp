/**
 * `bun run demo` の録画が再生できること。
 *
 * demo は**鍵なしの初回体験**そのもの（裁定 B で `/check` が TYPESAFE_API_KEY を要求するように
 * なったので、鍵を入れる前に何が返るかを見る唯一の場になった）。壊れたまま出すと、
 * README の「まず動かす」が最初の一歩で外れる。
 */
import { describe, expect, test } from 'bun:test';
import { loadRecording, recordedBackend, runDemo } from './demo.ts';
import { lintOutput } from '../src/guard/output-linter.js';

const rec = loadRecording();

describe('録画の中身', () => {
  test('有価証券報告書の逐語で、書類 ID と提出者が入っている', () => {
    expect(rec.disclosure.paragraphs.length).toBeGreaterThanOrEqual(5);
    for (const p of rec.disclosure.paragraphs) {
      expect(p.docId).toMatch(/^S\d{3}[A-Z0-9]+$/);
      expect(p.filer).toBe('トヨタ自動車株式会社');
      expect(p.docType).toBe('有価証券報告書');
      // 長さの下限は置かない（地域別の記述は「営業利益は、為替変動の影響などにより…減益となりました。」
      // のように 40 字前後で完結する。むしろこれが demo の芯 = 欧州は為替が筆頭、北米は触れていない）。
      // 見るのは**文として完結しているか**。
      expect(p.text.trim().length).toBeGreaterThan(30);
      expect(p.text.trim().endsWith('。')).toBe(true);
    }
  });

  test('全段落 × 全主張の判定が録れている（欠けていると実 API に落ちる代わりに失敗する）', () => {
    for (const p of rec.disclosure.paragraphs) {
      expect(Object.keys(rec.judgments[p.id] ?? {}).length).toBe(rec.claims.length);
    }
  });

  test('入口ガードの票が「助言ではない」側（そうでないと demo が拒否で終わる）', () => {
    expect(rec.adviceNoul).toBeLessThan(0.5);
  });
});

describe('再生', () => {
  test('鍵なしでパネルまで出る', async () => {
    const lines = await runDemo(rec);
    const text = lines.join('\n');
    expect(text).toContain('録画の再生');
    expect(text).toContain(rec.hypothesis);
    expect(text).toContain('検査した範囲');
    expect(text).toContain('この段落と主張の関係についてのモデルの推定');
  });

  test('★ 判定不能にならない（主張のどれかは確定する）', async () => {
    const text = (await runDemo(rec)).join('\n');
    expect(text).not.toContain('判定不能');
  });

  test('★ 「裏付ける」と「食い違う」が両方出る（機能が伝わる録画になっている）', async () => {
    const text = (await runDemo(rec)).join('\n');
    expect(text).toContain('→ 裏付ける');
    expect(text).toContain('→ 食い違う');
  });

  test('deep link 2 行が出る（5 桁 sec_code が 4 桁に正規化されている）', async () => {
    const text = (await runDemo(rec)).join('\n');
    expect(text).toContain('https://jp.tradingview.com/symbols/TSE-7203/');
    expect(text).toContain('edinetdb.jp/companies/E02144?utm_source=dexter-cli');
  });

  test('★ 当社が組み立てた行に禁止語が無い（逐語の行は除く）', async () => {
    const lines = await runDemo(rec);
    const quoted = rec.disclosure.paragraphs.map(p => p.text);
    const ours = lines.filter(l => !quoted.some(q => l.includes(q.slice(0, 40))));
    expect(lintOutput(ours, '$.demo').findings).toEqual([]);
  });
});

describe('★ 録画に無いものを聞かれたら失敗する（実 API に落ちない）', () => {
  test('知らない段落 → 投げる', async () => {
    const backend = recordedBackend(rec);
    await expect(
      backend.call({ key: 'unknown-paragraph', state: 'x', questions: {} }),
    ).rejects.toThrow('録画がありません');
  });

  test('知らない主張 → エラー回答（黙って作り物を返さない）', async () => {
    const backend = recordedBackend(rec);
    const first = rec.disclosure.paragraphs[0].id;
    const out = await backend.call({
      key: first,
      state: 'x',
      questions: { 'unknown-claim': { type: 'choice', instructions: 'x', criteria: { a: 'a' } } },
    });
    expect(out.answers['unknown-claim']).toHaveProperty('code', 'replay_miss');
  });
});
