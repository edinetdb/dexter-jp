import { describe, expect, test } from 'bun:test';
import { basename, dirname, relative } from 'node:path';
import {
  buildMemoFilename,
  canonicalizeMemoDocument,
  MEMO_FILENAME_TITLE_LIMIT,
  prepareWriteMemoInput,
  resolveMemoFilePath,
  sanitizeMemoFilenameTitle,
  type MemoDocument,
} from './document.js';
import { renderMemo } from './renderer.js';

const japaneseDocument: MemoDocument = {
  title: '決算 #速報「A/B」🚀',
  summary: '売上は10％増。English & 日本語を混在。',
  keyPoints: ['*重要* な結論', '../ はpathではない'],
  details: [
    {
      title: '背景【確認】',
      body: '# 内部見出しにしない\r\n---\r\n全角：！？ と `code`。',
    },
  ],
  decisions: ['案Aを採用する'],
  nextActions: ['1. 次回確認'],
  tags: ['投資', 'AI', '投資'],
  sourceContext: [{ label: '一次資料', reference: 'https://example.com/a_(b)' }],
};

describe('deterministic memo renderer', () => {
  test('renders byte-for-byte identical Japanese Markdown with fixed ordering', () => {
    const first = renderMemo(japaneseDocument, { created: '2026-09-19' });
    const second = renderMemo(japaneseDocument, { created: '2026-09-19' });

    expect(first).toBe(second);
    expect(Buffer.from(first, 'utf8').subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
      .toBe(false);
    expect(first).toStartWith(
      '---\ntitle: "決算 #速報「A/B」🚀"\ncreated: "2026-09-19"\ntags:\n  - "AI"\n  - "投資"\n---\n',
    );
    expect(first).toContain('# 決算 \\#速報「A/B」🚀');
    expect(first).toContain('\\# 内部見出しにしない\n\\---');
    expect(first).toContain('\\*重要\\* な結論');

    const orderedHeadings = ['## 概要', '## 要点', '## 詳細', '## 決定事項', '## 次のアクション', '## 出典'];
    const positions = orderedHeadings.map((heading) => first.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(first.endsWith('\n')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(false);
  });

  test('schema rejects scratchpad/reasoning fields and empty content', () => {
    expect(() => canonicalizeMemoDocument({
      title: '監査メモ',
      summary: '最終結論',
      reasoning: 'hidden chain of thought',
    })).toThrow();
    expect(() => canonicalizeMemoDocument({ title: '空のメモ' })).toThrow(
      'A memo must contain at least one content field',
    );
    expect(() => canonicalizeMemoDocument({
      title: '制御文字',
      summary: '本文\u0000混入',
    })).toThrow('unsafe control characters');
  });

  test('runtime date overwrites any model-provided date', () => {
    const prepared = prepareWriteMemoInput({
      created: '1999-01-01',
      document: { title: '日付確認', summary: '本文' },
    }, '2026-09-19');

    expect(prepared.created).toBe('2026-09-19');
  });
});

describe('memo filename safety', () => {
  test('keeps readable Japanese and emoji while removing Windows-unsafe characters', () => {
    const safe = sanitizeMemoFilenameTitle('  決算：A/B<>|?* 🚀.  ');

    expect(safe).toContain('決算：A-B');
    expect(safe).toContain('🚀');
    expect(safe).not.toMatch(/[<>:"/\\|?*]/);
    expect(safe.endsWith('.')).toBe(false);
    expect(safe.endsWith(' ')).toBe(false);
  });

  test('handles reserved devices, empty names, and long Japanese titles deterministically', () => {
    expect(sanitizeMemoFilenameTitle('CON')).toBe('CON-memo');
    expect(sanitizeMemoFilenameTitle('  <>:"/\\|?*  ')).toBe('memo');

    const longTitle = '長'.repeat(200) + '🚀';
    const safe = sanitizeMemoFilenameTitle(longTitle);
    expect(Array.from(safe).length).toBe(MEMO_FILENAME_TITLE_LIMIT);
    expect(safe).toBe(sanitizeMemoFilenameTitle(longTitle));
  });

  test('generates a deterministic in-root path without accepting a model path', () => {
    const cwd = 'C:\\workspace\\project';
    const first = resolveMemoFilePath(cwd, '../../秘密/メモ', '2026-09-19');
    const second = resolveMemoFilePath(cwd, '../../秘密/メモ', '2026-09-19');

    expect(first).toBe(second);
    expect(basename(first)).toBe(buildMemoFilename('../../秘密/メモ', '2026-09-19'));
    expect(basename(first)).toBe('20260919-秘密-メモ.md');
    expect(relative(dirname(dirname(first)), first).startsWith('..')).toBe(false);

    const absoluteLikeTitle = resolveMemoFilePath(
      cwd,
      'C:\\Windows\\System32\\drivers',
      '2026-09-19',
    );
    expect(absoluteLikeTitle.startsWith(dirname(first))).toBe(true);
    expect(basename(absoluteLikeTitle)).toBe('20260919-C-Windows-System32-drivers.md');
  });
});
