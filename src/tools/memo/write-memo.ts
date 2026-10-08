import { DynamicStructuredTool } from '@langchain/core/tools';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { formatToolResult } from '../types.js';
import { assertSandboxPath } from '../filesystem/sandbox.js';
import {
  canonicalizePreparedWriteMemoInput,
  MEMO_DIRECTORY,
  resolveMemoFilePath,
  writeMemoInputSchema,
} from '../../memo/document.js';
import { renderMemo } from '../../memo/renderer.js';

export const WRITE_MEMO_DESCRIPTION = `
Create one deterministic Japanese-safe Markdown memo from structured content.

Use only after the write-memo Skill has been invoked for an explicit memo request.
The runtime owns frontmatter, section order, escaping, date, filename, and storage path.
This operation is create-only: it never overwrites, appends to, or updates an existing memo.
The system asks for exact-operation approval before writing.
`.trim();

export interface WriteMemoToolOptions {
  cwd?: string;
}

function portablePath(path: string): string {
  return path.replace(/\\/g, '/');
}

export function createWriteMemoTool(
  options: WriteMemoToolOptions = {},
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'write_memo',
    description: WRITE_MEMO_DESCRIPTION,
    schema: writeMemoInputSchema,
    func: async (input) => {
      const cwd = options.cwd ?? process.cwd();
      const prepared = canonicalizePreparedWriteMemoInput(input);
      const resolvedPath = resolveMemoFilePath(
        cwd,
        prepared.document.title,
        prepared.created,
      );
      const { resolved } = await assertSandboxPath({
        filePath: resolvedPath,
        cwd,
        root: cwd,
      });
      const markdown = renderMemo(prepared.document, { created: prepared.created });

      await mkdir(dirname(resolved), { recursive: true });
      try {
        await writeFile(resolved, markdown, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if ((error as { code?: string }).code === 'EEXIST') {
          throw new Error(
            'Memo already exists. This create-only workflow will not overwrite or append: ' +
            portablePath(relative(cwd, resolved)),
          );
        }
        throw error;
      }

      const outputPath = portablePath(relative(cwd, resolved));
      return formatToolResult({
        path: outputPath || MEMO_DIRECTORY,
        title: prepared.document.title,
        bytesWritten: Buffer.byteLength(markdown, 'utf8'),
        message: `Memo created at ${outputPath}`,
      });
    },
  });
}

export const writeMemoTool = createWriteMemoTool();
