import { describe, expect, test } from 'bun:test';
import {
  EDINET_SOURCE,
  PROVENANCE_META_FIELDS,
  REQUIRED_CITATION_MARKER,
  REQUIRED_CITATION_PREFIX,
  REQUIRED_EDITOR,
  isValidMaterial,
  validateMaterial,
  type BundledMaterial,
} from './schema.js';
import valid from './__fixtures__/valid.json';
import missingDocId from './__fixtures__/missing-doc-id.json';
import nonEdinetSource from './__fixtures__/non-edinet-source.json';
import badCitation from './__fixtures__/bad-citation.json';
import wrongEditor from './__fixtures__/wrong-editor.json';
import badDate from './__fixtures__/bad-date.json';

function codes(errors: { code: string }[]): string[] {
  return errors.map((e) => e.code);
}

describe('validateMaterial — 正常系', () => {
  test('全項目が揃った素材はエラー 0 件', () => {
    expect(validateMaterial(valid)).toHaveLength(0);
    expect(isValidMaterial(valid)).toBe(true);
  });
});

describe('validateMaterial — G-C1（source は edinet のみ）', () => {
  test('fixture: source=tdnet は G-C1 で赤', () => {
    const errors = validateMaterial(nonEdinetSource);
    expect(codes(errors)).toContain('G-C1');
  });

  test('★ 変異: 正常な素材の source を edinet 以外に書き換えると赤', () => {
    const mutated: BundledMaterial = { ...(valid as BundledMaterial), source: 'company-ir' };
    const errors = validateMaterial(mutated);
    expect(codes(errors)).toContain('G-C1');
  });

  test('source が edinet なら G-C1 は出ない', () => {
    const errors = validateMaterial(valid);
    expect(codes(errors)).not.toContain('G-C1');
  });
});

describe('validateMaterial — G-C2（出所メタ 7 項目）', () => {
  test('fixture: docId が空文字列だと G-C2 で赤', () => {
    const errors = validateMaterial(missingDocId);
    expect(codes(errors)).toContain('G-C2');
    expect(errors.some((e) => e.field === 'docId')).toBe(true);
  });

  test('★ 変異: 正常な素材から docId を 1 件消すと赤', () => {
    const mutated = { ...(valid as Record<string, unknown>) };
    delete mutated.docId;
    const errors = validateMaterial(mutated);
    expect(codes(errors)).toContain('G-C2');
    expect(errors.some((e) => e.field === 'docId')).toBe(true);
  });

  test('出所メタ 7 項目それぞれについて、1 項目でも欠けたら G-C2', () => {
    for (const field of PROVENANCE_META_FIELDS) {
      const mutated = { ...(valid as Record<string, unknown>) };
      delete mutated[field];
      const errors = validateMaterial(mutated);
      expect(codes(errors)).toContain('G-C2');
    }
  });

  test('citation が規定の書式（出典プレフィックス + PDL1.0）を欠くと G-C2', () => {
    const errors = validateMaterial(badCitation);
    expect(codes(errors)).toContain('G-C2');
    expect(errors.some((e) => e.field === 'citation')).toBe(true);
  });

  test('editor が Cabocia 固定でないと G-C2', () => {
    const errors = validateMaterial(wrongEditor);
    expect(codes(errors)).toContain('G-C2');
    expect(errors.some((e) => e.field === 'editor')).toBe(true);
  });

  test('acquiredDate が YYYY-MM-DD 形式でないと G-C2', () => {
    const errors = validateMaterial(badDate);
    expect(codes(errors)).toContain('G-C2');
    expect(errors.some((e) => e.field === 'acquiredDate')).toBe(true);
  });
});

describe('validateMaterial — 構造エラー', () => {
  test('オブジェクトでない値は not_object', () => {
    expect(codes(validateMaterial('not an object'))).toEqual(['not_object']);
    expect(codes(validateMaterial(null))).toEqual(['not_object']);
    expect(codes(validateMaterial([1, 2, 3]))).toEqual(['not_object']);
  });

  test('text が空だと missing_text', () => {
    const mutated = { ...(valid as Record<string, unknown>), text: '' };
    expect(codes(validateMaterial(mutated))).toContain('missing_text');
  });
});

describe('定数', () => {
  test('EDINET_SOURCE / REQUIRED_EDITOR / 出典プレフィックスは fixture と整合', () => {
    expect(EDINET_SOURCE).toBe('edinet');
    expect(REQUIRED_EDITOR).toBe('Cabocia');
    expect(REQUIRED_CITATION_PREFIX).toBe('出典：EDINET閲覧（提出）サイト');
    expect(REQUIRED_CITATION_MARKER).toBe('PDL1.0');
    expect((valid as BundledMaterial).citation).toContain(REQUIRED_CITATION_PREFIX);
    expect((valid as BundledMaterial).citation).toContain(REQUIRED_CITATION_MARKER);
  });
});
