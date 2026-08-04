import type { APIResponse, BrowserContext } from 'playwright';

/** Matched against the URL pathname only — see the note on classifyRequest. */
export const WRITE_URL_PATTERN = /(save|publish|delete|template|hotSwap)/i;

/** Only paths under this prefix are subject to WRITE_URL_PATTERN. */
export const GUARDED_PATH_PREFIX = '/app/';

export type BlockReason = 'non-get' | 'denylist';

export interface BlockedRequest {
  method: string;
  url: string;
  reason: BlockReason;
  at: string;
}

export interface AllowedRequest {
  method: string;
  url: string;
  at: string;
}

export interface Guard {
  blocked: BlockedRequest[];
  allowed: AllowedRequest[];
}

/**
 * Returns the reason a request must be blocked, or null if it is allowed.
 * Pure — this is the entire read-only policy.
 *
 * WRITE_URL_PATTERN is matched against the pathname only, and only under
 * /app/. Two reasons:
 *
 *   - Static assets under /resources/ legitimately contain words like
 *     "template" in their filenames. Aborting them breaks editor rendering
 *     without preventing any write.
 *   - Decision-editor URLs carry &title=<cell name>, and a campaign author is
 *     free to name a node "Save for later". Matching the query string would
 *     abort that perfectly legitimate GET.
 *
 * Actual writes are blocked unconditionally by method, so the path pattern is
 * defence in depth rather than the primary control.
 */
export function classifyRequest(method: string, url: string): BlockReason | null {
  if (method.toUpperCase() !== 'GET') return 'non-get';

  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // A URL we cannot parse is a URL we cannot vet.
    return 'denylist';
  }

  if (pathname.startsWith(GUARDED_PATH_PREFIX) && WRITE_URL_PATTERN.test(pathname)) {
    return 'denylist';
  }

  return null;
}

export function installReadOnlyGuard(context: BrowserContext): Guard {
  const guard: Guard = { blocked: [], allowed: [] };

  void context.route('**/*', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = request.url();
    const at = new Date().toISOString();

    const reason = classifyRequest(method, url);
    if (reason) {
      guard.blocked.push({ method, url, reason, at });
      await route.abort();
      return;
    }

    guard.allowed.push({ method, url, at });
    await route.continue();
  });

  return guard;
}

/**
 * GET-only HTTP helper.
 *
 * Playwright's APIRequestContext does not participate in route handling, so
 * requests made through it bypass installReadOnlyGuard entirely. This wrapper
 * re-applies the same policy and exposes no verb other than GET.
 */
export async function safeGet(context: BrowserContext, url: string): Promise<APIResponse> {
  const reason = classifyRequest('GET', url);
  if (reason) {
    throw new Error(`safeGet refused ${url} (${reason})`);
  }
  return context.request.get(url);
}
