export interface SlashCommand {
  name: string;
  description: string;
}

export * from './parse.js';

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'check', description: '仮説を有価証券報告書の段落に当てる（/check <銘柄> <仮説>）' },
  { name: 'watch', description: 'ウォッチリストの銘柄に出た開示を並べる' },
  { name: 'model', description: 'Switch LLM provider and model' },
  { name: 'search', description: 'Choose preferred web search provider' },
  { name: 'rules', description: 'Show your research rules' },
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'memory', description: 'Show what Dexter remembers about you' },
  { name: 'heartbeat', description: 'Show your heartbeat monitoring checklist' },
  { name: 'history', description: 'Show recent conversation summaries' },
  { name: 'help', description: 'Show keyboard shortcuts and tips' },
];

/**
 * Filter commands matching the current input.
 * Input should start with "/". Bare "/" returns all commands.
 */
export function matchCommands(input: string): SlashCommand[] {
  const query = input.slice(1).toLowerCase();
  if (query === '') return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(cmd => cmd.name.startsWith(query));
}
