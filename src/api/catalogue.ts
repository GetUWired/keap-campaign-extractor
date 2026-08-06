import { type EntityKind, entityId } from '../normalize/graphEdges.js';
import { stripLongSuffix } from '../parse/cells.js';
import { type ApiClient, ApiError } from './client.js';

export interface EntityRecord {
  id: string;
  kind: EntityKind;
  name: string | null;
  extra: Record<string, string>;
}

export type KindSource = { endpoint: string; count: number } | { unavailable: string };

export interface EntityCatalogue {
  appName: string;
  /** Network data, so staleness is meaningful. Unlike graph.json, this is not deterministic. */
  fetchedAt: string;
  sources: Record<string, KindSource>;
  entities: EntityRecord[];
  warnings: string[];
}

/**
 * Candidate endpoints per kind, tried in order until one answers.
 *
 * These are CANDIDATES, not confirmed facts. Keap's REST docs are JS-rendered
 * and could not be read directly; the summarised resource lists mention tags,
 * emails and products but say nothing about webforms or landing pages — 173 of
 * the entities in scope. The probe settles it against the live account and
 * records the answer, which is how every other endpoint in this project was
 * established. A 404 here is an answer, not a failure.
 *
 * Every path listed must also be in src/api/guard.ts, or the probe cannot try it.
 */
export const KIND_CANDIDATES: { kind: EntityKind; paths: string[] }[] = [
  { kind: 'tag', paths: ['/crm/rest/v2/tags', '/crm/rest/v1/tags'] },
  { kind: 'email', paths: ['/crm/rest/v2/emails', '/crm/rest/v1/emails'] },
  { kind: 'product', paths: ['/crm/rest/v1/products', '/crm/rest/v2/products'] },
  { kind: 'user', paths: ['/crm/rest/v1/users', '/crm/rest/v2/users'] },
  { kind: 'webform', paths: ['/crm/rest/v1/forms', '/crm/rest/v2/forms'] },
  { kind: 'form', paths: ['/crm/rest/v1/forms', '/crm/rest/v2/forms'] },
  { kind: 'landingPage', paths: ['/crm/rest/v2/landingPages', '/crm/rest/v1/landingPages'] },
];

/** The name-ish fields Keap uses, in the order they should win. */
const NAME_FIELDS = ['name', 'title', 'product_name', 'display_name', 'subject'];

function str(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

function nameOf(record: Record<string, unknown>): string | null {
  const given = str(record.given_name);
  const family = str(record.family_name);
  if (given !== null || family !== null) return [given, family].filter(Boolean).join(' ');
  for (const field of NAME_FIELDS) {
    const value = str(record[field]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Fields worth keeping beyond the name.
 *
 * `subject` is the reason to fetch emails at all — handoff §14 Q9 asks whether
 * the API can supply subject lines and thereby avoid scraping the email editor.
 */
function extraOf(record: Record<string, unknown>): Record<string, string> {
  const extra: Record<string, string> = {};

  const subject = str(record.subject);
  if (subject !== null && subject !== nameOf(record)) extra.subject = subject;

  const status = str(record.status);
  if (status !== null) extra.status = status;

  const category = record.category;
  if (category !== null && typeof category === 'object') {
    const label = str((category as Record<string, unknown>).name);
    if (label !== null) extra.category = label;
  }

  const email = str(record.email_address);
  if (email !== null) extra.email = email;

  return extra;
}

/** Turns one API record into an EntityRecord, or null if it has no usable id. */
export function mapRecord(kind: EntityKind, raw: unknown): EntityRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const rawId = str(record.id);
  if (rawId === null) return null;
  const id = stripLongSuffix(rawId) ?? rawId;

  return { id: entityId(kind, id), kind, name: nameOf(record), extra: extraOf(record) };
}

const PROFILE_PATH = '/crm/rest/v1/account/profile';

/** Every string value anywhere in a nested object, for the identity match. */
function stringValues(value: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap((v) => stringValues(v, depth + 1));
}

/**
 * Refuses to proceed unless the key belongs to the account we were asked for.
 *
 * The multi-app work defends against a session for one tenant pointed at
 * another tenant's artifacts directory. An admin API key has the same failure
 * mode and, unlike draftXml, carries no appName to check against.
 *
 * Which profile field holds the tenant identity is not documented, so this
 * searches every string value. On no match it FAILS and lists the profile's
 * field NAMES — never their values, which are business contact details — so the
 * operator can say which field to key on. An unknown becomes a self-diagnosing
 * failure rather than a silent hole.
 */
export async function assertAccountIdentity(client: ApiClient, appName: string): Promise<void> {
  const profile = await client.get(PROFILE_PATH);
  const needle = appName.toLowerCase();

  if (stringValues(profile).some((value) => value.toLowerCase().includes(needle))) return;

  const fields =
    profile !== null && typeof profile === 'object'
      ? Object.keys(profile).sort().join(', ')
      : '(none)';

  throw new Error(
    `identity check failed — nothing was written. The account profile this key resolves to ` +
      `does not mention "${appName}" anywhere. Profile fields available: ${fields}. ` +
      `If one of those carries the tenant identity, key the check on it.`,
  );
}

/** Tries each candidate in order; the first that answers wins. */
export async function probeKind(
  client: ApiClient,
  kind: EntityKind,
  paths: string[],
): Promise<{ endpoint: string } | { unavailable: string }> {
  const tried: string[] = [];

  for (const path of paths) {
    try {
      await client.get(path, { limit: '1' });
      return { endpoint: path };
    } catch (error) {
      // 401/403 means the key is wrong, not that the resource is missing.
      // Reporting that as "unavailable" would hide a broken run behind a shrug.
      if (error instanceof ApiError && error.status !== 404) throw error;
      const status = error instanceof ApiError ? error.status : 'error';
      tried.push(`${path} (${status})`);
    }
  }

  return { unavailable: `no candidate endpoint answered: ${tried.join(', ')}` };
}

export async function fetchCatalogue(
  client: ApiClient,
  appName: string,
): Promise<EntityCatalogue> {
  await assertAccountIdentity(client, appName);

  const sources: Record<string, KindSource> = {};
  const entities: EntityRecord[] = [];
  const warnings: string[] = [];
  const fetchedBy = new Map<string, EntityKind>();

  for (const { kind, paths } of KIND_CANDIDATES) {
    const probed = await probeKind(client, kind, paths);
    if ('unavailable' in probed) {
      sources[kind] = probed;
      warnings.push(`${kind}: ${probed.unavailable}`);
      continue;
    }

    // webform and form both name /forms as a candidate. Fetching it twice would
    // not merely duplicate records — it would MINT them, turning every webform
    // into an identically-numbered internal form that may not exist. Whichever
    // kind claims the endpoint first keeps it; the other is recorded as not
    // separately resolvable, and the live probe settles what /forms holds.
    const owner = fetchedBy.get(probed.endpoint);
    if (owner !== undefined) {
      const reason = `${probed.endpoint} is already served as "${owner}" — not separately resolvable`;
      sources[kind] = { unavailable: reason };
      warnings.push(`${kind}: ${reason}`);
      continue;
    }
    fetchedBy.set(probed.endpoint, kind);

    const raw = await client.getAll(probed.endpoint);
    let dropped = 0;
    let kept = 0;

    for (const item of raw) {
      const record = mapRecord(kind, item);
      if (record === null) {
        dropped++;
        continue;
      }
      entities.push(record);
      kept++;
    }

    sources[kind] = { endpoint: probed.endpoint, count: kept };
    if (dropped > 0) {
      warnings.push(`${dropped} ${kind} record(s) had no usable id and were dropped`);
    }
  }

  if (entities.length === 0) {
    throw new Error(
      'no entities fetched from any endpoint — a silent empty catalogue is worse than an error',
    );
  }

  return { appName, fetchedAt: new Date().toISOString(), sources, entities, warnings };
}
