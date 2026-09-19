/**
 * Source of a skill definition.
 * - builtin: Shipped with Dexter (src/skills/builtin/)
 * - project: Project-level skills (.dexter/skills/)
 */
export type SkillSource = 'builtin' | 'user' | 'project';

/** Discovery lifecycle for a skill. */
export type SkillStatus = 'stable' | 'experimental' | 'disabled';

/** Optional code-enforced activation boundary for context-sensitive Skills. */
export type SkillActivation = 'explicit_memo';

/** Runtime capabilities required before a skill can be discovered. */
export interface SkillRequirements {
  tools?: string[];
}

/**
 * Skill metadata - lightweight info loaded at startup for system prompt injection.
 * Only contains lightweight YAML frontmatter used during discovery.
 */
export interface SkillMetadata {
  /** Unique skill name (e.g., "dcf") */
  name: string;
  /** Description of when to use this skill */
  description: string;
  /** Optional discovery lifecycle. Missing status remains discoverable. */
  status?: SkillStatus;
  /** Optional code-enforced activation boundary. */
  activation?: SkillActivation;
  /** Optional runtime capabilities required for discovery. */
  requires?: SkillRequirements;
  /** Absolute path to the SKILL.md file */
  path: string;
  /** Where this skill was discovered from */
  source: SkillSource;
}

/**
 * Full skill definition with instructions loaded on-demand.
 * Extends metadata with the full SKILL.md body content.
 */
export interface Skill extends SkillMetadata {
  /** Full instructions from SKILL.md body (loaded when skill is invoked) */
  instructions: string;
}
