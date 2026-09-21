import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BrowserContext } from 'playwright';
import { assertResponseAuthenticated } from '../../auth/session.js';
import { isSessionExpired } from '../../errors.js';
import { safeGet } from '../../guard/readonly.js';
import { classifyUrl, isKeapHosted, isPrivateAddress } from './discover.js';

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const ASSET_TIMEOUT_MS = 30_000;
/** At most this many redirect hops are followed before giving up. */
export const MAX_REDIRECTS = 5;

export interface AssetResponse {
  status: number;
  contentType: string | null;
  contentLength: number | null;
  /** The raw `Location` header of a 3xx response; null otherwise. */
  location: string | null;
  body(): Promise<Buffer>;
}

/** Matches `node:dns/promises`' `lookup(hostname, { all: true })`. Injectable for tests. */
export type DnsResolve = (
  hostname: string,
  options: { all: true },
) => Promise<{ address: string; family: number }[]>;

export type AssetFetcher = (url: string) => Promise<AssetResponse>;

/** `keap` carries the session. `anonymous` carries nothing at all. */
export interface AssetFetchers {
  keap: AssetFetcher;
  anonymous: AssetFetcher;
}

export type AssetStatus = 'downloaded' | 'failed' | 'tooLarge' | 'skipped';

export interface AssetRecord {
  url: string;
  status: AssetStatus;
  reason?: string;
  httpStatus?: number;
  sha256?: string;
  /** `<sha256>.<ext>`, present only when downloaded. */
  file?: string;
  contentType?: string | null;
  size?: number;
  /** The URL actually fetched, when redirects moved it away from `url`. */
  finalUrl?: string;
}

export class AssetTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetTooLargeError';
  }
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'text/css': 'css',
  'text/plain': 'txt',
  'application/pdf': 'pdf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'font/ttf': 'ttf',
  'application/font-woff': 'woff',
};

export function extensionFor(url: string, contentType: string | null): string {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const fromType = EXTENSION_BY_TYPE[type];
  if (fromType) return fromType;
  try {
    const match = /\.([a-z0-9]{1,5})$/i.exec(new URL(url).pathname);
    if (match?.[1]) return match[1].toLowerCase();
  } catch {
    // fall through
  }
  return 'bin';
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Downloads one asset. Never throws for the asset's own sake — a missing image
 * must not fail the email that uses it — but lets session expiry through,
 * because that means every later request will fail too.
 *
 * Redirects are followed here, never by a fetcher (see `anonymousFetcher` and
 * `sessionFetcher`, both configured not to follow them on their own). Each hop
 * is re-classified and re-routed: a redirect to a private address is refused,
 * and the Keap session is only ever sent to a Keap-hosted hop, never wherever
 * a redirect happens to point.
 */
export async function downloadAsset(
  url: string,
  fetchers: AssetFetchers,
  maxBytes = MAX_ASSET_BYTES,
): Promise<{ record: AssetRecord; bytes: Buffer | null }> {
  try {
    let currentUrl = url;
    let redirectCount = 0;

    for (;;) {
      const fetcher = isKeapHosted(currentUrl) ? fetchers.keap : fetchers.anonymous;
      const response = await fetcher(currentUrl);

      if (response.status >= 300 && response.status < 400) {
        if (!response.location) {
          return {
            record: {
              url,
              status: 'failed',
              httpStatus: response.status,
              reason: `HTTP ${response.status}`,
            },
            bytes: null,
          };
        }
        redirectCount++;
        if (redirectCount > MAX_REDIRECTS) {
          return { record: { url, status: 'failed', reason: 'too many redirects' }, bytes: null };
        }
        const classified = classifyUrl(response.location, currentUrl);
        if ('reason' in classified) {
          return {
            record: { url, status: 'skipped', reason: `redirect to ${classified.reason}` },
            bytes: null,
          };
        }
        currentUrl = classified.url;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        return {
          record: { url, status: 'failed', httpStatus: response.status, reason: `HTTP ${response.status}` },
          bytes: null,
        };
      }
      if (response.contentLength !== null && response.contentLength > maxBytes) {
        return {
          record: { url, status: 'tooLarge', size: response.contentLength, contentType: response.contentType },
          bytes: null,
        };
      }
      const bytes = await response.body();
      if (bytes.length > maxBytes) {
        return {
          record: { url, status: 'tooLarge', size: bytes.length, contentType: response.contentType },
          bytes: null,
        };
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const record: AssetRecord = {
        url,
        status: 'downloaded',
        sha256,
        file: `${sha256}.${extensionFor(currentUrl, response.contentType)}`,
        contentType: response.contentType,
        size: bytes.length,
      };
      if (currentUrl !== url) record.finalUrl = currentUrl;
      return { record, bytes };
    }
  } catch (error) {
    if (isSessionExpired(error)) throw error;
    if (error instanceof AssetTooLargeError) {
      return { record: { url, status: 'tooLarge', reason: error.message }, bytes: null };
    }
    return { record: { url, status: 'failed', reason: messageOf(error) }, bytes: null };
  }
}

/**
 * A plain GET with no cookies, no key, nothing. Node's fetch keeps no cookie
 * jar, and no headers are passed, so nothing about the Keap account can reach
 * a third-party host. The body is read in chunks and abandoned at the limit.
 *
 * Redirects are never followed here (`redirect: 'manual'`) — `downloadAsset`
 * re-classifies and re-routes every hop itself, so a public URL that 302s to
 * a private address is never fetched. Before the request, the hostname is
 * resolved and every returned address is checked: a public-looking hostname
 * that resolves to a private address is refused before any request is made.
 */
export function anonymousFetcher(
  maxBytes = MAX_ASSET_BYTES,
  timeoutMs = ASSET_TIMEOUT_MS,
  doFetch: typeof fetch = fetch,
  resolve: DnsResolve = dnsLookup,
): AssetFetcher {
  return async (url) => {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname) === 0) {
      const addresses = await resolve(hostname, { all: true });
      if (addresses.some((address) => isPrivateAddress(address.address))) {
        throw new Error(`refused: ${hostname} resolves to a private address`);
      }
    }
    const response = await doFetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    const location =
      response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      contentLength: Number.isFinite(declared) ? declared : null,
      location,
      body: async () => {
        if (response.body === null) return Buffer.alloc(0);
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          total += chunk.length;
          if (total > maxBytes) throw new AssetTooLargeError(`exceeds ${maxBytes} bytes`);
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      },
    };
  };
}

/**
 * Keap-hosted files (file box downloads may need the session), through the
 * read-only guard. Redirects are never followed here either — `maxRedirects:
 * 0` — so the session is never carried to wherever a redirect points;
 * `downloadAsset` re-routes each hop through the right fetcher.
 */
export function sessionFetcher(context: BrowserContext): AssetFetcher {
  return async (url) => {
    const response = await safeGet(context, url, { timeout: ASSET_TIMEOUT_MS, maxRedirects: 0 });
    assertResponseAuthenticated(response);
    const headers = response.headers();
    const declared = Number.parseInt(headers['content-length'] ?? '', 10);
    const status = response.status();
    const location = status >= 300 && status < 400 ? (headers['location'] ?? null) : null;
    return {
      status,
      contentType: headers['content-type'] ?? null,
      contentLength: Number.isFinite(declared) ? declared : null,
      location,
      // Playwright's APIResponse cannot stream; the 25 MB cap is enforced after reading.
      body: () => response.body(),
    };
  };
}
