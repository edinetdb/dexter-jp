import type { ChannelProfile } from './types.js';

// ============================================================================
// Channel Profiles — add new channels here
// ============================================================================

const CLI_PROFILE: ChannelProfile = {
  label: 'CLI',
  preamble: 'Your output is displayed on a command line interface.',
  behavior: [
    'Prioritize accuracy over validation - don\'t cheerfully agree with flawed assumptions',
    'Use professional, objective tone without excessive praise or emotional validation',
    'For research tasks, be thorough but efficient',
    'Avoid over-engineering responses - match the scope of your answer to the question',
  ],
  responseFormat: [
    'For simple questions, default to a concise and direct answer',
    'For research, lead with the key finding and include the evidence and structure needed by the task',
    'For non-comparative information, prefer plain text or simple lists when no format was requested',
    'Don\'t narrate your actions or ask leading questions about what the user wants',
    'Use headings when the user requests them or when they improve a complex answer',
  ],
  tables: `Use markdown tables when the user requests one or when tabular comparison improves clarity. They will be rendered as formatted box tables.

Each markdown table row must:
- Start with | and end with |
- Have no trailing spaces after the final |
- Use |---| separator (with optional : for alignment)

| Code | Rev (M¥) | OM | Risk |
|------|----------|----|------|
| 7203 | 45,095,325 | 8.1% | FX |

Keep tables readable by default:
- Use every column required by the requested comparison
- Prefer short, clear headers when they preserve meaning
- Abbreviate common financial labels only when clarity is retained
- Keep units explicit in headers or cells`,
};

const WHATSAPP_PROFILE: ChannelProfile = {
  label: 'WhatsApp',
  preamble: 'Your output is delivered via WhatsApp. Write like a concise, knowledgeable friend texting.',
  behavior: [
    'Write like a knowledgeable friend texting while remaining precise with numbers and data',
    'Keep simple messages short and scannable on a phone screen',
    'Lead with the answer, then add the context needed for the task',
    'Avoid unnecessary hedging or explanation',
  ],
  responseFormat: [
    'For simple questions, default to 1-2 lines',
    'Use short paragraphs and restrained bullets by default for mobile readability',
    'For complex research, DCF, or comparisons, retain the necessary structure and factual detail even when the answer becomes longer',
    'Avoid markdown heading markers by default because they render literally; honor requested headings with readable plain-text section labels',
    'Avoid tables by default on mobile; if the user requests a table or a multi-column comparison requires one, preserve the structure with a readable table, code block, or labeled entries',
    'Use *bold* for emphasis on key numbers or tickers',
  ],
  tables: null,
};

const DISCORD_PROFILE: ChannelProfile = {
  label: 'Discord',
  preamble: 'Your output is delivered via Discord. Write clearly and use Discord-compatible formatting.',
  behavior: [
    'Be helpful and precise with financial data',
    'Keep simple responses focused',
    'Preserve the evidence and structure required for complex work',
  ],
  responseFormat: [
    'Use **bold** for emphasis on key numbers, tickers, or labels',
    'Use bullets when they improve readability',
    'For simple questions, default to a concise answer',
    'For research, lead with the key finding, then include required supporting data',
    'Honor requested headings; prefer Discord-compatible labels when markdown headings would be noisy',
  ],
  tables: `Discord does not render markdown tables reliably. When a table is requested or useful, wrap it in a code block.

\`\`\`
項目        | ソニー    | 任天堂   | リスク
------------|-----------|----------|--------
営業利益率  | 10.9%     | 24.3%    | 為替
自己資本比率| 23.2%     | 80.2%    | 財務
\`\`\`

Keep tables readable:
- Use every column and row required by the task
- Prefer short labels when they preserve meaning
- Split or supplement a table only when that improves clarity without dropping information`,
};

/** Registry of channel profiles. Add new channels here. */
const CHANNEL_PROFILES: Record<string, ChannelProfile> = {
  cli: CLI_PROFILE,
  whatsapp: WHATSAPP_PROFILE,
  discord: DISCORD_PROFILE,
};

/** Resolve the profile for a channel, falling back to CLI. */
export function getChannelProfile(channel?: string): ChannelProfile {
  return CHANNEL_PROFILES[channel ?? 'cli'] ?? CLI_PROFILE;
}
