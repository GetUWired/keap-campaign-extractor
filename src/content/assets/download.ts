import { createHash } from 'node:crypto';
import type { BrowserContext } from 'playwright';
import { assertResponseAuthenticated } from '../../auth/session.js';
import { isSessionExpired } from '../../errors.js';
import { safeGet } from '../../guard/readonly.js';
import { isKeapHosted } from './discover.js';

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const ASSET_TIMEOUT_MS = 30_000;

export interface AssetResponse {
  status: number;
  contentType: string | null;
  contentLength: number | null;
  body(): Promise<Buffer>;
}

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
 */
export async function downloadAsset(
  url: string,
  fetchers: AssetFetchers,
  maxBytes = MAX_ASSET_BYTES,
): Promise<{ record: AssetRecord; bytes: Buffer | null }> {
  const fetcher = isKeapHosted(url) ? fetchers.keap : fetchers.anonymous;
  try {
    const response = await fetcher(url);
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
    return {
      record: {
        url,
        status: 'downloaded',
        sha256,
        file: `${sha256}.${extensionFor(url, response.contentType)}`,
        contentType: response.contentType,
        size: bytes.length,
      },
      bytes,
    };
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
 */
export function anonymousFetcher(
  maxBytes = MAX_ASSET_BYTES,
  timeoutMs = ASSET_TIMEOUT_MS,
  doFetch: typeof fetch = fetch,
): AssetFetcher {
  return async (url) => {
    const response = await doFetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      contentLength: Number.isFinite(declared) ? declared : null,
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

/** Keap-hosted files (file box downloads may need the session), through the read-only guard. */
export function sessionFetcher(context: BrowserContext): AssetFetcher {
  return async (url) => {
    const response = await safeGet(context, url);
    assertResponseAuthenticated(response);
    const headers = response.headers();
    const declared = Number.parseInt(headers['content-length'] ?? '', 10);
    return {
      status: response.status(),
      contentType: headers['content-type'] ?? null,
      contentLength: Number.isFinite(declared) ? declared : null,
      body: () => response.body(),
    };
  };
}
