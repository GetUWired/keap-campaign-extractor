import type { HttpContent, NameValue } from './types.js';

export const REDACTED = '«redacted»';

/**
 * Deliberately broad: "author" matches "auth". A false positive costs someone
 * re-typing a value; a false negative ships a live credential to whoever
 * receives the export.
 */
export const SECRET_NAME_PATTERN = /key|token|secret|password|passwd|auth|signature|sig$/i;

const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key']);

/** A value that is only a merge field is filled per contact at send time — not a secret. */
const PURE_MERGE_FIELD = /^~[^~]+~$/;

export interface Redaction {
  location: 'header' | 'query' | 'field' | 'url' | 'body';
  name: string;
}

function isSecret(name: string, value: string, location: Redaction['location']): boolean {
  const trimmed = value.trim();
  if (trimmed === '' || PURE_MERGE_FIELD.test(trimmed)) return false;
  if (location === 'header' && SECRET_HEADERS.has(name.toLowerCase())) return true;
  return SECRET_NAME_PATTERN.test(name);
}

function redactPairs(
  pairs: NameValue[],
  location: 'header' | 'field',
  redacted: Redaction[],
): NameValue[] {
  return pairs.map((pair) => {
    if (!isSecret(pair.name, pair.value, location)) return { ...pair };
    redacted.push({ location, name: pair.name });
    return { name: pair.name, value: REDACTED };
  });
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/**
 * `a=1&b=2`, as in a query string or a form-encoded body. Rewritten pair by
 * pair as text, so everything that is not a secret stays exactly as written.
 */
function redactEncodedPairs(
  text: string,
  location: 'query' | 'body',
  redacted: Redaction[],
): string {
  return text
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const name = decode(pair.slice(0, eq));
      if (!isSecret(name, decode(pair.slice(eq + 1)), location)) return pair;
      redacted.push({ location, name });
      return `${pair.slice(0, eq)}=${REDACTED}`;
    })
    .join('&');
}

/** `name=value(&name=value)*`, values possibly empty, a trailing `&` allowed. */
const FORM_BODY = /^[^=&\s]+=[^&\s]*(?:&[^=&\s]+=[^&\s]*)*&?$/;

/** Recorded when a body could not be parsed, so a person checks it by hand. */
export const UNPARSED_BODY = '(unparsed — review manually)';

/**
 * Rewritten as text rather than through URL/URLSearchParams, which would
 * percent-encode merge fields and the placeholder and hand back a URL nobody
 * recognises.
 */
function redactUrl(url: string, redacted: Redaction[]): string {
  let out = url;
  const userinfo = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]+)@/i.exec(out);
  if (userinfo) {
    out = `${userinfo[1]}${REDACTED}@${out.slice(userinfo[0].length)}`;
    redacted.push({ location: 'url', name: 'userinfo' });
  }

  const queryAt = out.indexOf('?');
  if (queryAt < 0) return out;
  const hashAt = out.indexOf('#', queryAt);
  const query = out.slice(queryAt + 1, hashAt < 0 ? undefined : hashAt);
  const tail = hashAt < 0 ? '' : out.slice(hashAt);

  return `${out.slice(0, queryAt)}?${redactEncodedPairs(query, 'query', redacted)}${tail}`;
}

function redactJson(value: unknown, redacted: Redaction[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry, redacted));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    const text = typeof entry === 'string' ? entry : JSON.stringify(entry);
    if (isSecret(name, text, 'body')) {
      redacted.push({ location: 'body', name });
      out[name] = REDACTED;
    } else {
      out[name] = redactJson(entry, redacted);
    }
  }
  return out;
}

function redactBody(body: string | null, redacted: Redaction[]): string | null {
  if (body === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const trimmed = body.trim();
    if (FORM_BODY.test(trimmed)) return redactEncodedPairs(body, 'body', redacted);
    if (trimmed !== '') redacted.push({ location: 'body', name: UNPARSED_BODY });
    return body;
  }
  const before = redacted.length;
  const result = redactJson(parsed, redacted);
  return redacted.length === before ? body : JSON.stringify(result, null, 2);
}

/**
 * The export's copy of an HTTP step, with credentials replaced and a list of
 * what was removed so they can be re-entered on the new platform.
 */
export function redactHttp(content: HttpContent): { content: HttpContent; redacted: Redaction[] } {
  const redacted: Redaction[] = [];
  const url = redactUrl(content.url, redacted);
  const headers = redactPairs(content.headers, 'header', redacted);
  const fields = redactPairs(content.fields, 'field', redacted);
  const body = redactBody(content.body, redacted);
  return { content: { ...content, url, headers, fields, body }, redacted };
}
