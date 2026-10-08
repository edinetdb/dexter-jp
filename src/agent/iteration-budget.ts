/** Hard runtime budget predicate shared by the agent loop and its tests. */
export function hasRemainingIterationBudget(
  completedIterations: number,
  maxIterations: number,
): boolean {
  return completedIterations < maxIterations;
}
