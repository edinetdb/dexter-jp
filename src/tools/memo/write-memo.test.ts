import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMemoFilename } from '../../memo/document.js';
import { MemoryStore } from '../../memory/store.js';
import { createWriteMemoTool } from './write-memo.js';

let testRoot = '';

function removeTestRoot(path: string): void {
  const resolvedPath = resolve(path);
  const resolvedTemp = resolve(tmpdir());
  if (!resolvedPath.startsWith(resolvedTemp + sep)) {
    throw new Error('Refusing to remove a path outside the test temp directory.');
  }
  rmSync(resolvedPath, { recursive: true, force: true });
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'dexter-write-memo-'));
});

afterEach(() => {
  if (testRoot && existsSync(testRoot)) removeTestRoot(testRoot);
  testRoot = '';
});

const input = {
  created: '2026-09-19',
  document: {
    title: '日本語メモ 🚀',
    summary: '確定した結論だけを保存する。',
    keyPoints: ['要点1', '要点2'],
    tags: ['日本語', 'memo'],
  },
};

describe('write_memo persistence boundary', () => {
  test('writes UTF-8 without BOM under .dexter/memos and leaves durable memory untouched', async () => {
    const tool = createWriteMemoTool({ cwd: testRoot });
    const result = JSON.parse(await tool.invoke(input)) as {
      data: { path: string; bytesWritten: number };
    };
    const filename = buildMemoFilename(input.document.title, input.created);
    const memoPath = join(testRoot, '.dexter', 'memos', filename);
    const bytes = readFileSync(memoPath);

    expect(result.data.path).toBe(`.dexter/memos/${filename}`);
    expect(result.data.bytesWritten).toBe(bytes.length);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(bytes.toString('utf8')).toContain('# 日本語メモ 🚀');

    const memory = new MemoryStore(join(testRoot, '.dexter'));
    expect(await memory.listMemoryFiles()).toEqual([]);
    expect(await memory.readMemoryFile('MEMORY.md')).toBe('');
  });

  test('is create-only and preserves the first memo on a duplicate', async () => {
    const tool = createWriteMemoTool({ cwd: testRoot });
    await tool.invoke(input);
    const memoPath = join(
      testRoot,
      '.dexter',
      'memos',
      buildMemoFilename(input.document.title, input.created),
    );
    const original = readFileSync(memoPath, 'utf8');

    await expect(tool.invoke({
      ...input,
      document: { ...input.document, summary: '上書きされてはいけない本文' },
    })).rejects.toThrow('create-only workflow will not overwrite or append');
    expect(readFileSync(memoPath, 'utf8')).toBe(original);
  });

  test('rejects direct writes that skipped runtime date normalization', async () => {
    const tool = createWriteMemoTool({ cwd: testRoot });

    await expect(tool.invoke({ document: input.document })).rejects.toThrow(
      'runtime-managed creation date',
    );
    expect(existsSync(join(testRoot, '.dexter', 'memos'))).toBe(false);
  });

  test('does not accept model-controlled path, overwrite, or append fields', async () => {
    const tool = createWriteMemoTool({ cwd: testRoot });

    await expect(tool.invoke({
      ...input,
      path: '../../outside.md',
      overwrite: true,
      append: true,
    })).rejects.toThrow();
    expect(existsSync(join(testRoot, 'outside.md'))).toBe(false);
  });
});
