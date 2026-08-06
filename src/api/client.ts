import { assertAllowed } from './guard.js';

/** Page size for offset-style paging. Keap v1 caps `limit` at 1000. */
const PAGE_SIZE = 1000;

export class ApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

export interface ApiClient {
  get(path: string, query?: Record<string, string>): Promise<unknown>;
  /** Follows the API's own paging until exhausted. */
  getAll(path: string, query?: Record<string, string>): Promise<unknown[]>;
}

export interface ClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Matches the extractor's 250ms; 0 in tests. */
  throttleMs?: number;
  maxRetries?: number;
  /** Base for the exponential backoff between retries; 0 in tests. */
  retryDelayMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Finds the array of items in a page response.
 *
 * Keap names the array after the resource — `tags`, `emails`, `products` — so
 * keying on a fixed name would need a table that drifts. The first array-valued
 * property is unambiguous in every observed shape, and a bare array response is
 * handled directly.
 */
function itemsOf(page: unknown): unknown[] {
  if (Array.isArray(page)) return page;
  if (page === null || typeof page !== 'object') return [];
  for (const value of Object.values(page)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function nextPageToken(page: unknown): string | null {
  if (page === null || typeof page !== 'object' || Array.isArray(page)) return null;
  const token = (page as { next_page_token?: unknown }).next_page_token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Authenticated, throttled, guard-enforced GET.
 *
 * The key lives only in this closure and reaches only the request header. It is
 * never interpolated into a URL, a log line or an error — errors carry the
 * method and pathname, because messages end up in logs and a query string can
 * hold ids.
 */
export function createClient(apiKey: string, options: ClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? process.env.KEAP_API_BASE_URL ?? 'https://api.infusionsoft.com';
  const doFetch = options.fetchImpl ?? fetch;
  const throttleMs = options.throttleMs ?? 250;
  const maxRetries = options.maxRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 1000;

  async function get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    assertAllowed('GET', path);

    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    for (let attempt = 0; ; attempt++) {
      await sleep(throttleMs);

      const response = await doFetch(url.toString(), {
        method: 'GET',
        headers: { 'X-Keap-API-Key': apiKey, Accept: 'application/json' },
      });

      if (response.status === 429) {
        if (attempt >= maxRetries) {
          throw new ApiError(
            429,
            path,
            `GET ${path} hit a rate limit and still failed after ${maxRetries} retries`,
          );
        }
        // Exponential, and deliberately not derived from Retry-After: the header
        // is unverified on this API and a hostile value could stall a whole run.
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new ApiError(
          response.status,
          path,
          `GET ${path} was rejected (${response.status}) — the key may be revoked, ` +
            `or may lack admin scope`,
        );
      }

      if (!response.ok) {
        throw new ApiError(response.status, path, `GET ${path} failed with ${response.status}`);
      }

      return (await response.json()) as unknown;
    }
  }

  async function getAll(path: string, query: Record<string, string> = {}): Promise<unknown[]> {
    const collected: unknown[] = [];
    let token: string | null = null;
    let offset = 0;

    for (;;) {
      const page: unknown = await get(path, {
        ...query,
        limit: String(PAGE_SIZE),
        ...(token === null ? (offset > 0 ? { offset: String(offset) } : {}) : { page_token: token }),
      });

      const items = itemsOf(page);
      collected.push(...items);

      // v2 paging wins when present; otherwise fall back to offset paging and
      // stop on the first short page.
      token = nextPageToken(page);
      if (token !== null) continue;
      if (items.length < PAGE_SIZE) return collected;
      offset += items.length;
    }
  }

  return { get, getAll };
}
