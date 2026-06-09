import { api } from './api.js';
import { logger } from '../../utils/logger.js';

/**
 * In-memory cache for secCode/name → edinet_code resolution.
 * Persists for the session lifetime to avoid redundant API calls.
 */
const codeCache = new Map<string, string>();

export interface ResolvedCompany {
  edinetCode: string;
  name: string;
  secCode: string;
  /** true when EDINET DB marks the company non-listed (delisted). */
  isDelisted: boolean;
  /** 'listed' | 'delisted' | 'unknown' (from EDINET DB listing_status). */
  listingStatus: string;
}

interface SearchHit {
  edinet_code: string;
  name: string;
  name_ja?: string;
  name_en?: string;
  sec_code: string;
  is_delisted?: boolean;
  listing_status?: string;
}

function normalize(s: string | undefined): string {
  return (s ?? '').normalize('NFKC').toLowerCase().trim();
}

/** A securities-code-shaped query like "7203" or "135A" (4 digits + optional char). */
function isSecCodeQuery(key: string): boolean {
  return /^[0-9]{4}[0-9A-Za-z]?$/.test(key);
}

function isHitDelisted(h: SearchHit): boolean {
  return h.is_delisted === true || h.listing_status === 'delisted';
}

/**
 * Pick the best-matching hit for the query rather than blindly taking the first
 * result. The old `limit:1` + take-first behavior could return the wrong company
 * (e.g. resolving to a company whose code does not match the queried name). We
 * verify the match, and prefer a currently-listed company over a delisted one so
 * common (listed) resolutions stay stable even though we now search with
 * include_delisted=1.
 */
function pickBestMatch(key: string, hits: SearchHit[]): SearchHit | undefined {
  if (hits.length === 0) return undefined;

  let pool: SearchHit[];
  if (isSecCodeQuery(key)) {
    // EDINET DB sec_code is 5 chars ("7203" → "72030"); match the leading 4.
    pool = hits.filter(h => {
      const s = h.sec_code || '';
      return s === key || s === `${key}0` || s.slice(0, 4) === key.slice(0, 4);
    });
  } else {
    const q = normalize(key);
    pool = hits.filter(h =>
      normalize(h.name).includes(q) ||
      normalize(h.name_ja).includes(q) ||
      normalize(h.name_en).includes(q));
  }
  if (pool.length === 0) pool = hits;

  // Prefer a currently-listed match; fall back to the first (possibly delisted)
  // so a name that ONLY resolves to a delisted company still resolves — tagged.
  return pool.find(h => !isHitDelisted(h)) ?? pool[0];
}

/**
 * Resolve a ticker (securities code like "7203") or company name to a company,
 * including its listing status, via /v1/search. Searches with include_delisted=1
 * so formerly-listed (delisted) companies still resolve, and returns isDelisted
 * so callers never silently treat a delisted company as currently active.
 *
 * Note: is_delisted / listing_status are only present once the EDINET DB API
 * exposes them; until then isDelisted is false and listingStatus is 'unknown'
 * (this resolver is forward-compatible and does not depend on deploy order).
 *
 * @throws Error if no company matches.
 */
export async function resolveCompany(ticker: string): Promise<ResolvedCompany> {
  const key = ticker.trim();

  const { data: responseData } = await api.get('/search', {
    q: key,
    limit: 5,
    include_delisted: 1,
  });
  const hits = (responseData.data as SearchHit[] | undefined) ?? [];
  const hit = pickBestMatch(key, hits);

  if (!hit) {
    throw new Error(`Company not found: ${ticker}`);
  }

  const resolved: ResolvedCompany = {
    edinetCode: hit.edinet_code,
    name: hit.name,
    secCode: hit.sec_code,
    isDelisted: isHitDelisted(hit),
    listingStatus: hit.listing_status ?? (hit.is_delisted ? 'delisted' : 'unknown'),
  };

  if (resolved.isDelisted) {
    logger.warn(
      `[Resolver] ${ticker} → ${resolved.edinetCode} (${resolved.name}) is DELISTED ` +
      `(listing_status=${resolved.listingStatus}) — do not present as currently listed`,
    );
  } else {
    logger.info(`[Resolver] ${ticker} → ${resolved.edinetCode} (${resolved.name})`);
  }
  return resolved;
}

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

  const resolved = await resolveCompany(key);

  // Cache both the original query key and the secCode
  codeCache.set(key, resolved.edinetCode);
  if (resolved.secCode && resolved.secCode !== key) {
    codeCache.set(resolved.secCode, resolved.edinetCode);
  }

  return resolved.edinetCode;
}

/**
 * Clear the resolver cache (useful for testing).
 */
export function clearResolverCache(): void {
  codeCache.clear();
}
