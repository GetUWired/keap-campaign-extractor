import type { EntityCatalog } from '../api/catalog.js';
import { type EntityKind, entityId } from '../normalize/graphEdges.js';
import type { NormalizedNode } from '../normalize/nodes.js';
import { typeLabel } from './labels.js';
import { plainText, truncate } from './text.js';

const NOTE_STYLES = new Set(['notes', 'note']);
const EMAIL_STYLES = new Set(['email', 'bardEmail', 'unlayerEmail']);

/** Longest note body rendered inline before it is cut. */
const NOTE_LIMIT = 300;

/** Foreign keys worth naming inline, in the order they are most informative. */
const INLINE_REFERENCES: [string, EntityKind][] = [
  ['webformId', 'webform'],
  ['landingPageId', 'landingPage'],
  ['internalFormId', 'form'],
  ['purchaseId', 'product'],
  ['userId', 'user'],
];

export interface ProseContext {
  /** entity id → display name. Empty means ids only. */
  names: Map<string, string>;
}

export function nameIndex(catalog?: EntityCatalog): Map<string, string> {
  const index = new Map<string, string>();
  for (const entity of catalog?.entities ?? []) {
    if (entity.name !== null) index.set(entity.id, entity.name);
  }
  return index;
}

/**
 * One node, one line of English.
 *
 * Leads with what the node DOES, derived from style and references, then quotes
 * the operator's own name — which is the only record of WHY. The name is never
 * paraphrased: inferring intent is the LLM pass, and keeping it out is what
 * makes this testable.
 */
export function describeNode(node: NormalizedNode, context: ProseContext): string {
  const label = typeLabel(node);
  const name = node.name === null ? null : plainText(node.name);

  // A tag step carries no name at all — 0 of 241 in the corpus — so the tag it
  // points at is the entire content of the line.
  if (node.style === 'tag') {
    const [tagId] = node.references.tagIds;
    if (tagId === undefined) return `${label} — not configured`;
    const verb = node.config.isApply === 'false' ? 'Removes' : 'Applies';
    const tag = context.names.get(entityId('tag', tagId));
    return `${verb} tag ${tag === undefined ? tagId : `"${tag}"`}`;
  }

  // A note keeps its body in config.notes rather than name, and that body is
  // HTML — the handoff calls these the highest-signal text in the corpus.
  if (NOTE_STYLES.has(node.style)) {
    const body = plainText(node.config.notes ?? '');
    if (body === '') return name === null ? label : `${label} — "${name}"`;
    return `Note: ${truncate(body, NOTE_LIMIT)}`;
  }

  // 98 email steps are literally called "Untitled Email", so the catalog name
  // is better whenever the operator did not choose one.
  if (EMAIL_STYLES.has(node.style)) {
    const emailId = node.references.marketingEmailId;
    const catalogName =
      typeof emailId === 'string' ? context.names.get(entityId('email', emailId)) : undefined;
    const chosen = name === null || /^untitled/i.test(name) ? (catalogName ?? name) : name;
    return chosen === null || chosen === undefined ? label : `${label} — "${chosen}"`;
  }

  // Everything else: the type, the operator's words, and the entity it points
  // at when we can name it.
  const parts: string[] = [label];
  if (name !== null) parts.push(`— "${name}"`);

  for (const [attribute, kind] of INLINE_REFERENCES) {
    const value = node.references[attribute];
    if (typeof value !== 'string') continue;
    const resolved = context.names.get(entityId(kind, value));
    if (resolved !== undefined) parts.push(`(${resolved})`);
    break;
  }

  return parts.join(' ');
}
