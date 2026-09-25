/**
 * demo が画面に出す段落と、出所メタを持つ同梱データの対応（review T9 M8）。
 *
 * `bun run check:data` が検査するのは `src/data/materials/` で、demo が実際に読むのは
 * `src/check/__demo__/check-recording.json`。録画の段落が同梱データと一字一句同じである限り、
 * 出所メタ（取得日・出典表記・編集加工の主体）は demo の段落にも当たる。ここでそれを固定する。
 */
import { describe, expect, test } from 'bun:test';
import materials from '../data/materials/demo-toyota.json';
import recording from './__demo__/check-recording.json';

describe('demo の段落は同梱データの段落と一字一句同じ', () => {
  const byText = new Map((materials as Array<{ text: string; docId: string }>).map(m => [m.text, m]));
  const paragraphs = (recording as { disclosure: { paragraphs: Array<{ text: string; docId: string }> } })
    .disclosure.paragraphs;

  test('録画に段落がある（空で緑にならない）', () => {
    expect(paragraphs.length).toBeGreaterThan(0);
  });

  test('★ 録画の全段落が同梱データに逐語で在り、書類管理番号も一致する', () => {
    for (const p of paragraphs) {
      const m = byText.get(p.text);
      expect({ text: p.text.slice(0, 30), inMaterials: Boolean(m) }).toEqual({ text: p.text.slice(0, 30), inMaterials: true });
      expect(m?.docId).toBe(p.docId);
    }
  });
});

describe('README の約束と本番経路（review T9 H1）', () => {
  test('★ 本番ポートが数値の検算を配線していない限り、README・RELEASE-NOTES は数値の検算を約束しない', async () => {
    const { productionPorts } = await import('./ports.js');
    if (productionPorts('any-model').fetchFinancials) return; // 配線したら、この約束を書いてよい
    for (const f of ['README.md', 'README.en.md', 'RELEASE-NOTES-v1.1.0-jp.md']) {
      const text = await Bun.file(new URL(`../../${f}`, import.meta.url)).text();
      expect({ f, claims: /財務データで検算し|verified in code against financial data/.test(text) }).toEqual({ f, claims: false });
    }
  });
});
