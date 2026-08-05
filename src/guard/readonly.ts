import type { APIResponse, BrowserContext } from 'playwright';

/**
 * Matched against the URL pathname only — see the note on classifyRequest.
 *
 * `/template$` is anchored deliberately. The observed dangerous URL was
 * PUT /app/authoring/<a>/<b>/template, a path *ending* in /template, while
 * /Reports/searchTemplate.jsp — the automations report enumeration depends on —
 * merely contains the word. An unanchored match blocks our own endpoint.
 */
export const WRITE_URL_PATTERN = /(save|publish|delete|hotSwap|reportActions|\/template$)/i;

/**
 * Prefixes exempt from the denylist: static assets, which cannot change state
 * and legitimately carry words like "template" in their filenames.
 */
export const STATIC_PATH_PREFIXES = [
  '/resources/',
  '/css/',
  '/js/',
  '/images/',
  '/slices/',
  '/files/',
];

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
 * The denylist applies to every path. It previously applied only under /app/,
 * which left this allowed:
 *
 *   GET /Reports/reportActions.jsp?actionName=Unpublish+and+Delete+Automations
 *
 * That URL sits in the Actions menu of the automations report this extractor
 * reads. Static asset prefixes are exempted instead, since they cannot change
 * state and legitimately carry words like "template" in their filenames.
 *
 * The query string stays out of scope: decision-editor URLs carry
 * &title=<cell name>, and an author is free to name a node "Save for later".
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

  if (STATIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;
  if (WRITE_URL_PATTERN.test(pathname)) return 'denylist';

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
