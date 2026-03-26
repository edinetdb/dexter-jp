import { api } from './api.js';
import { logger } from '../../utils/logger.js';

/**
 * In-memory cache for secCode/name → edinet_code resolution.
 * Persists for the session lifetime to avoid redundant API calls.
 */
const codeCache = new Map<string, string>();

/**
 * Resolve a ticker (securities code like "7203") or company name to an EDINET code.
 * Results are cached in-memory for the session.
 *
 * @param ticker - Securities code (e.g. "7203") or company name (e.g. "トヨタ")
 * @returns EDINET code (e.g. "E02144")
 * @throws Error if company not found
 */
export async function resolveEdinetCode(ticker: string): Promise<string> {
  const key = ticker.trim();

  // Already an EDINET code (E + 5 digits)
  if (/^E\d{5}$/.test(key)) {
    return key;
  }

  // Check cache
  if (codeCache.has(key)) {
    return codeCache.get(key)!;
  }

  // Search via API
  const { data } = await api.get('/companies/search', { q: key, limit: 1 });
  const companies = data.companies as Array<{ edinet_code: string; name: string; secCode: string }> | undefined;

  if (!companies || companies.length === 0) {
    throw new Error(`Company not found: ${ticker}`);
  }

  const edinetCode = companies[0].edinet_code;
  const secCode = companies[0].secCode;

  // Cache both the original query key and the secCode
  codeCache.set(key, edinetCode);
  if (secCode && secCode !== key) {
    codeCache.set(secCode, edinetCode);
  }

  logger.info(`[Resolver] ${ticker} → ${edinetCode} (${companies[0].name})`);
  return edinetCode;
}

/**
 * Clear the resolver cache (useful for testing).
 */
export function clearResolverCache(): void {
  codeCache.clear();
}
