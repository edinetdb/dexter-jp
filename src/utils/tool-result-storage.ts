/**
 * Run-scoped offloading for large tool results.
 *
 * When a tool result exceeds the size cap, the full result is saved temporarily
 * and a compact preview + file path replaces it in the message array.
 * The model can read it via read_file during the run; the run directory is then removed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { dexterPath } from './paths.js';

/** Maximum characters for a single tool result in context. */
export const MAX_TOOL_RESULT_CHARS = 50_000;

/** Characters to include in the preview when a result is persisted. */
export const PREVIEW_CHARS = 2_000;

const RESULTS_DIR = dexterPath('tool-results');

/**
 * Owns temporary tool-result files for one Agent.run invocation.
 */
export class TransientToolResultStore {
  private readonly rootDir: string;
  private runDir: string | null = null;
  private disposed = false;

  constructor(baseDir: string = RESULTS_DIR) {
    this.rootDir = resolve(baseDir);
  }

  persist(
    toolName: string,
    toolCallId: string,
    result: string,
  ): { preview: string; filePath: string } {
    if (this.disposed) {
      throw new Error('Transient tool-result store is already disposed.');
    }

    if (!this.runDir) {
      mkdirSync(this.rootDir, { recursive: true });
      this.runDir = mkdtempSync(join(this.rootDir, 'run-'));
    }

    const sanitizedTool = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const sanitizedId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = join(this.runDir, sanitizedTool + '-' + sanitizedId + '.txt');
    writeFileSync(filePath, result, 'utf-8');

    return {
      preview: result.slice(0, PREVIEW_CHARS),
      filePath,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    if (!this.runDir) {
      this.disposed = true;
      return;
    }

    const resolvedRunDir = resolve(this.runDir);
    const rel = relative(this.rootDir, resolvedRunDir);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Refusing to remove a tool-result path outside its run root.');
    }

    rmSync(resolvedRunDir, { recursive: true, force: true });
    this.disposed = true;
  }
}

/**
 * Build the replacement content for a temporarily offloaded tool result.
 */
export function buildPersistedContent(
  filePath: string,
  preview: string,
  originalSizeBytes: number,
): string {
  const sizeKB = Math.round(originalSizeBytes / 1024);
  return `[Result temporarily offloaded to ${filePath} (${sizeKB} KB)]\n\nPreview:\n${preview}\n\nUse read_file to access the full result if needed.`;
}

/**
 * Check if a result exceeds the size cap.
 */
export function exceedsSizeCap(content: string): boolean {
  return content.length > MAX_TOOL_RESULT_CHARS;
}
