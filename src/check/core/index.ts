/**
 * Barrel export for src/check/core — the pure post-processing layer of
 * /check. See design-v0.md §4.2. Nothing exported from here does network,
 * file, or LLM I/O; callers (src/check/, src/judge/) own the actual judge
 * calls and pass their results through the functions here.
 */

export * from './types.js';
export * from './claims.js';
export * from './paragraphs.js';
export * from './numeric-check.js';
