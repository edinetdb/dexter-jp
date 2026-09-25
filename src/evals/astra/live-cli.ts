import { ASTRA_LIVE_CASES, runAstraLiveSmoke } from './live.js';

const execute = process.argv.includes('--execute');
const list = process.argv.includes('--list') || !execute;

if (list) {
  console.log('Astra live smoke cases (read-only, bounded):');
  for (const item of ASTRA_LIVE_CASES) {
    console.log('- ' + item.id + ': ' + item.purpose);
  }
}

if (!execute) {
  console.log('ASTRA LIVE VALIDATION: NOT EXECUTED');
  process.exit(0);
}

if (process.env.DEXTER_ASTRA_LIVE !== '1') {
  console.error('Refusing live execution. Set DEXTER_ASTRA_LIVE=1 and pass --execute.');
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error('Refusing live execution. OPENAI_API_KEY is required.');
  process.exit(1);
}

const report = await runAstraLiveSmoke(true);
console.log('ASTRA LIVE VALIDATION: ' + report.status);
for (const item of report.cases) {
  console.log('- ' + (item.passed ? 'PASS ' : 'FAIL ') + item.id + ': ' + item.message);
}
if (report.status !== 'PASS') process.exitCode = 1;
