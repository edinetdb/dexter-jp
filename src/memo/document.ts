import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

export const MEMO_DIRECTORY = join('.dexter', 'memos');
export const MEMO_FILENAME_TITLE_LIMIT = 80;

const forbiddenControlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const inlineTextSchema = z.string().min(1).max(240)
  .refine((value) => !forbiddenControlCharacters.test(value), 'Text contains unsafe control characters.');
const blockTextSchema = z.string().min(1).max(50_000)
  .refine((value) => !forbiddenControlCharacters.test(value), 'Text contains unsafe control characters.');

export const memoDocumentSchema = z.object({
  title: inlineTextSchema,
  summary: blockTextSchema.optional(),
  keyPoints: z.array(blockTextSchema).min(1).max(30).optional(),
  details: z.array(z.object({
    title: inlineTextSchema,
    body: blockTextSchema,
  }).strict()).min(1).max(30).optional(),
  decisions: z.array(blockTextSchema).min(1).max(30).optional(),
  nextActions: z.array(blockTextSchema).min(1).max(30).optional(),
  tags: z.array(inlineTextSchema.max(64)).min(1).max(20).optional(),
  sourceContext: z.array(z.object({
    label: inlineTextSchema,
    reference: blockTextSchema.max(2_000).optional(),
  }).strict()).min(1).max(30).optional(),
}).strict().superRefine((document, context) => {
  if (
    !document.summary &&
    !document.keyPoints?.length &&
    !document.details?.length &&
    !document.decisions?.length &&
    !document.nextActions?.length &&
    !document.sourceContext?.length
  ) {
    context.addIssue({
      code: 'custom',
      message: 'A memo must contain at least one content field.',
    });
  }
});

export const memoCreatedDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'created must use YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'created must be a valid calendar date');

/** `created` is injected by operation normalization, not chosen by the model. */
export const writeMemoInputSchema = z.object({
  document: memoDocumentSchema,
  created: memoCreatedDateSchema.optional().describe('Runtime-managed creation date; omit this field.'),
}).strict();

export type MemoDocument = z.infer<typeof memoDocumentSchema>;
export type WriteMemoInput = z.infer<typeof writeMemoInputSchema>;
export type PreparedWriteMemoInput = WriteMemoInput & { created: string };

function normalizeBlock(value: string): string {
  return value.normalize('NFC').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

function normalizeInline(value: string): string {
  return normalizeBlock(value).replace(/\s*\n\s*/g, ' ').replace(/[\t ]+/g, ' ');
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

/** Canonicalize model content before approval, rendering, and execution. */
export function canonicalizeMemoDocument(input: unknown): MemoDocument {
  const parsed = memoDocumentSchema.parse(input);
  const document: MemoDocument = {
    title: normalizeInline(parsed.title),
    ...(parsed.summary !== undefined ? { summary: normalizeBlock(parsed.summary) } : {}),
    ...(parsed.keyPoints ? { keyPoints: parsed.keyPoints.map(normalizeInline) } : {}),
    ...(parsed.details ? {
      details: parsed.details.map((section) => ({
        title: normalizeInline(section.title),
        body: normalizeBlock(section.body),
      })),
    } : {}),
    ...(parsed.decisions ? { decisions: parsed.decisions.map(normalizeInline) } : {}),
    ...(parsed.nextActions ? { nextActions: parsed.nextActions.map(normalizeInline) } : {}),
    ...(parsed.tags ? { tags: uniqueSorted(parsed.tags.map(normalizeInline)) } : {}),
    ...(parsed.sourceContext ? {
      sourceContext: parsed.sourceContext.map((source) => ({
        label: normalizeInline(source.label),
        ...(source.reference !== undefined ? { reference: normalizeInline(source.reference) } : {}),
      })),
    } : {}),
  };
  return memoDocumentSchema.parse(document);
}

export function prepareWriteMemoInput(
  rawInput: unknown,
  created: string,
): PreparedWriteMemoInput {
  memoCreatedDateSchema.parse(created);
  const parsed = writeMemoInputSchema.parse(rawInput);
  return {
    document: canonicalizeMemoDocument(parsed.document),
    // Always overwrite model-provided values with the runtime-owned date.
    created,
  };
}

export function canonicalizePreparedWriteMemoInput(rawInput: unknown): PreparedWriteMemoInput {
  const parsed = writeMemoInputSchema.parse(rawInput);
  if (!parsed.created) {
    throw new Error('Memo writes require a runtime-managed creation date.');
  }
  return {
    document: canonicalizeMemoDocument(parsed.document),
    created: memoCreatedDateSchema.parse(parsed.created),
  };
}

export function formatLocalMemoDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const WINDOWS_RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Preserve readable Japanese while removing only filesystem-unsafe content. */
export function sanitizeMemoFilenameTitle(title: string): string {
  let safe = normalizeInline(title)
    .replace(/[\u0000-\u001F\u007F<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '');

  if (!safe) safe = 'memo';
  if (WINDOWS_RESERVED_DEVICE.test(safe)) safe = `${safe}-memo`;

  safe = Array.from(safe).slice(0, MEMO_FILENAME_TITLE_LIMIT).join('')
    .replace(/[. -]+$/g, '');
  return safe || 'memo';
}

export function buildMemoFilename(title: string, created: string): string {
  memoCreatedDateSchema.parse(created);
  const datePart = created.replace(/-/g, '');
  return `${datePart}-${sanitizeMemoFilenameTitle(title)}.md`;
}

export function resolveMemoFilePath(
  cwd: string,
  title: string,
  created: string,
): string {
  const root = resolve(cwd, MEMO_DIRECTORY);
  const target = resolve(root, buildMemoFilename(title, created));
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Memo path escaped the memo storage directory.');
  }
  return target;
}
