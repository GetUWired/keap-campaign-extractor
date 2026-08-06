import { type EntityKind, entityId } from '../normalize/graphEdges.js';
import { stripLongSuffix } from '../parse/cells.js';

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
