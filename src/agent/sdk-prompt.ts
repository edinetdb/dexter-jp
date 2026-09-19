/**
 * System prompt for Claude Agent SDK mode.
 *
 * Reuses Dexter's stable identity, user rules, and load-bearing data-integrity
 * guardrails. Tool names and parameters come from the MCP schemas bound by the SDK.
 */
import { getCurrentDate, loadSoulDocument, loadRulesDocument } from './prompts.js';
import { buildSkillMetadataSection, discoverSkills } from '../skills/index.js';

const SDK_TOOL_POLICY = `## Data and tool policy

- Dexter tools return raw evidence; read the results and reason over them.
- Use the smallest set of calls that answers the question; independent reads may run together.
- **Identifier integrity**: any securities code or EDINET code in an answer must come from tool evidence. Look it up or omit it rather than guessing.
- **Listing status**: verify that a company is currently listed before presenting it as active or as a current investment candidate. State clearly when evidence marks it delisted.
- Verify factual claims whose current state may have changed.
- Ask a concise clarification question when required.
- Respond in the same language the user uses (Japanese or English).`;

function buildSdkSkillsSection(
  availableTools: ReadonlySet<string>,
  userQuery?: string,
): string {
  if (!availableTools.has('skill')) return '';
  const options = { availableTools, userQuery };
  if (discoverSkills(options).length === 0) return '';
  return `## Available Skills\n\n${buildSkillMetadataSection(options)}\n\nUse the \`skill\` tool once, before other work, when a listed Skill clearly matches the request.`;
}

/**
 * Build the SDK-mode system prompt. Best-effort loads soul/rules; if the
 * filesystem docs are unavailable it still returns a complete prompt.
 */
export async function buildSdkAgentSystemPrompt(
  model: string,
  channel?: string,
  availableTools: ReadonlySet<string> = new Set(),
  userQuery?: string,
): Promise<string> {
  void model; // model does not change the prompt today; kept for signature parity.
  const surface = channel === undefined || channel === 'cli' ? 'CLI' : channel;

  let soul: string | null = null;
  let rules: string | null = null;
  try {
    soul = await loadSoulDocument();
  } catch {
    soul = null;
  }
  try {
    rules = await loadRulesDocument();
  } catch {
    rules = null;
  }

  const parts: string[] = [
    `You are Dexter, a ${surface} assistant specialized in Japanese stock market research.`,
    `Current date: ${getCurrentDate()}`,
  ];

  if (soul && soul.trim()) {
    parts.push(`## About you\n\n${soul.trim()}`);
  }

  parts.push(SDK_TOOL_POLICY);

  const skills = buildSdkSkillsSection(availableTools, userQuery);
  if (skills) parts.push(skills);

  if (rules && rules.trim()) {
    parts.push(
      `## Research rules\n\n${rules.trim()}`,
    );
  }

  return parts.join('\n\n');
}
