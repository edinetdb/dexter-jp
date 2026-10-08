import { readFileSync } from 'fs';
import matter from 'gray-matter';
import type {
  Skill,
  SkillActivation,
  SkillMetadata,
  SkillRequirements,
  SkillSource,
  SkillStatus,
} from './types.js';

const VALID_SKILL_STATUSES = new Set<SkillStatus>(['stable', 'experimental', 'disabled']);
const VALID_SKILL_ACTIVATIONS = new Set<SkillActivation>(['explicit_memo']);

type ParsedFrontmatter = Pick<
  SkillMetadata,
  'name' | 'description' | 'status' | 'activation' | 'requires'
>;

function parseRequirements(value: unknown, path: string): SkillRequirements | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Skill at ${path} has invalid 'requires' frontmatter; expected an object`);
  }

  const tools = (value as Record<string, unknown>).tools;
  if (tools === undefined) {
    return undefined;
  }
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string' || tool.trim().length === 0)) {
    throw new Error(`Skill at ${path} has invalid 'requires.tools' frontmatter; expected an array of non-empty strings`);
  }

  const normalizedTools = tools as string[];
  return { tools: [...new Set(normalizedTools.map((tool) => tool.trim()))] };
}

function parseFrontmatter(data: Record<string, unknown>, path: string): ParsedFrontmatter {
  if (!data.name || typeof data.name !== 'string') {
    throw new Error(`Skill at ${path} is missing required 'name' field in frontmatter`);
  }
  if (!data.description || typeof data.description !== 'string') {
    throw new Error(`Skill at ${path} is missing required 'description' field in frontmatter`);
  }

  const status = data.status;
  if (status !== undefined && (typeof status !== 'string' || !VALID_SKILL_STATUSES.has(status as SkillStatus))) {
    throw new Error(`Skill at ${path} has invalid 'status' frontmatter; expected stable, experimental, or disabled`);
  }

  const parsed: ParsedFrontmatter = {
    name: data.name,
    description: data.description,
  };
  if (status !== undefined) {
    parsed.status = status as SkillStatus;
  }

  const activation = data.activation;
  if (
    activation !== undefined &&
    (typeof activation !== 'string' || !VALID_SKILL_ACTIVATIONS.has(activation as SkillActivation))
  ) {
    throw new Error(`Skill at ${path} has invalid 'activation' frontmatter; expected explicit_memo`);
  }
  if (activation !== undefined) {
    parsed.activation = activation as SkillActivation;
  }

  const requires = parseRequirements(data.requires, path);
  if (requires !== undefined) {
    parsed.requires = requires;
  }
  return parsed;
}

/**
 * Parse a SKILL.md file content into a Skill object.
 * Extracts YAML frontmatter and the markdown body (instructions).
 *
 * @param content - Raw file content
 * @param path - Absolute path to the file (for reference)
 * @param source - Where this skill came from
 * @returns Parsed Skill object
 * @throws Error if required or recognized optional frontmatter is invalid
 */
export function parseSkillFile(content: string, path: string, source: SkillSource): Skill {
  const { data, content: instructions } = matter(content);
  const metadata = parseFrontmatter(data, path);

  return {
    ...metadata,
    path,
    source,
    instructions: instructions.trim(),
  };
}

/**
 * Load a skill from a file path.
 *
 * @param path - Absolute path to the SKILL.md file
 * @param source - Where this skill came from
 * @returns Parsed Skill object
 * @throws Error if file cannot be read or parsed
 */
export function loadSkillFromPath(path: string, source: SkillSource): Skill {
  const content = readFileSync(path, 'utf-8');
  return parseSkillFile(content, path, source);
}

/**
 * Extract just the metadata from a skill file without loading full instructions.
 * Used for lightweight discovery at startup.
 *
 * @param path - Absolute path to the SKILL.md file
 * @param source - Where this skill came from
 * @returns Parsed skill metadata
 */
export function extractSkillMetadata(path: string, source: SkillSource): SkillMetadata {
  const content = readFileSync(path, 'utf-8');
  const { data } = matter(content);
  const metadata = parseFrontmatter(data, path);

  return {
    ...metadata,
    path,
    source,
  };
}
