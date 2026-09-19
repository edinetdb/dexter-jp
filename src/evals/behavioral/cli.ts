import { renderHumanReport, runBehavioralEval } from './runner.js';

async function main(): Promise<void> {
  const report = await runBehavioralEval();
  const jsonOnly = process.argv.includes('--json');

  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderHumanReport(report));
    console.log('\nMachine-readable output: bun run eval:json');
  }

  if (report.result !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});