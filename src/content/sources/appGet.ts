import { LOGIN_URL_PATTERN } from '../../config.js';
import { SessionExpiredError } from '../../errors.js';
import { safeGet } from '../../guard/readonly.js';
import { ContentNotFoundError, type FetchContext } from '../types.js';

/**
 * The Keap app endpoints content may be read from — each confirmed read-only by
 * a single GET in docs/spike-findings.md §18. An allowlist, like src/api/guard.ts:
 * the read-only guard is a denylist, and these are editor URLs, so the set that
 * may be requested is declared here rather than inferred.
 *
 * Adding a path is a deliberate edit. Note what it is NOT: `…/clone`, `sendTest`,
 * `/app/httpFunnel/…` (legacy HTTP Post, which answers GET with 405) — every one
 * of those is a write or a dead end.
 */
export const APP_CONTENT_PATHS: RegExp[] = [
  // SMS: JSON { id, message, phoneTypes, … }. The same URL is saved by PUT.
  /^\/app\/automatedSmsFunnel\/\d+$/,
  // Apply Note template editor form.
  /^\/app\/noteFunnel\/edit$/,
  // HTTP Request editor form.
  /^\/app\/httpRequestFunnel\/requests\/\d+$/,
];

export const APP_GET_TIMEOUT_MS = 30_000;

export interface AppResponse {
  status: number;
  contentType: string;
  body: string;
}

/**
 * True when the body looks like Keap's sign-in form rather than content — the
 * marker `appGet` cannot see through a redirect (Keap sometimes answers an
 * expired session with a 200 sign-in page instead of a redirect or a 401/403).
 */
export function looksLikeSignInPage(body: string): boolean {
  const hasFormMarker = /type="password"|id="username"/i.test(body);
  const hasLoginWord = /login|sign\s*in|signin/i.test(body);
  return hasFormMarker && hasLoginWord;
}

export function assertContentPath(path: string): void {
  const pathname = path.split('?')[0] ?? '';
  if (!APP_CONTENT_PATHS.some((pattern) => pattern.test(pathname))) {
    throw new Error(
      `${pathname} is not a content endpoint — refusing to request it. ` +
        'Allowed paths are listed in src/content/sources/appGet.ts.',
    );
  }
}

/**
 * One GET of a Keap app content endpoint through the logged-in session.
 *
 * Redirects are never followed: Keap answers an expired session with a redirect
 * to sign-in, and following it would hand the sign-in page to a parser as if it
 * were content.
 */
export async function appGet(ctx: FetchContext, path: string): Promise<AppResponse> {
  if (ctx.browser === null) throw new Error(`${path} needs the logged-in session`);
  assertContentPath(path);

  const url = `${ctx.baseUrl}${path}`;
  const response = await safeGet(ctx.browser, url, { timeout: APP_GET_TIMEOUT_MS, maxRedirects: 0 });
  const status = response.status();
  const headers = response.headers();

  if (status >= 300 && status < 400) {
    let target: URL | null = null;
    try {
      target = new URL(headers.location ?? '', url);
    } catch {
      target = null;
    }
    if (target !== null && LOGIN_URL_PATTERN.test(target.host + target.pathname)) {
      throw new SessionExpiredError(
        `Session expired — ${path} redirected to sign-in. Re-run:  npm run login -- --app ${ctx.app}`,
      );
    }
    throw new Error(`${path} redirected unexpectedly (${status})`);
  }
  if (status === 401 || status === 403) {
    throw new SessionExpiredError(
      `Session expired — ${path} returned ${status}. Re-run:  npm run login -- --app ${ctx.app}`,
    );
  }
  if (status === 404) throw new ContentNotFoundError(`${path} → 404`);
  if (status < 200 || status >= 300) throw new Error(`${path} → HTTP ${status}`);

  return { status, contentType: headers['content-type'] ?? '', body: await response.text() };
}
