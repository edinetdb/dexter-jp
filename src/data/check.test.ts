import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkMaterialsDir, DEFAULT_MATERIALS_DIR } from './check.js';

const FIXTURES_DIR = path.join(import.meta.dirname, '__fixtures__');

describe('checkMaterialsDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dexter-data-check-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('存在しないディレクトリは 0 件・ok:true（実データ未投入を build 失敗にしない）', () => {
    const result = checkMaterialsDir(path.join(dir, 'does-not-exist'));
    expect(result).toEqual({ ok: true, fileCount: 0, materialCount: 0, issues: [] });
  });

  test('空ディレクトリは 0 件・ok:true', () => {
    const result = checkMaterialsDir(dir);
    expect(result).toEqual({ ok: true, fileCount: 0, materialCount: 0, issues: [] });
  });

  test('全項目が揃った素材だけなら ok:true', () => {
    cpSync(path.join(FIXTURES_DIR, 'valid.json'), path.join(dir, 'valid.json'));
    const result = checkMaterialsDir(dir);
    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(1);
    expect(result.materialCount).toBe(1);
    expect(result.issues).toHaveLength(0);
  });

  test('配列ファイル（1 ファイル = 複数素材）も件数を正しく数える', () => {
    cpSync(path.join(FIXTURES_DIR, 'valid-array.json'), path.join(dir, 'valid-array.json'));
    const result = checkMaterialsDir(dir);
    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(1);
    expect(result.materialCount).toBe(2);
  });

  test('*.json 以外のファイルは無視する', () => {
    writeFileSync(path.join(dir, 'notes.txt'), 'これは素材ではありません');
    const result = checkMaterialsDir(dir);
    expect(result).toEqual({ ok: true, fileCount: 0, materialCount: 0, issues: [] });
  });

  test('サブディレクトリ（__fixtures__ 相当）は非再帰なので対象外', () => {
    cpSync(FIXTURES_DIR, path.join(dir, '__fixtures__'), { recursive: true });
    const result = checkMaterialsDir(dir);
    expect(result).toEqual({ ok: true, fileCount: 0, materialCount: 0, issues: [] });
  });

  test('JSON として解析できないファイルは invalid_json で赤', () => {
    cpSync(path.join(FIXTURES_DIR, 'invalid.json'), path.join(dir, 'invalid.json'));
    const result = checkMaterialsDir(dir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'invalid_json')).toBe(true);
  });

  describe('★ 変異 3 本（go-decision-v0.md §9.2 G-C1・G-C2・G-D1）', () => {
    test('① source を edinet 以外にすると赤（G-C1）', () => {
      cpSync(path.join(FIXTURES_DIR, 'non-edinet-source.json'), path.join(dir, 'material.json'));
      const result = checkMaterialsDir(dir);
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'G-C1')).toBe(true);
    });

    test('② doc_id を 1 件消すと赤（G-C2）', () => {
      cpSync(path.join(FIXTURES_DIR, 'missing-doc-id.json'), path.join(dir, 'material.json'));
      const result = checkMaterialsDir(dir);
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'G-C2' && i.message.includes('docId'))).toBe(true);
    });

    test('③ 人名を含む段落を入れると赤（G-D1）', () => {
      cpSync(path.join(FIXTURES_DIR, 'person-name.json'), path.join(dir, 'material.json'));
      const result = checkMaterialsDir(dir);
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'G-D1')).toBe(true);
    });
  });

  test('複数ファイルのうち 1 件でも不正なら全体が ok:false（他の正常ファイルの issue は出ない）', () => {
    cpSync(path.join(FIXTURES_DIR, 'valid.json'), path.join(dir, 'a-valid.json'));
    cpSync(path.join(FIXTURES_DIR, 'non-edinet-source.json'), path.join(dir, 'b-bad.json'));
    const result = checkMaterialsDir(dir);
    expect(result.ok).toBe(false);
    expect(result.materialCount).toBe(2);
    expect(result.issues.every((i) => i.location.startsWith('b-bad.json'))).toBe(true);
  });
});

describe('DEFAULT_MATERIALS_DIR', () => {
  test('src/data/materials を指す', () => {
    expect(DEFAULT_MATERIALS_DIR.endsWith(path.join('src', 'data', 'materials'))).toBe(true);
  });

  test('現状（実データ未投入のプレースホルダ）でも ok:true', () => {
    const result = checkMaterialsDir(DEFAULT_MATERIALS_DIR);
    expect(result.ok).toBe(true);
  });
});
