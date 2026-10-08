export interface AstraOfflineCaseResult {
  id: string;
  passed: boolean;
  evidence: string;
}

export interface AstraOfflineReport {
  label: 'ASTRA OFFLINE COMPATIBILITY';
  result: 'PASS' | 'FAIL';
  mode: 'offline-fixture';
  liveCalls: false;
  cases: AstraOfflineCaseResult[];
}
