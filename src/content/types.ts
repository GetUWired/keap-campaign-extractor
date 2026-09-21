import type { BrowserContext } from 'playwright';
import type { ApiClient } from '../api/client.js';

/**
 * The content kinds the export carries. Action sets, fax, voice broadcast and
 * letters are deliberately absent — deferred by the spec, barely used.
 */
export const CONTENT_KINDS = ['email', 'landingPage', 'form', 'sms', 'note', 'http'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/**
 * The XML attributes that point at each kind. The first is the primary id
 * space; the others are different id spaces for the same kind of content and
 * must never be merged with it — `webformId 681` and `internalFormId 681` are
 * unrelated records.
 *
 * Which of these phase 0 could actually read is recorded in
 * docs/spike-findings.md; a source declares the subset it serves.
 */
export const KIND_ATTRIBUTES: Record<ContentKind, readonly string[]> = {
  email: ['marketingEmailId'],
  landingPage: ['landingPageId', 'unlayerLandingPageId', 'convrrtLandingPageId'],
  form: ['webformId', 'smartFormInstanceId', 'internalFormId'],
  sms: ['marketingAutomatedSmsId', 'automationMessageId'],
  note: ['marketingNoteId'],
  http: ['httpRequestConfigId'],
};

/** Folder names inside an exported campaign. */
export const KIND_FOLDERS: Record<ContentKind, string> = {
  email: 'emails',
  landingPage: 'landing-pages',
  form: 'forms',
  sms: 'sms',
  note: 'notes',
  http: 'http',
};

/**
 * Keap ids are integers for most content, but UUIDs for Unlayer/Convrrt
 * landing pages. Ids become path segments under the store, so nothing else
 * is accepted.
 */
export const CONTENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export interface ContentItemKey {
  kind: ContentKind;
  attribute: string;
  id: string;
}

export function itemKey(key: ContentItemKey): string {
  return `${key.kind}:${key.attribute}:${key.id}`;
}

/** The bare id for the primary id space; `<attribute>-<id>` for any other. */
export function itemDirName(key: ContentItemKey): string {
  const primary = KIND_ATTRIBUTES[key.kind][0];
  return key.attribute === primary ? key.id : `${key.attribute}-${key.id}`;
}

export type StepVersion = 'draft' | 'published' | 'both';

/** One campaign step that points at a piece of content. */
export interface ContentUse {
  funnelId: string;
  cellId: string;
  style: string;
  name: string | null;
  version: StepVersion;
}

export interface ContentItem extends ContentItemKey {
  usedBy: ContentUse[];
}

export interface Attachment {
  name: string;
  url: string;
}

export interface NameValue {
  name: string;
  value: string;
}

/** Body files are separate: body.html and body.txt. */
export interface EmailContent {
  kind: 'email';
  name: string | null;
  from: string | null;
  replyTo: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  previewText: string | null;
  attachments: Attachment[];
}

/** HTML is a separate file: page.html. */
export interface LandingPageContent {
  kind: 'landingPage';
  name: string | null;
  title: string | null;
  url: string | null;
}

export interface FormField {
  name: string;
  label: string | null;
  type: string | null;
  required: boolean | null;
  hidden: boolean;
  defaultValue: string | null;
}

/** HTML, where Keap exposes it, is a separate file: form.html. */
export interface FormContent {
  kind: 'form';
  name: string | null;
  fields: FormField[];
  thankYou: { type: 'message' | 'redirect' | 'landingPage' | 'unknown'; value: string | null };
  /** The form's hosted page. */
  publicUrl?: string | null;
  /** Keap's form builder, e.g. LEGACY. */
  formType?: string | null;
  /**
   * False when Keap exposed no field list for this form. `fields: []` then means
   * "unknown", not "a form without fields" — the export must not read it as the latter.
   */
  fieldsAvailable?: boolean;
}

export interface SmsContent {
  kind: 'sms';
  name: string | null;
  text: string;
  sender: string | null;
  /** Which of the contact's phone numbers Keap sends to. */
  phoneTypes?: string[];
}

export interface NoteContent {
  kind: 'note';
  name: string | null;
  type: string | null;
  subject: string | null;
  body: string;
  /** Users notified when the note is applied. */
  notifyUsers?: { id: string; name: string }[];
  /** Who the note is assigned to; Keap's `systemUserId` means the contact owner. */
  assignTo?: string | null;
}

export interface HttpContent {
  kind: 'http';
  name: string | null;
  method: string;
  url: string;
  headers: NameValue[];
  fields: NameValue[];
  body: string | null;
}

export type ContentRecord =
  | EmailContent
  | LandingPageContent
  | FormContent
  | SmsContent
  | NoteContent
  | HttpContent;

export interface ContentFile {
  name: string;
  body: string | Buffer;
}

/**
 * What a source returns for one item.
 *
 * `files` are exported (body.html, page.html, …). `evidence` is the raw
 * response, kept in the store and never exported. `assetUrls` are URLs the
 * source knows about beyond what HTML scanning will find.
 */
export interface FetchedContent {
  record: ContentRecord;
  files: ContentFile[];
  evidence: ContentFile[];
  assetUrls: string[];
}

export interface FetchContext {
  app: string;
  baseUrl: string;
  browser: BrowserContext | null;
  api: ApiClient | null;
}

export interface ContentSource {
  kind: ContentKind;
  /** The id spaces this source can read — a subset of KIND_ATTRIBUTES[kind]. */
  attributes: readonly string[];
  needsApiKey: boolean;
  needsBrowser: boolean;
  fetch(key: ContentItemKey, ctx: FetchContext): Promise<FetchedContent>;
  /** Null when the content is genuine; otherwise why it is not. Status codes are not evidence. */
  validate(content: FetchedContent): string | null;
}

/** The id points at nothing — a deleted template. A finding, not a failure. */
export class ContentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentNotFoundError';
  }
}
