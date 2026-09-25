import { describe, expect, test } from 'bun:test';
import { ASTRA_MODEL_ID } from '../../model/openai-runtime.js';
import { getBehavioralEvalConfigurations } from '../behavioral/matrix.js';
import { runAstraOfflineCompatibility } from './offline.js';

describe('Astra offline compatibility', () => {
  test('is included as an OpenAI LangChain configuration', () => {
    const configuration = getBehavioralEvalConfigurations().find(
      (item) => item.modelIdentifier === ASTRA_MODEL_ID,
    );

    expect(configuration).toMatchObject({
      runtime: 'langchain',
      provider: 'openai',
      modelIdentifier: ASTRA_MODEL_ID,
      modelSelection: 'static-registry',
      credentialRequirement: 'OPENAI_API_KEY',
    });
  });

  test('passes all ten Astra-specific cases without live calls', async () => {
    const report = await runAstraOfflineCompatibility();

    expect(report.label).toBe('ASTRA OFFLINE COMPATIBILITY');
    expect(report.mode).toBe('offline-fixture');
    expect(report.liveCalls).toBe(false);
    expect(report.cases).toHaveLength(10);
    expect(report.result).toBe('PASS');
    expect(report.cases.every((item) => item.passed)).toBe(true);
  });
});
