import { existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SkillMetadata, Skill, SkillSource } from './types.js';
import { extractSkillMetadata, loadSkillFromPath } from './loader.js';
import { dexterPath } from '../utils/paths.js';
import { hasExplicitMemoIntent } from './memo-intent.js';

// Get the directory of this file to locate builtin skills
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Skill directories in order of precedence (later overrides earlier).
 */
const SKILL_DIRECTORIES: { path: string; source: SkillSource }[] = [
  { path: __dirname, source: 'builtin' },
  { path: join(process.cwd(), dexterPath('skills')), source: 'project' },
];

// Cache all parsed metadata; runtime capability filtering happens per discovery call.
let skillMetadataCache: Map<string, SkillMetadata> | null = null;

export interface SkillDiscoveryOptions {
  /** Names of tools actually available in the current runtime. */
  availableTools?: ReadonlySet<string>;
  /** Current user turn used only by code-enforced activation boundaries. */
  userQuery?: string;
}

/** Determine whether a parsed skill is eligible for model-facing discovery. */
export function isSkillDiscoverable(
  skill: SkillMetadata,
  { availableTools, userQuery }: SkillDiscoveryOptions = {},
): boolean {
  if (skill.status === 'disabled') {
    return false;
  }
  if (
    (skill.name === 'write-memo' || skill.activation === 'explicit_memo') &&
    !hasExplicitMemoIntent(userQuery)
  ) {
    return false;
  }

  const requiredTools = skill.requires?.tools ?? [];
  return requiredTools.length === 0
    || (availableTools !== undefined && requiredTools.every((tool) => availableTools.has(tool)));
}

/**
 * Scan a directory for SKILL.md files and return their metadata.
 * Looks for directories containing SKILL.md files.
 *
 * @param dirPath - Directory to scan
 * @param source - Source type for discovered skills
 * @returns Array of skill metadata
 */
function scanSkillDirectory(dirPath: string, source: SkillSource): SkillMetadata[] {
  if (!existsSync(dirPath)) {
    return [];
  }

  const skills: SkillMetadata[] = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillFilePath = join(dirPath, entry.name, 'SKILL.md');
      if (existsSync(skillFilePath)) {
        try {
          const metadata = extractSkillMetadata(skillFilePath, source);
          skills.push(metadata);
        } catch {
          // Invalid skill files are not safe to advertise.
        }
      }
    }
  }

  return skills;
}

/**
 * Discover skills eligible for the current runtime.
 * Later sources (project > user > builtin) override earlier ones.
 *
 * @param options - Runtime capabilities used to filter parsed metadata
 * @returns Discoverable skill metadata, deduplicated by name
 */
export function discoverSkills(options: SkillDiscoveryOptions = {}): SkillMetadata[] {
  if (!skillMetadataCache) {
    skillMetadataCache = new Map();

    for (const { path, source } of SKILL_DIRECTORIES) {
      const skills = scanSkillDirectory(path, source);
      for (const skill of skills) {
        // Later sources override earlier ones (by name)
        skillMetadataCache.set(skill.name, skill);
      }
    }
  }

  return Array.from(skillMetadataCache.values())
    .filter((skill) => isSkillDiscoverable(skill, options));
}

/**
 * Get a discoverable skill by name, loading full instructions.
 *
 * @param name - Name of the skill to load
 * @param options - Runtime capabilities used to enforce discovery eligibility
 * @returns Full skill definition or undefined if unavailable
 */
export function getSkill(name: string, options: SkillDiscoveryOptions = {}): Skill | undefined {
  // Ensure cache is populated
  if (!skillMetadataCache) {
    discoverSkills(options);
  }

  const metadata = skillMetadataCache?.get(name);
  if (!metadata || !isSkillDiscoverable(metadata, options)) {
    return undefined;
  }

  // Load full skill with instructions
  return loadSkillFromPath(metadata.path, metadata.source);
}

/**
 * Build the skill metadata section for the system prompt.
 * Only includes name and description (lightweight).
 *
 * @param options - Runtime capabilities used to filter model-visible skills
 * @returns Formatted string for system prompt injection
 */
export function buildSkillMetadataSection(options: SkillDiscoveryOptions = {}): string {
  const skills = discoverSkills(options);

  if (skills.length === 0) {
    return 'No skills available.';
  }

  return skills
    .map((s) => `- **${s.name}**: ${s.description}`)
    .join('\n');
}

/**
 * Clear the skill cache. Useful for testing or when skills are added/removed.
 */
export function clearSkillCache(): void {
  skillMetadataCache = null;
}
