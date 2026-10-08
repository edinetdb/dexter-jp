import { buildSkillMetadataSection, discoverSkills } from '../skills/index.js';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChannelProfile } from './channels.js';
import { dexterPath } from '../utils/paths.js';
import { COMPLETION_CONTRACT } from './execution-contracts.js';
import { CLARIFICATION_POLICY, OUTPUT_PRIORITY_POLICY } from './prompt-policies.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Returns the current date formatted for prompts.
 */
export function getCurrentDate(): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  };
  return new Date().toLocaleDateString('en-US', options);
}

/**
 * Load user-defined research rules from .dexter/RULES.md.
 * Returns null if the file doesn't exist (rules are optional).
 */
export async function loadRulesDocument(): Promise<string | null> {
  const rulesPath = dexterPath('RULES.md');
  try {
    return await readFile(rulesPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Load SOUL.md content from user override or bundled file.
 */
export async function loadSoulDocument(): Promise<string | null> {
  const userSoulPath = dexterPath('SOUL.md');
  try {
    return await readFile(userSoulPath, 'utf-8');
  } catch {
    // Continue to bundled fallback when user override is missing/unreadable.
  }

  const bundledSoulPath = join(__dirname, '../../SOUL.md');
  try {
    return await readFile(bundledSoulPath, 'utf-8');
  } catch {
    // SOUL.md is optional; keep prompt behavior unchanged when absent.
  }

  return null;
}

/**
 * Build the skills section for the system prompt.
 * Only includes skill metadata if skills are available.
 */
function buildSkillsSection(
  availableTools: ReadonlySet<string>,
  userQuery?: string,
): string {
  const discoveryOptions = { availableTools, userQuery };
  const skills = discoverSkills(discoveryOptions);

  if (skills.length === 0) {
    return '';
  }

  return `## Available Skills

${buildSkillMetadataSection(discoveryOptions)}

Use the \`skill\` tool once, before other work, when a listed Skill clearly matches the request.`;
}

function buildMemorySection(
  availableTools: ReadonlySet<string>,
  memoryContext?: string | null,
  memoryEnabled = true,
): string {
  if (!memoryEnabled) {
    return '';
  }

  const context = memoryContext?.trim();
  const canSearch = availableTools.has('memory_search');
  const canGet = availableTools.has('memory_get');
  const canUpdate = availableTools.has('memory_update');

  if (!context && !canSearch && !canGet && !canUpdate) {
    return '';
  }

  const lines = ['## Memory'];
  if (context) {
    lines.push('', '### User context', '', context);
  }
  if (canSearch) {
    lines.push('', 'Use memory_search before answering when prior user context may affect the answer, including stated preferences, research themes, and earlier /check runs.');
  }
  if (canGet) {
    lines.push('Use memory_get when exact stored text is needed.');
  }
  if (canUpdate) {
    lines.push('Use memory_update—not file tools—for user-requested memory changes.');
  }

  return lines.join('\n');
}
// ============================================================================
// Default System Prompt (for backward compatibility)
// ============================================================================

/**
 * Default system prompt used when no specific prompt is provided.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Dexter, a helpful AI assistant specialized in Japanese stock market research.

Current date: ${getCurrentDate()}

Your output is displayed on a command line interface.

${CLARIFICATION_POLICY}

${OUTPUT_PRIORITY_POLICY}

## Behavior

- Prioritize accuracy over validation
- Use professional, objective tone
- Be thorough but efficient
- Respond in the same language the user uses (Japanese or English)

## Response Format

- For simple questions, default to a brief and direct answer
- Use the structure and detail required for research or comparison tasks
- Prefer plain text or simple lists when no other format is requested
- Use headings when requested or helpful for complex work

## Tables

Use markdown tables when requested or when they improve a comparison.

Each markdown table row must:
- Start with | and end with |
- Have no trailing spaces after the final |
- Use |---| separator (with optional : for alignment)

Use all columns required by the task. Prefer compact labels and explicit units when they preserve clarity.`;

// ============================================================================
// Group Chat Context
// ============================================================================

export type GroupContext = {
  groupName?: string;
  membersList?: string;
  activationMode: 'mention';
};

/**
 * Build a system prompt section for group chat context.
 */
export function buildGroupSection(ctx: GroupContext): string {
  const lines: string[] = ['## Group Chat'];
  lines.push('');
  if (ctx.groupName) {
    lines.push(`You are participating in the WhatsApp group "${ctx.groupName}".`);
  } else {
    lines.push('You are participating in a WhatsApp group chat.');
  }
  lines.push('You were activated because someone @-mentioned you.');
  lines.push('');
  lines.push('### Group behavior');
  lines.push('- Address the person who mentioned you by name');
  lines.push('- Reference recent group context when relevant');
  lines.push('- Default to concise replies while preserving content required by the task');
  lines.push('- Do not repeat information that was already shared in the group');

  if (ctx.membersList) {
    lines.push('');
    lines.push('### Group members');
    lines.push(ctx.membersList);
  }

  return lines.join('\n');
}

// ============================================================================
// System Prompt
// ============================================================================

/**
 * Build the system prompt for the agent.
 * @param model - Model name retained for API compatibility
 * @param soulContent - Optional SOUL.md identity content
 * @param channel - Delivery channel (e.g., 'whatsapp', 'cli') — selects formatting profile
 * @param rulesContent - Optional .dexter/RULES.md content for user-defined research rules
 * @param availableTools - Names of tools actually bound to this agent runtime
 * @param memoryEnabled - Whether persistent-memory behavior is enabled for this agent
 */
export function buildSystemPrompt(
  model: string,
  soulContent?: string | null,
  channel?: string,
  groupContext?: GroupContext,
  memoryFiles?: string[],
  memoryContext?: string | null,
  rulesContent?: string | null,
  availableTools: ReadonlySet<string> = new Set(),
  memoryEnabled = true,
  userQuery?: string,
): string {
  // Kept for API compatibility; tool schemas are bound separately by the runtime.
  void model;
  void memoryFiles;

  const profile = getChannelProfile(channel);
  const behaviorBullets = profile.behavior.map((item) => `- ${item}`).join('\n');
  const formatBullets = profile.responseFormat.map((item) => `- ${item}`).join('\n');
  const tablesSection = profile.tables
    ? `\n## Tables (for comparative/tabular data)\n\n${profile.tables}`
    : '';

  const sections = [
    `You are Dexter, a ${profile.label} assistant specialized in Japanese stock market research.\n\nCurrent date: ${getCurrentDate()}\n\n${profile.preamble}`,
    `## Data integrity\n\n- Use tools when a request requires external or current data, and base conclusions on returned evidence.\n- Any securities code or EDINET code in an answer must come from tool evidence; look it up or omit it rather than guessing.\n- Verify listing status before presenting a company as currently listed or as a current investment candidate. If evidence marks it delisted, say so and do not present it as active.\n- Verify facts whose current state may have changed.\n- If a tool result was persisted to a file, use read_file to inspect the needed sections.`,
    CLARIFICATION_POLICY,
    OUTPUT_PRIORITY_POLICY,
    buildSkillsSection(availableTools, userQuery),
    buildMemorySection(availableTools, memoryContext, memoryEnabled),
    COMPLETION_CONTRACT,
    `## Behavior\n\n${behaviorBullets}\n- Respond in the same language the user uses (Japanese or English).`,
    rulesContent?.trim() ? `## Research Rules\n\n${rulesContent.trim()}` : '',
    soulContent?.trim() ? `## Identity\n\n${soulContent.trim()}` : '',
    `## Response Format\n\n${formatBullets}${tablesSection}${groupContext ? '\n\n' + buildGroupSection(groupContext) : ''}`,
  ];

  return sections.filter(Boolean).join('\\n\\n');
}
// ============================================================================
// User Prompts
// ============================================================================


