import { existsSync, readFileSync, writeFileSync } from 'fs';
import { config } from 'dotenv';
import { getProviderById } from '@/providers';

/**
 * env.example の仮の値を「未設定」として扱うための前置き。
 *
 * `cp env.example .env` のあと鍵を入れなかった行は `OPENAI_API_KEY=your-openai-api-key` のまま残る。
 * これを設定済みと読むと、既定の OpenAI が鍵エラーで止まり、Claude Agent SDK モードは
 * 従量課金の鍵（ANTHROPIC_API_KEY）があると判断して止まり、起動時の送信先一覧にも使っていない
 * 送信先が並ぶ。読み手ごとに判定を足すのではなく、読み込みの入口で取り除く。
 *
 * 取り除くのは env.example に書いてある「変数名と仮の値の組」に完全一致するものだけ。
 * `LANGSMITH_PROJECT=your-team` のような、たまたま `your-` で始まる正当な設定は残す。
 * この表と env.example の一致は `env-placeholder.test.ts` で測る。
 */
export const ENV_EXAMPLE_PLACEHOLDERS: Readonly<Record<string, string>> = {
  OPENAI_API_KEY: 'your-openai-api-key',
  ANTHROPIC_API_KEY: 'your-anthropic-api-key',
  GOOGLE_API_KEY: 'your-google-api-key',
  XAI_API_KEY: 'your-xai-api-key',
  OPENROUTER_API_KEY: 'your-openrouter-api-key',
  MOONSHOT_API_KEY: 'your-moonshot-api-key',
  DEEPSEEK_API_KEY: 'your-deepseek-api-key',
  OLLAMA_CLOUD_API_KEY: 'your-ollama-cloud-api-key',
  EDINETDB_API_KEY: 'your-edinetdb-api-key',
  JQUANTS_API_KEY: 'your-jquants-api-key',
  SLACK_BOT_TOKEN: 'your-slack-bot-token',
  SLACK_APP_TOKEN: 'your-slack-app-token',
  DISCORD_BOT_TOKEN: 'your-discord-bot-token',
  LINE_CHANNEL_SECRET: 'your-line-channel-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'your-line-channel-access-token',
  EXASEARCH_API_KEY: 'your-exa-api-key',
  PERPLEXITY_API_KEY: 'your-perplexity-api-key',
  TAVILY_API_KEY: 'your-tavily-api-key',
  LANGSEARCH_API_KEY: 'your-langsearch-api-key',
  X_BEARER_TOKEN: 'your-X-bearer-token',
  LANGSMITH_API_KEY: 'your-langsmith-api-key',
  TYPESAFE_API_KEY: 'your-typesafe-api-key',
};

/** その変数の値が env.example の仮の値のままか。 */
export function isPlaceholderValue(name: string, value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const placeholder = Object.hasOwn(ENV_EXAMPLE_PLACEHOLDERS, name) ? ENV_EXAMPLE_PLACEHOLDERS[name] : undefined;
  return placeholder !== undefined && value.trim() === placeholder;
}

/** 仮の値のままの環境変数を消し、消した名前を返す。 */
export function dropPlaceholderEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (isPlaceholderValue(key, value)) {
      delete env[key];
      dropped.push(key);
    }
  }
  return dropped;
}

/**
 * `.env` を読み、仮の値を取り除く。`.env` の読み込み・読み直しはすべてここを通す
 * （鍵を保存した後の読み直しで仮の値が戻らないように）。
 */
export function loadEnv(override = false): string[] {
  config({ override, quiet: true });
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
    loadEnv(true);

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
