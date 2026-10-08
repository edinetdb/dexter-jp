import { relative, resolve } from 'node:path';
import { runAcceptanceSuite, writeFailureArtifact } from './runner.js';
import type { AcceptanceReport } from './types.js';

function portable(path: string): string {
  return path.replace(/\\/g, '/');
}

function formatHuman(report: AcceptanceReport): string {
  const lines = [
    `Phase 8 practical acceptance: ${report.result}`,
    `Mode: ${report.mode} (live calls: no; X: ${report.evidence.xCapability})`,
    `Scenarios: ${report.passed}/${report.scenarioCount} passed; turns: ${report.turnCount}; multi-turn: ${report.multiTurnScenarioCount}`,
    `Critical failures: ${report.criticalFailures.length}`,
  ];

  const categoryCounts = new Map<string, { passed: number; total: number }>();
  for (const result of report.cases) {
    const count = categoryCounts.get(result.category) ?? { passed: 0, total: 0 };
    count.total += 1;
    if (result.passed) count.passed += 1;
    categoryCounts.set(result.category, count);
  }
  lines.push('Categories:');
  for (const [category, count] of categoryCounts) {
    lines.push(`  ${category}: ${count.passed}/${count.total}`);
  }

  if (report.findings.length === 0) {
    lines.push('Product findings: NONE');
  } else {
    lines.push('Findings:');
    for (const finding of report.findings) {
      lines.push(`  ${finding.scenarioId} [${finding.classification}]: ${finding.summary}`);
    }
  }
  return lines.join('\n');
}

const json = process.argv.includes('--json');
const report = await runAcceptanceSuite();
if (report.result === 'FAIL') {
  const artifact = await writeFailureArtifact(
    report,
    resolve(process.cwd(), '.dexter', 'evals', 'phase8-acceptance-failures.json'),
  );
  if (artifact && !json) {
    console.error(`Failure artifact: ${portable(relative(process.cwd(), artifact))}`);
  }
}

console.log(json ? JSON.stringify(report, null, 2) : formatHuman(report));
if (report.result !== 'PASS') process.exitCode = 1;