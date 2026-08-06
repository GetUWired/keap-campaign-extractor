/**
 * An allowlist, deliberately — not a denylist.
 *
 * `guard/readonly.ts` was caught twice by denylist thinking: the pattern only
 * covered `/app/`, leaving a destructive `/Reports/` URL allowed, and later it
 * blocked `_publish.svg`, an icon, for having "publish" in its filename. Over a
 * browser session that was recoverable. Over a Keap Service Account Key it is
 * not: the key is admin-scoped and can read every contact in the account, so
 * the risk is not a URL someone thought to forbid, it is the one nobody did.
 *
 * Adding a resource here is a deliberate edit to a file whose only purpose is
 * to declare what may be read. That friction is the feature.
 *
 * Every pattern is anchored at `^` and matches the pathname only. Candidate
 * paths for both API versions are listed because the probe has to be able to
 * try them; a 404 is an answer, an unlisted path is a bug.
 */
export const ALLOWED_PATHS: RegExp[] = [
  /^\/crm\/rest\/v[12]\/tags(?:\/|$)/,
  /^\/crm\/rest\/v[12]\/products(?:\/|$)/,
  /^\/crm\/rest\/v[12]\/users(?:\/|$)/,
  /^\/crm\/rest\/v[12]\/forms(?:\/|$)/,
  /^\/crm\/rest\/v[12]\/account\/profile(?:\/|$)/,
];

/**
 * `/emails` is deliberately absent.
 *
 * It was allowlisted once, and the live run pulled 14,914 sent-email records —
 * the history of what went to which contact, not the campaign templates the ids
 * in draftXml point at. Nothing was joined from it, but it should never have
 * been requested. See UNSERVABLE_KINDS in catalogue.ts for the evidence.
 *
 * `/landingPages` is absent because it does not exist (404 on both versions).
 */

export function isAllowed(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  return ALLOWED_PATHS.some((pattern) => pattern.test(path));
}

/**
 * Throws on a path outside the allowlist.
 *
 * The message carries the method and pathname only. A query string can hold
 * ids and filters, and error messages end up in logs.
 */
export function assertAllowed(method: string, path: string): void {
  if (isAllowed(method, path)) return;
  throw new Error(
    `${method.toUpperCase()} ${path} is not on the allowlist — refusing to send it. ` +
      `Only GET to the entity resources in src/api/guard.ts is permitted.`,
  );
}
