import {
  canonicalizeMemoDocument,
  memoCreatedDateSchema,
  type MemoDocument,
} from './document.js';

export interface MemoRenderContext {
  created: string;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function escapeMarkdownLine(line: string): string {
  let escaped = line
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]<>#|~])/g, '\\$1');
  escaped = escaped.replace(/^(\s*)([-+>=])/, '$1\\$2');
  escaped = escaped.replace(/^(\s*\d+)\.(?=\s)/, '$1\\.');
  return escaped;
}

function escapeMarkdownBlock(value: string): string {
  return value.split('\n').map(escapeMarkdownLine).join('\n');
}

function escapeMarkdownInline(value: string): string {
  return escapeMarkdownLine(value.replace(/\s*\n\s*/g, ' '));
}

function renderBullets(title: string, items: string[]): string[] {
  return [
    `## ${title}`,
    '',
    ...items.map((item) => `- ${escapeMarkdownInline(item)}`),
  ];
}

/** Pure renderer: all environment-dependent values arrive through `context`. */
export function renderMemo(documentInput: MemoDocument, context: MemoRenderContext): string {
  const document = canonicalizeMemoDocument(documentInput);
  const created = memoCreatedDateSchema.parse(context.created);
  const lines: string[] = [
    '---',
    `title: ${yamlString(document.title)}`,
    `created: ${yamlString(created)}`,
  ];

  if (document.tags?.length) {
    lines.push('tags:');
    for (const tag of document.tags) lines.push(`  - ${yamlString(tag)}`);
  }

  lines.push('---', '', `# ${escapeMarkdownInline(document.title)}`);

  if (document.summary) {
    lines.push('', '## 概要', '', escapeMarkdownBlock(document.summary));
  }
  if (document.keyPoints?.length) {
    lines.push('', ...renderBullets('要点', document.keyPoints));
  }
  if (document.details?.length) {
    lines.push('', '## 詳細');
    for (const section of document.details) {
      lines.push(
        '',
        `### ${escapeMarkdownInline(section.title)}`,
        '',
        escapeMarkdownBlock(section.body),
      );
    }
  }
  if (document.decisions?.length) {
    lines.push('', ...renderBullets('決定事項', document.decisions));
  }
  if (document.nextActions?.length) {
    lines.push('', ...renderBullets('次のアクション', document.nextActions));
  }
  if (document.sourceContext?.length) {
    lines.push('', '## 出典', '');
    for (const source of document.sourceContext) {
      const label = escapeMarkdownInline(source.label);
      const reference = source.reference
        ? ` — ${escapeMarkdownInline(source.reference)}`
        : '';
      lines.push(`- ${label}${reference}`);
    }
  }

  return `${lines.join('\n').replace(/\n+$/g, '')}\n`;
}
