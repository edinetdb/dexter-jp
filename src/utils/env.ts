import { existsSync, readFileSync, writeFileSync } from 'fs';
import { config } from 'dotenv';
import { getProviderById } from '@/providers';

/**
 * env.example の仮の値（`your-...`）を「未設定」として扱うための前置き。
 *
 * `cp env.example .env` のあと鍵を入れなかった行は `OPENAI_API_KEY=your-openai-api-key` のまま残る。
 * これを設定済みと読むと、既定の OpenAI が鍵エラーで止まり、Claude Agent SDK モードは
 * 従量課金の鍵（ANTHROPIC_API_KEY）があると判断して止まり、起動時の送信先一覧にも使っていない
 * 送信先が並ぶ。読み手ごとに判定を足すのではなく、読み込みの入口で 1 回だけ取り除く。
 */
export const PLACEHOLDER_PREFIX = 'your-';

export function isPlaceholderValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().startsWith(PLACEHOLDER_PREFIX);
}

/** 仮の値のままの環境変数を消し、消した名前を返す。 */
export function dropPlaceholderEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (isPlaceholderValue(value)) {
      delete env[key];
      dropped.push(key);
    }
  }
  return dropped;
}

/** `.env` を読み、仮の値を取り除く。`.env` の読み込みはすべてここを通す。 */
export function loadEnv(): string[] {
  config({ quiet: true });
  return dropPlaceholderEnv(process.env);
}

// Load .env on module import
loadEnv();

export function getApiKeyNameForProvider(providerId: string): string | undefined {
  return getProviderById(providerId)?.apiKeyEnvVar;
}

export function getProviderDisplayName(providerId: string): string {
  return getProviderById(providerId)?.displayName ?? providerId;
}

export function checkApiKeyExistsForProvider(providerId: string): boolean {
  const apiKeyName = getApiKeyNameForProvider(providerId);
  if (!apiKeyName) return true;
  return checkApiKeyExists(apiKeyName);
}

export function checkApiKeyExists(apiKeyName: string): boolean {
  const value = process.env[apiKeyName];
  if (value && value.trim() && !value.trim().startsWith('your-')) {
    return true;
  }

  // Also check .env file directly
  if (existsSync('.env')) {
    const envContent = readFileSync('.env', 'utf-8');
    const lines = envContent.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key.trim() === apiKeyName) {
          const val = valueParts.join('=').trim();
          if (val && !val.startsWith('your-')) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

export function saveApiKeyToEnv(apiKeyName: string, apiKeyValue: string): boolean {
  try {
    let lines: string[] = [];
    let keyUpdated = false;

    if (existsSync('.env')) {
      const existingContent = readFileSync('.env', 'utf-8');
      const existingLines = existingContent.split('\n');

      for (const line of existingLines) {
        const stripped = line.trim();
        if (!stripped || stripped.startsWith('#')) {
          lines.push(line);
        } else if (stripped.includes('=')) {
          const key = stripped.split('=')[0].trim();
          if (key === apiKeyName) {
            lines.push(`${apiKeyName}=${apiKeyValue}`);
            keyUpdated = true;
          } else {
            lines.push(line);
          }
        } else {
          lines.push(line);
        }
      }

      if (!keyUpdated) {
        if (lines.length > 0 && !lines[lines.length - 1].endsWith('\n')) {
          lines.push('');
        }
        lines.push(`${apiKeyName}=${apiKeyValue}`);
      }
    } else {
      lines.push('# LLM API Keys');
      lines.push(`${apiKeyName}=${apiKeyValue}`);
    }

    writeFileSync('.env', lines.join('\n'));

    // Reload environment variables
    config({ override: true, quiet: true });

    return true;
  } catch {
    return false;
  }
}

export function saveApiKeyForProvider(providerId: string, apiKey: string): boolean {
  const apiKeyName = getApiKeyNameForProvider(providerId);
  if (!apiKeyName) return false;
  return saveApiKeyToEnv(apiKeyName, apiKey);
}

export type SearchProviderId = 'exa' | 'perplexity' | 'tavily' | 'langsearch';

export const SEARCH_PROVIDERS: Record<SearchProviderId, { displayName: string; apiKeyEnvVar: string }> = {
  exa: { displayName: 'Exa', apiKeyEnvVar: 'EXASEARCH_API_KEY' },
  perplexity: { displayName: 'Perplexity', apiKeyEnvVar: 'PERPLEXITY_API_KEY' },
  tavily: { displayName: 'Tavily', apiKeyEnvVar: 'TAVILY_API_KEY' },
  langsearch: { displayName: 'LangSearch', apiKeyEnvVar: 'LANGSEARCH_API_KEY' },
};

export function getSearchProviderDisplayName(providerId: SearchProviderId): string {
  return SEARCH_PROVIDERS[providerId].displayName;
}

export function getApiKeyNameForSearchProvider(providerId: SearchProviderId): string {
  return SEARCH_PROVIDERS[providerId].apiKeyEnvVar;
}

export function checkApiKeyForSearchProvider(providerId: SearchProviderId): boolean {
  return checkApiKeyExists(SEARCH_PROVIDERS[providerId].apiKeyEnvVar);
}

export function saveApiKeyForSearchProvider(providerId: SearchProviderId, apiKey: string): boolean {
  return saveApiKeyToEnv(SEARCH_PROVIDERS[providerId].apiKeyEnvVar, apiKey);
}
