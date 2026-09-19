import { PROVIDERS as PROVIDER_DEFINITIONS } from '../../providers.js';
import { PROVIDERS as MODEL_PROVIDERS } from '../../utils/model.js';
import type { EvalConfiguration } from './types.js';

function credentialRequirement(providerId: string): string | null {
  return PROVIDER_DEFINITIONS.find((provider) => provider.id === providerId)?.apiKeyEnvVar ?? null;
}

function makeConfiguration(
  providerId: string,
  modelIdentifier: string | null,
  modelSelection: EvalConfiguration['modelSelection'],
): EvalConfiguration {
  const sdk = providerId === 'claude-agent-sdk';
  const modelPart = modelIdentifier ?? modelSelection;
  return {
    id: `${sdk ? 'claude-agent-sdk' : 'langchain'}:${providerId}:${modelPart}`,
    runtime: sdk ? 'claude-agent-sdk' : 'langchain',
    provider: providerId,
    modelIdentifier,
    modelSelection,
    eventAdapter: sdk ? 'claude-sdk-messages' : 'langchain-agent-events',
    credentialRequirement: credentialRequirement(providerId),
    fixtureCapabilities: {
      // Offline fixtures simulate an available X capability for LangChain and
      // separately include an explicit unavailable-capability case. No token is read.
      xSearch: !sdk,
      durableMemory: !sdk,
      generalSkillTool: !sdk,
    },
  };
}

/**
 * The formal selection matrix comes directly from the product registries.
 * OpenRouter and Ollama are intentionally represented without invented model IDs:
 * their selections are user-supplied and locally discovered, respectively.
 */
export function getBehavioralEvalConfigurations(): EvalConfiguration[] {
  const configurations: EvalConfiguration[] = [];

  for (const provider of MODEL_PROVIDERS) {
    if (provider.models.length > 0) {
      for (const model of provider.models) {
        configurations.push(makeConfiguration(provider.providerId, model.id, 'static-registry'));
      }
      continue;
    }

    configurations.push(makeConfiguration(
      provider.providerId,
      null,
      provider.providerId === 'ollama' ? 'local-discovery' : 'user-supplied',
    ));
  }

  return configurations;
}