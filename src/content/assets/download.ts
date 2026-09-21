import { createHash } from 'node:crypto';
import { type LookupAddress, type LookupOptions, lookup as dnsLookup } from 'node:dns';
import { type IncomingMessage, get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';
import type { BrowserContext } from 'playwright';
import { LOGIN_URL_PATTERN } from '../../config.js';
import { SessionExpiredError, isSessionExpired } from '../../errors.js';
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

/** The `all: true` form of `node:dns`' callback `lookup`. Injectable for tests. */
export type DnsLookup = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/** What `http.get`'s `lookup` option expects (`net.LookupFunction`). */
export type ConnectLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

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

const isHtml = (contentType: string | null): boolean =>
  contentType?.split(';')[0]?.trim().toLowerCase() === 'text/html';

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
      const viaSession = isKeapHosted(currentUrl);
      if (viaSession) {
        // Never send the session over plain http.
        const parsed = new URL(currentUrl);
        if (parsed.protocol === 'http:') {
          parsed.protocol = 'https:';
          currentUrl = parsed.href;
        }
      }
      const fetcher = viaSession ? fetchers.keap : fetchers.anonymous;
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
      if (viaSession && isHtml(response.contentType)) {
        // A file link that answers with a page is a login screen, an error page
        // or a landing page — not the file, and not something to store.
        return {
          record: { url, status: 'failed', reason: 'Keap returned an HTML page, not a file' },
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
 * Wraps a `dns.lookup` so a socket can only ever connect to a public address.
 *
 * This runs inside the connection itself (it is `http.get`'s `lookup`), so the
 * address that is checked is the address that is dialled — a hostname cannot
 * resolve to something public for a pre-check and then to 127.0.0.1 for the
 * request (DNS rebinding). Every returned address must be public; one private
 * address refuses the lot. Node ≥ 20 asks with `all: true` (autoSelectFamily),
 * older paths with a single address; both forms are answered.
 */
export function createGuardedLookup(lookup: DnsLookup = dnsLookup): ConnectLookup {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, []);
        return;
      }
      const first = addresses[0];
      if (first === undefined) {
        callback(new Error(`refused: ${hostname} resolves to no address`), []);
        return;
      }
      const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
      if (blocked) {
        callback(
          new Error(`refused: ${hostname} resolves to a private address ${blocked.address}`),
          [],
        );
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, first.address, first.family);
    });
  };
}

const headerOf = (res: IncomingMessage, name: string): string | null => {
  const value = res.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
};

/**
 * One GET over `node:http`/`node:https`, sending no headers beyond what the
 * protocol requires, following no redirect, with its own socket (`agent:
 * false`). It has NO address guard of its own — `lookup` is whatever it is
 * given — so production code goes through `anonymousFetcher`, never this.
 * Exported for tests, which drive it against a local server.
 */
export function anonymousGet(
  url: string,
  lookup: ConnectLookup,
  timeoutMs: number,
  maxBytes: number,
): Promise<AssetResponse> {
  const parsed = new URL(url);
  const get =
    parsed.protocol === 'https:' ? httpsGet : parsed.protocol === 'http:' ? httpGet : null;
  if (get === null) return Promise.reject(new Error(`unsupported protocol ${parsed.protocol}`));

  return new Promise((resolve, reject) => {
    const request = get(
      parsed,
      { lookup, agent: false, headers: {}, signal: AbortSignal.timeout(timeoutMs) },
      (res) => {
        // A late abort or reset must not surface as an unhandled 'error'.
        res.on('error', () => undefined);
        const status = res.statusCode ?? 0;
        const isRedirect = status >= 300 && status < 400;
        // Nothing reads the body of a redirect or an error: release the socket.
        if (status < 200 || status >= 300) res.resume();
        const declared = Number.parseInt(headerOf(res, 'content-length') ?? '', 10);
        resolve({
          status,
          contentType: headerOf(res, 'content-type'),
          contentLength: Number.isFinite(declared) ? declared : null,
          location: isRedirect ? headerOf(res, 'location') : null,
          body: async () => {
            const chunks: Buffer[] = [];
            let total = 0;
            for await (const chunk of res as AsyncIterable<Buffer>) {
              total += chunk.length;
              if (total > maxBytes) {
                res.destroy();
                throw new AssetTooLargeError(`exceeds ${maxBytes} bytes`);
              }
              chunks.push(chunk);
            }
            return Buffer.concat(chunks);
          },
        });
      },
    );
    request.on('error', reject);
  });
}

/**
 * A plain GET with no cookies, no key, nothing: no headers are passed and no
 * shared agent is used, so nothing about the Keap account can reach a
 * third-party host. The body is read in chunks and abandoned at the limit.
 *
 * Redirects are never followed here — `downloadAsset` re-classifies and
 * re-routes every hop itself, so a public URL that 302s to a private address
 * is never fetched. The address check happens at connect time through
 * `createGuardedLookup`, so it covers the address actually dialled. An IP
 * literal never reaches a lookup, so a private one is refused here directly.
 */
export function anonymousFetcher(
  maxBytes = MAX_ASSET_BYTES,
  timeoutMs = ASSET_TIMEOUT_MS,
  lookup: DnsLookup = dnsLookup,
): AssetFetcher {
  const guarded = createGuardedLookup(lookup);
  return async (url) => {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0 && isPrivateAddress(host)) {
      throw new Error(`refused: ${host} is a private address`);
    }
    return anonymousGet(url, guarded, timeoutMs, maxBytes);
  };
}

/**
 * Keap-hosted files (file box downloads may need the session), through the
 * read-only guard. Redirects are never followed here either — `maxRedirects:
 * 0` — so the session is never carried to wherever a redirect points;
 * `downloadAsset` re-routes each hop through the right fetcher.
 *
 * An expired session shows up as a redirect to the sign-in page, so that is
 * checked on the redirect target. The asset's own URL is not checked: with
 * redirects off it is only ever the URL we asked for, and a file such as
 * `/images/login-button.png` is not a sign-in page.
 */
export function sessionFetcher(context: BrowserContext): AssetFetcher {
  return async (url) => {
    const response = await safeGet(context, url, { timeout: ASSET_TIMEOUT_MS, maxRedirects: 0 });
    const headers = response.headers();
    const declared = Number.parseInt(headers['content-length'] ?? '', 10);
    const status = response.status();
    const location = status >= 300 && status < 400 ? (headers['location'] ?? null) : null;
    if (location !== null) {
      let target: URL | null = null;
      try {
        target = new URL(location, url);
      } catch {
        // An unparseable Location is left to downloadAsset, which fails the asset.
      }
      if (target !== null && LOGIN_URL_PATTERN.test(target.host + target.pathname)) {
        throw new SessionExpiredError(
          `Session expired — ${url} redirected to ${target.href}. ` +
            'Re-run:  npm run login -- --app <appName>',
        );
      }
    }
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
