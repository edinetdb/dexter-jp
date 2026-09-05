import { readCache, writeCache, describeRequest } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { assertEdinetQuota } from '../../utils/quota.js';

const BASE_URL = 'https://edinetdb.jp/v1';

export interface ApiResponse {
  data: Record<string, unknown>;
  url: string;
}

/**
 * Remove redundant fields from API payloads before they are returned to the LLM.
 * This reduces token usage while preserving the financial metrics needed for analysis.
 */
export function stripFieldsDeep(value: unknown, fields: readonly string[]): unknown {
  const fieldsToStrip = new Set(fields);

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map(walk);
    }

    if (!node || typeof node !== 'object') {
      return node;
    }

    const record = node as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(record)) {
      if (fieldsToStrip.has(key)) {
        continue;
      }
      cleaned[key] = walk(child);
    }

    return cleaned;
  }

  return walk(value);
}

function getApiKey(): string {
  return process.env.EDINETDB_API_KEY || '';
}

/**
 * Merge a follow-up page into the accumulated response. The API caps list
 * responses at a fixed page size, so record arrays are concatenated —
 * recursively, because /financials/ nests its three statement arrays one
 * level down. Scalars keep the first page's value; next_page_url is
 * excluded so it never reaches the cache, the formatters, or the LLM.
 */
function mergePage(accumulated: Record<string, unknown>, page: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(page)) {
    if (key === 'next_page_url') {
      continue;
    }
    const existing = accumulated[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      existing.push(...value);
    } else if (
      existing && value &&
      typeof existing === 'object' && typeof value === 'object' &&
      !Array.isArray(existing) && !Array.isArray(value)
    ) {
      mergePage(existing as Record<string, unknown>, value as Record<string, unknown>);
    }
  }
}

/**
 * Shared request execution: handles API key, error handling, logging, and response parsing.
 */
async function executeRequest(
  url: string,
  label: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const apiKey = getApiKey();

  if (!apiKey) {
    logger.warn(`[EDINET DB API] call without key: ${label}`);
  }

  // キャッシュ命中はここに来ないため、ここでのカウントは実際のネットワーク呼び出し数と一致する
  assertEdinetQuota(label);

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'X-API-Key': apiKey,
        ...init.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[EDINET DB API] network error: ${label} — ${message}`);
    throw new Error(`[EDINET DB API] request failed for ${label}: ${message}`);
  }

  if (!response.ok) {
    const detail = `${response.status} ${response.statusText}`;
    logger.error(`[EDINET DB API] error: ${label} — ${detail}`);
    throw new Error(`[EDINET DB API] request failed: ${detail}`);
  }

  const data = await response.json().catch(() => {
    const detail = `invalid JSON (${response.status} ${response.statusText})`;
    logger.error(`[EDINET DB API] parse error: ${label} — ${detail}`);
    throw new Error(`[EDINET DB API] request failed: ${detail}`);
  });

  return data as Record<string, unknown>;
}

export const api = {
  async get(
    endpoint: string,
    params: Record<string, string | number | string[] | undefined>,
    options?: { cacheable?: boolean; ttlMs?: number },
  ): Promise<ApiResponse> {
    const label = describeRequest(endpoint, params);

    // Check local cache first — avoids redundant network calls for immutable data
    if (options?.cacheable) {
      const cached = readCache(endpoint, params, options.ttlMs);
      if (cached) {
        return cached;
      }
    }

    const url = new URL(`${BASE_URL}${endpoint}`);

    // Add params to URL, handling arrays
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value)) {
          value.forEach((v) => url.searchParams.append(key, v));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }

    const data = await executeRequest(url.toString(), label, {});

    // Reassemble the full result: follow next_page_url (absolute and
    // self-contained — request it verbatim) until the last page. This runs
    // before the cache write so caches only ever hold complete results.
    let nextPageUrl = data.next_page_url;
    while (typeof nextPageUrl === 'string' && nextPageUrl) {
      const page = await executeRequest(nextPageUrl, label, {});
      mergePage(data, page);
      nextPageUrl = page.next_page_url;
    }
    delete data.next_page_url;

    // Persist for future requests when the caller marked the response as cacheable
    if (options?.cacheable) {
      writeCache(endpoint, params, data, url.toString());
    }

    return { data, url: url.toString() };
  },

  async post(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<ApiResponse> {
    const label = `POST ${endpoint}`;
    const url = `${BASE_URL}${endpoint}`;

    const data = await executeRequest(url, label, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return { data, url };
  },
};

/** @deprecated Use `api.get` instead */
export const callApi = api.get;
