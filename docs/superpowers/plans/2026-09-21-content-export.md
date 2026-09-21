# Campaign Content Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch every piece of content every campaign references — with every asset it depends on — into a raw store, and export it as a neutral, per-campaign migration package.

**Architecture:** Two stages. `fetch-content` (network, resumable) collects content ids from the extracted XML, fetches each `(kind, attribute, id)` once through a per-kind `ContentSource`, downloads the assets each item references, and writes everything under `artifacts/<app>/content/`. `export` (offline, pure planner + thin writer) combines the normalised campaigns with that store into `export/<app>/`. Sources are the only endpoint-specific code and are registered in one table.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥ 20 global `fetch`, Playwright, cheerio, vitest, tsx. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-content-export-design.md`

## Global Constraints

- **Read-only.** Every Keap request is a GET through an existing guard: REST through `assertAllowed` in `src/api/guard.ts`, browser/session requests through `safeGet` in `src/guard/readonly.ts`.
- **The Keap session never reaches a third-party host.** Keap-hosted assets use the session fetcher; everything else uses an anonymous `fetch` with no cookies and no API key.
- **The API key is never logged, echoed, written to disk or put in an error message.**
- **No contact data.** `/emails` (sent history) stays refused.
- Asset limits: **25 MB per file, 30 s timeout.**
- Secrets redaction pattern, verbatim from the spec: `/key|token|secret|password|passwd|auth|signature|sig$/i`, plus `Authorization`, `Cookie`, `X-Api-Key`-style headers and URL userinfo. Replacement text: `«redacted»`.
- Campaign folder: `<funnelId>-<slug>`, slug lowercased, non-alphanumerics collapsed to `-`, **truncated to 60 characters**.
- `export/` is gitignored.
- Import specifiers carry `.js` even for TypeScript sources.
- **No test touches the network.** Fakes and fixtures only.
- `npm run typecheck` and `npm test` pass at the end of every task. The existing 484 tests pass unchanged.

---

## How this plan is split

The spec's phase 0 spike decides **where** each content kind is read from (REST or an editor GET). Everything else — id collection, the raw store, progress, assets, redaction, the export — is independent of that answer and is fully specified here.

| Part | Tasks | Needs a live session |
|---|---|---|
| Phase 0 spike | 1 | Yes — the user logs in |
| Source-independent infrastructure | 2–11 | No |
| Per-kind sources | **Separate plan**, `2026-09-2x-content-sources.md`, written from Task 1's findings | Yes, for the final live check |

Tasks 2–11 do not depend on Task 1 and may run first if a login is not available. The sources plan is written after Task 1 because each source's URL, parser and validator come straight from the captured responses; writing them now would be guessing, and every endpoint in this project has been settled by running it.

## Context an implementer needs

- **Where ids come from.** Campaign XML nodes carry content ids as attributes (`marketingEmailId="2048L"`) or `<Array as="…">` lists. `parseNodes` in `src/normalize/nodes.ts` lifts every attribute in `FK_ATTRIBUTES` into `node.references`, already stripped of the Java `L` suffix; `referenceValues(references, attribute)` reads both shapes as a list. All the attributes this plan needs are already in `FK_ATTRIBUTES`.
- **Draft and published.** `artifacts/<app>/campaigns/<funnelId>/draft.xml` and `publish.xml` (empty when never published). The normalised campaign (`artifacts/<app>/normalized/<funnelId>.json`) is built from the draft only, so id collection parses both XML files itself.
- **Id spaces.** Two attributes of the same kind can be different id spaces (`webformId 681` and `internalFormId 681` are unrelated). An item is therefore keyed by `(kind, attribute, id)`, never `(kind, id)`.
- **Status is not evidence.** The decision editor returned HTTP 200 with a 75-byte empty shell. Every source validates content, and the runner never stores an item that failed validation.
- **Session expiry** is a typed error (`SessionExpiredError`, detected with `isSessionExpired`). A bulk loop stops on it and leaves the item pending.
- **Existing patterns to mirror:** `src/progress.ts` (progress file, temp-file-and-rename writes, reconcile against disk) and `src/cli/extractAll.ts` (flag parsing, `fail()`, the fetch loop, abort on expiry).
- **Test fixtures:** `test/fixtures/graphFixtures.ts` exports `makeNode`, `makeSequence`, `makeDecision`, `makeCampaign`.

## File structure

```
src/content/
  types.ts              kinds, item keys, neutral content records, the ContentSource contract
  collect.ts            content ids from campaign XML → a deduplicated queue
  progress.ts           content-progress.json
  store.ts              raw item store: artifacts/<app>/content/raw/<kind>/<attribute>-<id>/
  redact.ts             secret redaction for HTTP content
  run.ts                fetch one item: validate, retry, assets, store
  sources/index.ts      the SOURCES registry (filled by the sources plan)
  assets/discover.ts    asset URLs in HTML and CSS; URL classification
  assets/download.ts    fetchers and downloadAsset
  assets/assetStore.ts  asset index and hashed files: artifacts/<app>/content/assets/
src/export/
  mergeFields.ts        merge-field detection
  htmlText.ts           HTML → readable plain text
  paths.ts              slugs, folder names, content refs, attachment names
  campaignDoc.ts        normalised campaign → neutral campaign.json
  plan.ts               pure: inputs → list of files to write + manifest
  write.ts              writes a plan to disk
src/cli/
  fetchContent.ts       npm run fetch-content
  export.ts             npm run export
```

---

### Task 1: Phase 0 — discovery spike

Done together with the user in a live session. **Throwaway code only** — the capture script lives in the scratchpad and is never committed. The outputs are a findings section and fixtures.

**Files:**
- Modify: `docs/spike-findings.md` (append a "Content sources" section)
- Create: `test/fixtures/content/<kind>/…` (scrubbed captured responses)
- Create: `docs/superpowers/plans/2026-09-2x-content-sources.md` (the follow-up plan)

- [ ] **Step 1: Pick the spike campaigns**

From `artifacts/<app>/normalized/*.json`, find campaigns that between them contain: a legacy `email`, a `bardEmail`, an `unlayerEmail`, a `landingPage` (and one with `unlayerLandingPageId`), a web form goal (`webformId`), a smart form (`smartFormInstanceId`), an SMS step (`marketingAutomatedSmsId` or `automationMessageId`), a `noteApplied`/`note` step with `marketingNoteId`, and an `http` step with `httpRequestConfigId`. Record the funnel ids and cell ids.

```bash
node -e '
const fs=require("fs");const dir="artifacts/se232/normalized";
const want=["marketingEmailId","unlayerLandingPageId","landingPageId","webformId","smartFormInstanceId","internalFormId","marketingAutomatedSmsId","automationMessageId","marketingNoteId","httpRequestConfigId"];
const hits={};for(const f of fs.readdirSync(dir)){const c=JSON.parse(fs.readFileSync(dir+"/"+f));
const nodes=[...c.goals,...c.sequences.flatMap(s=>s.steps),...c.decisions,...c.notes];
for(const n of nodes)for(const a of want)if(n.references[a]){(hits[a+"/"+n.style]??=[]).push(c.funnelId+":"+n.cellId+"="+n.references[a]);}}
for(const[k,v]of Object.entries(hits))console.log(k,v.length,v.slice(0,3).join(" "));'
```

- [ ] **Step 2: User logs in**

Ask the user to run `npm run login -- --app <app>` in their own terminal.

- [ ] **Step 3: Capture editor traffic (throwaway script in the scratchpad)**

The script opens a **headed** session through `openSession` — so the read-only guard is installed and any save the editor attempts is blocked — navigates to `${baseUrl}/app/funnel/funnelEditor?funnelId=<id>`, and records every response whose URL is on the app host or a Keap API host: method, URL, status, content type, byte count, and the body of every text response, saved to a numbered file. The user opens each content step's editor; press Enter to finish and dump the log. Repeat per spike campaign.

For each kind, identify the single GET whose response carries the content (subject, body, HTML, SMS text, note body, HTTP URL/fields). Record: path, query parameters and which come from the XML, response type, and what distinguishes a genuine response from an empty shell.

- [ ] **Step 4: Probe the REST email template endpoint**

With `KEAP_API_KEY` set **in the user's terminal** (use the terminal tool, never paste the key into a command), call `createClient(key).get('/crm/rest/v2/emails/templates/<id>')` for a legacy `email` id and a `bardEmail` id, and also try `/crm/rest/v1/emails/templates/<id>`. Record which fields come back: HTML body, plain text, from, reply-to, to, cc, bcc, subject, preview text, attachments. Confirm whether the record's name matches the step's name (handoff noted mismatches).

- [ ] **Step 5: Attachments and asset hosts**

For an email with an attachment: where the attachment is listed and the GET that downloads it. Across all captured HTML: every distinct asset host. Any Keap file host not already matched by `KEAP_HOST_SUFFIXES` (Task 5) is recorded for the sources plan to add.

- [ ] **Step 6: Guard check**

Confirm every captured content request is a GET and `classifyRequest` allows it. Record the `requests.log`-style counts: allowed, blocked, non-GET blocked.

- [ ] **Step 7: Scrub and save fixtures**

For each kind, save one genuine response and one empty/invalid response under `test/fixtures/content/<kind>/`. Replace personal names, email addresses, phone numbers, API keys and tokens with obvious placeholders (`person@example.com`, `REDACTED_KEY`). Keep structure and merge fields intact.

- [ ] **Step 8: Write findings**

Append "Content sources (2026-09)" to `docs/spike-findings.md`: per kind — REST or editor, exact path, parameters, validation marker, fields available, fields **not** available, and any kind with no viable read-only source (which is then dropped from the sources plan, not worked around).

- [ ] **Step 9: Write the sources plan**

Using writing-plans, write `docs/superpowers/plans/2026-09-2x-content-sources.md`: one task per kind implementing `ContentSource` (Task 2's interface) against the fixtures, registering it in `src/content/sources/index.ts`, adding any editor path to a content allowlist and any REST path to `src/api/guard.ts`, and a final live `npm run fetch-content -- --app <app> --limit 5` spot check followed by `npm run export`.

- [ ] **Step 10: Commit**

```bash
git add docs/spike-findings.md test/fixtures/content docs/superpowers/plans/2026-09-2x-content-sources.md
git commit -m "docs: content source findings and the sources plan"
```

---

### Task 2: Content types and id collection

**Files:**
- Create: `src/content/types.ts`
- Create: `src/content/collect.ts`
- Test: `test/contentCollect.test.ts`

**Interfaces:**
- Consumes: `NormalizedNode`, `parseNodes`, `referenceValues` from `src/normalize/nodes.ts`; `campaignDirFor` from `src/app.ts`.
- Produces:
  - `CONTENT_KINDS`, `ContentKind`, `KIND_ATTRIBUTES`, `KIND_FOLDERS`
  - `ContentItemKey { kind; attribute; id }`, `itemKey(key): string`, `itemDirName(key): string`
  - `StepVersion`, `ContentUse`, `ContentItem`
  - records: `EmailContent`, `LandingPageContent`, `FormContent`, `FormField`, `SmsContent`, `NoteContent`, `HttpContent`, `NameValue`, `Attachment`, `ContentRecord`
  - `ContentFile`, `FetchedContent`, `FetchContext`, `ContentSource`, `ContentNotFoundError`
  - `contentRefsOf(nodes): { key; node }[]`, `campaignRefs(funnelId, draftNodes, publishNodes): ContentRef[]`, `buildQueue(refs): ContentItem[]`, `loadCampaignNodes(app, funnelId): Promise<CampaignNodes | null>`

- [ ] **Step 1: Write the failing test**

```ts
// test/contentCollect.test.ts
import { describe, expect, it } from 'vitest';
import { buildQueue, campaignRefs, contentRefsOf } from '../src/content/collect.js';
import { itemDirName, itemKey } from '../src/content/types.js';
import { makeNode } from './fixtures/graphFixtures.js';

const email = (cellId: string, id: string) =>
  makeNode({
    cellId,
    style: 'email',
    name: `Email ${id}`,
    references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
  });

describe('itemKey / itemDirName', () => {
  it('keys on kind, attribute and id', () => {
    expect(itemKey({ kind: 'form', attribute: 'webformId', id: '681' })).toBe('form:webformId:681');
  });

  it('uses the bare id for the primary attribute and prefixes the others', () => {
    expect(itemDirName({ kind: 'form', attribute: 'webformId', id: '681' })).toBe('681');
    expect(itemDirName({ kind: 'form', attribute: 'internalFormId', id: '681' })).toBe(
      'internalFormId-681',
    );
  });
});

describe('contentRefsOf', () => {
  it('lifts scalar references', () => {
    const refs = contentRefsOf([email('7', '2048')]);
    expect(refs.map((r) => r.key)).toEqual([
      { kind: 'email', attribute: 'marketingEmailId', id: '2048' },
    ]);
  });

  it('lifts array references, one per value', () => {
    const node = makeNode({
      style: 'landingPage',
      references: { tagIds: [], tagCategoryIds: [], landingPageId: ['11', '12'] },
    });
    expect(contentRefsOf([node]).map((r) => r.key.id)).toEqual(['11', '12']);
  });

  it('keeps two id spaces of the same kind apart', () => {
    const node = makeNode({
      style: 'newsletterRequest',
      references: { tagIds: [], tagCategoryIds: [], webformId: '681', internalFormId: '681' },
    });
    expect(contentRefsOf([node]).map((r) => itemKey(r.key))).toEqual([
      'form:webformId:681',
      'form:internalFormId:681',
    ]);
  });

  it('ignores ids that are not integers', () => {
    const node = makeNode({
      references: { tagIds: [], tagCategoryIds: [], marketingEmailId: '../../etc' },
    });
    expect(contentRefsOf([node])).toEqual([]);
  });
});

describe('campaignRefs', () => {
  it('marks draft-only, published-only and shared steps', () => {
    const refs = campaignRefs(
      '987',
      [email('7', '1'), email('8', '2')],
      [email('7', '1'), email('9', '3')],
    );
    expect(refs.map((r) => [r.use.cellId, r.use.version])).toEqual([
      ['7', 'both'],
      ['8', 'draft'],
      ['9', 'published'],
    ]);
    expect(refs[0]?.use).toMatchObject({ funnelId: '987', style: 'email', name: 'Email 1' });
  });
});

describe('buildQueue', () => {
  it('fetches shared content once and remembers every use', () => {
    const queue = buildQueue([
      ...campaignRefs('1', [email('7', '2048')], []),
      ...campaignRefs('2', [email('4', '2048')], []),
    ]);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.usedBy.map((u) => u.funnelId)).toEqual(['1', '2']);
  });

  it('orders by kind, then attribute, then numeric id', () => {
    const sms = makeNode({
      cellId: '3',
      style: 'sms',
      references: { tagIds: [], tagCategoryIds: [], marketingAutomatedSmsId: '5' },
    });
    const queue = buildQueue(campaignRefs('1', [sms, email('1', '100'), email('2', '9')], []));
    expect(queue.map((i) => itemKey(i))).toEqual([
      'email:marketingEmailId:9',
      'email:marketingEmailId:100',
      'sms:marketingAutomatedSmsId:5',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/contentCollect.test.ts`
Expected: FAIL — cannot find module `../src/content/collect.js`.

- [ ] **Step 3: Write `src/content/types.ts`**

```ts
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
  landingPage: ['landingPageId', 'unlayerLandingPageId'],
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
}

export interface SmsContent {
  kind: 'sms';
  name: string | null;
  text: string;
  sender: string | null;
}

export interface NoteContent {
  kind: 'note';
  name: string | null;
  type: string | null;
  subject: string | null;
  body: string;
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
```

- [ ] **Step 4: Write `src/content/collect.ts`**

```ts
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { campaignDirFor } from '../app.js';
import { type NormalizedNode, parseNodes, referenceValues } from '../normalize/nodes.js';
import {
  CONTENT_KINDS,
  type ContentItem,
  type ContentItemKey,
  type ContentUse,
  KIND_ATTRIBUTES,
  itemKey,
} from './types.js';

export interface ContentRef {
  key: ContentItemKey;
  use: ContentUse;
}

/**
 * Keap content ids are integers. Anything else is refused here because ids
 * become path segments in the store.
 */
const CONTENT_ID = /^\d+$/;

/** Every content reference the nodes make, one per (node, attribute, id). */
export function contentRefsOf(
  nodes: NormalizedNode[],
): { key: ContentItemKey; node: NormalizedNode }[] {
  const out: { key: ContentItemKey; node: NormalizedNode }[] = [];
  for (const node of nodes) {
    for (const kind of CONTENT_KINDS) {
      for (const attribute of KIND_ATTRIBUTES[kind]) {
        for (const id of referenceValues(node.references, attribute)) {
          if (CONTENT_ID.test(id)) out.push({ key: { kind, attribute, id }, node });
        }
      }
    }
  }
  return out;
}

/**
 * A campaign's content references across its draft and published versions.
 *
 * A step is `both` when the same cell points at the same content in each,
 * `draft` or `published` when only one version has it.
 */
export function campaignRefs(
  funnelId: string,
  draftNodes: NormalizedNode[],
  publishNodes: NormalizedNode[],
): ContentRef[] {
  const draft = contentRefsOf(draftNodes);
  const published = contentRefsOf(publishNodes);
  const refId = (r: { key: ContentItemKey; node: NormalizedNode }) =>
    `${r.node.cellId}|${itemKey(r.key)}`;
  const publishedIds = new Set(published.map(refId));
  const draftIds = new Set(draft.map(refId));

  const use = (node: NormalizedNode, version: ContentUse['version']): ContentUse => ({
    funnelId,
    cellId: node.cellId,
    style: node.style,
    name: node.name,
    version,
  });

  const refs: ContentRef[] = draft.map((r) => ({
    key: r.key,
    use: use(r.node, publishedIds.has(refId(r)) ? 'both' : 'draft'),
  }));
  for (const r of published) {
    if (!draftIds.has(refId(r))) refs.push({ key: r.key, use: use(r.node, 'published') });
  }
  return refs;
}

const KIND_ORDER = new Map(CONTENT_KINDS.map((kind, index) => [kind, index]));

/** One item per (kind, attribute, id), carrying every step that uses it. */
export function buildQueue(refs: ContentRef[]): ContentItem[] {
  const byKey = new Map<string, ContentItem>();
  for (const { key, use } of refs) {
    const k = itemKey(key);
    const existing = byKey.get(k);
    if (existing) existing.usedBy.push(use);
    else byKey.set(k, { ...key, usedBy: [use] });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) ||
      a.attribute.localeCompare(b.attribute) ||
      Number(a.id) - Number(b.id),
  );
}

export interface CampaignNodes {
  funnelId: string;
  draft: NormalizedNode[];
  published: NormalizedNode[];
}

/**
 * Parses both XML files of an extracted campaign.
 *
 * The normalised campaign is built from the draft alone, so a step that exists
 * only in the published version would be invisible from there.
 */
export async function loadCampaignNodes(
  app: string,
  funnelId: string,
): Promise<CampaignNodes | null> {
  const dir = campaignDirFor(app, funnelId);
  const draftPath = join(dir, 'draft.xml');
  if (!existsSync(draftPath)) return null;

  const draft = parseNodes(await readFile(draftPath, 'utf8')).nodes;
  const publishPath = join(dir, 'publish.xml');
  const publishXml = existsSync(publishPath) ? await readFile(publishPath, 'utf8') : '';
  const published = publishXml.trim() === '' ? [] : parseNodes(publishXml).nodes;
  return { funnelId, draft, published };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/contentCollect.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/types.ts src/content/collect.ts test/contentCollect.test.ts
git commit -m "feat: collect content ids from campaign draft and published XML"
```

---

### Task 3: Content progress

**Files:**
- Create: `src/content/progress.ts`
- Test: `test/contentProgress.test.ts`

**Interfaces:**
- Consumes: `ContentItemKey`, `itemKey` (Task 2); `normalizeAppName`.
- Produces: `ItemStatus`, `AssetCounts`, `ItemEntry`, `ContentProgress`, `emptyAssetCounts()`, `emptyContentProgress(app, now)`, `pendingItems(progress, items, force)`, `recordItem(progress, key, entry, now)`, `reconcileContent(progress, isStored, now)`, `contentProgressPathFor(app)`, `loadContentProgress(app)`, `saveContentProgress(app, progress)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/contentProgress.test.ts
import { describe, expect, it } from 'vitest';
import {
  type ContentProgress,
  contentProgressPathFor,
  emptyContentProgress,
  pendingItems,
  reconcileContent,
  recordItem,
} from '../src/content/progress.js';
import type { ContentItemKey } from '../src/content/types.js';

const NOW = '2026-09-21T06:00:00.000Z';
const LATER = '2026-09-21T06:05:00.000Z';
const item = (id: string): ContentItemKey => ({ kind: 'email', attribute: 'marketingEmailId', id });

function fixture(): ContentProgress {
  return {
    app: 'jordan',
    startedAt: NOW,
    updatedAt: NOW,
    entries: {
      'email:marketingEmailId:1': { status: 'done', at: NOW },
      'email:marketingEmailId:2': { status: 'failed', at: NOW, error: 'timeout' },
      'email:marketingEmailId:3': { status: 'notFound', at: NOW },
    },
  };
}

describe('pendingItems', () => {
  const all = ['1', '2', '3', '4'].map(item);

  it('retries failures and skips done and notFound', () => {
    expect(pendingItems(fixture(), all, false).map((i) => i.id)).toEqual(['2', '4']);
  });

  it('returns everything when forced', () => {
    expect(pendingItems(fixture(), all, true)).toHaveLength(4);
  });
});

describe('recordItem', () => {
  it('records without mutating', () => {
    const before = fixture();
    const after = recordItem(before, 'email:marketingEmailId:4', { status: 'done', at: LATER }, LATER);
    expect(after.entries['email:marketingEmailId:4']?.status).toBe('done');
    expect(after.updatedAt).toBe(LATER);
    expect(before.entries['email:marketingEmailId:4']).toBeUndefined();
  });
});

describe('reconcileContent', () => {
  it('demotes done entries whose stored item is missing', () => {
    const { progress, demoted } = reconcileContent(fixture(), () => false, LATER);
    expect(demoted).toEqual(['email:marketingEmailId:1']);
    expect(progress.entries['email:marketingEmailId:1']).toBeUndefined();
    expect(progress.entries['email:marketingEmailId:3']?.status).toBe('notFound');
  });

  it('returns the same object when nothing changes', () => {
    const before = fixture();
    expect(reconcileContent(before, () => true, LATER).progress).toBe(before);
  });
});

describe('paths', () => {
  it('files progress beside the other artifacts', () => {
    expect(contentProgressPathFor('Jordan')).toBe('artifacts/jordan/content-progress.json');
    expect(emptyContentProgress('jordan', NOW).entries).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/contentProgress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/content/progress.ts`**

```ts
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName } from '../app.js';
import { type ContentItemKey, itemKey } from './types.js';

export type ItemStatus = 'done' | 'failed' | 'notFound';

export interface AssetCounts {
  downloaded: number;
  failed: number;
  tooLarge: number;
  skipped: number;
}

export interface ItemEntry {
  status: ItemStatus;
  at: string;
  error?: string;
  assets?: AssetCounts;
}

/** Keyed by itemKey — `kind:attribute:id`. */
export interface ContentProgress {
  app: string;
  startedAt: string;
  updatedAt: string;
  entries: Record<string, ItemEntry>;
}

export function emptyAssetCounts(): AssetCounts {
  return { downloaded: 0, failed: 0, tooLarge: 0, skipped: 0 };
}

export function emptyContentProgress(app: string, now: string): ContentProgress {
  return { app, startedAt: now, updatedAt: now, entries: {} };
}

/**
 * `failed` is pending again — usually transient. `notFound` is not: a deleted
 * template stays deleted, and asking again every run would only slow the run.
 * `--force` retries both.
 */
export function pendingItems<T extends ContentItemKey>(
  progress: ContentProgress,
  items: T[],
  force: boolean,
): T[] {
  if (force) return [...items];
  return items.filter((item) => {
    const status = progress.entries[itemKey(item)]?.status;
    return status !== 'done' && status !== 'notFound';
  });
}

export function recordItem(
  progress: ContentProgress,
  key: string,
  entry: ItemEntry,
  now: string,
): ContentProgress {
  return { ...progress, updatedAt: now, entries: { ...progress.entries, [key]: entry } };
}

/** Disk gets the final say over the progress file — the same rule as src/progress.ts. */
export function reconcileContent(
  progress: ContentProgress,
  isStored: (key: string) => boolean,
  now: string,
): { progress: ContentProgress; demoted: string[] } {
  const demoted: string[] = [];
  const entries: Record<string, ItemEntry> = {};
  for (const [key, entry] of Object.entries(progress.entries)) {
    if (entry.status === 'done' && !isStored(key)) {
      demoted.push(key);
      continue;
    }
    entries[key] = entry;
  }
  if (demoted.length === 0) return { progress, demoted };
  return { progress: { ...progress, updatedAt: now, entries }, demoted };
}

export function contentProgressPathFor(app: string): string {
  return join('artifacts', normalizeAppName(app), 'content-progress.json');
}

/** Null when absent or unreadable; the store on disk is unaffected either way. */
export async function loadContentProgress(app: string): Promise<ContentProgress | null> {
  try {
    return JSON.parse(await readFile(contentProgressPathFor(app), 'utf8')) as ContentProgress;
  } catch {
    return null;
  }
}

export async function saveContentProgress(app: string, progress: ContentProgress): Promise<void> {
  const path = contentProgressPathFor(app);
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(temp, path);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/contentProgress.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/progress.ts test/contentProgress.test.ts
git commit -m "feat: resumable progress record for content fetching"
```

---

### Task 4: Raw item store

**Files:**
- Create: `src/content/store.ts`
- Test: `test/contentStore.test.ts`

**Interfaces:**
- Consumes: Task 2 types.
- Produces: `assertSafeFileName(name)`, `contentRootFor(app)`, `rawItemDirFor(app, key)`, `StoredItem { key; fetchedAt; record; files: string[]; assetUrls: string[]; dir }`, `writeStoredItem(app, key, fetched, assetUrls, now, root?)`, `readStoredItem(app, key, root?)`, `isItemStored(app, key, root?)`.

`root` defaults to the working directory and exists so tests write into a temp directory.

- [ ] **Step 1: Write the failing test**

```ts
// test/contentStore.test.ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSafeFileName,
  isItemStored,
  rawItemDirFor,
  readStoredItem,
  writeStoredItem,
} from '../src/content/store.js';
import type { ContentItemKey, FetchedContent } from '../src/content/types.js';

const KEY: ContentItemKey = { kind: 'sms', attribute: 'marketingAutomatedSmsId', id: '5' };
const FETCHED: FetchedContent = {
  record: { kind: 'sms', name: 'Reminder', text: 'Hi ~Contact.FirstName~', sender: null },
  files: [],
  evidence: [{ name: 'response.json', body: '{"id":5}' }],
  assetUrls: [],
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'content-store-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('assertSafeFileName', () => {
  it.each(['body.html', 'page.html', 'response-1.json'])('accepts %s', (name) => {
    expect(() => assertSafeFileName(name)).not.toThrow();
  });

  it.each(['../x', '.hidden', 'a/b', '', 'x..y'])('refuses %s', (name) => {
    expect(() => assertSafeFileName(name)).toThrow(/Unsafe/);
  });
});

describe('the raw store', () => {
  it('files an item by kind and id space', () => {
    expect(rawItemDirFor('jordan', KEY)).toBe(
      'artifacts/jordan/content/raw/sms/marketingAutomatedSmsId-5',
    );
  });

  it('round-trips an item and marks it stored', async () => {
    expect(isItemStored('jordan', KEY, root)).toBe(false);
    await writeStoredItem('jordan', KEY, FETCHED, ['https://x/a.png'], '2026-09-21T00:00:00Z', root);

    expect(isItemStored('jordan', KEY, root)).toBe(true);
    const stored = await readStoredItem('jordan', KEY, root);
    expect(stored?.record).toEqual(FETCHED.record);
    expect(stored?.assetUrls).toEqual(['https://x/a.png']);
    const evidence = await readFile(join(stored?.dir ?? '', 'evidence', 'response.json'), 'utf8');
    expect(evidence).toBe('{"id":5}');
  });

  it('replaces a previous fetch entirely', async () => {
    await writeStoredItem('jordan', KEY, FETCHED, [], 'a', root);
    await writeStoredItem('jordan', KEY, { ...FETCHED, evidence: [] }, [], 'b', root);
    const stored = await readStoredItem('jordan', KEY, root);
    await expect(
      readFile(join(stored?.dir ?? '', 'evidence', 'response.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('returns null for an item never stored', async () => {
    expect(await readStoredItem('jordan', KEY, root)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/contentStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/content/store.ts`**

```ts
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName } from '../app.js';
import type { ContentItemKey, ContentRecord, FetchedContent } from './types.js';

/**
 * File names come from sources, which parse remote responses — so a name is a
 * path segment someone else chose. Refuse anything that is not a plain name.
 */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export function assertSafeFileName(name: string): void {
  if (!SAFE_FILE_NAME.test(name) || name.includes('..')) {
    throw new Error(`Unsafe content file name ${JSON.stringify(name)}`);
  }
}

export function contentRootFor(app: string): string {
  return join('artifacts', normalizeAppName(app), 'content');
}

export function rawItemDirFor(app: string, key: ContentItemKey): string {
  if (!/^[A-Za-z]+$/.test(key.attribute) || !/^\d+$/.test(key.id)) {
    throw new Error(`Unsafe content key ${key.kind}/${key.attribute}/${key.id}`);
  }
  return join(contentRootFor(app), 'raw', key.kind, `${key.attribute}-${key.id}`);
}

export interface StoredItem {
  key: ContentItemKey;
  fetchedAt: string;
  record: ContentRecord;
  /** Names under <dir>/files — the ones the export copies. */
  files: string[];
  /** Every asset URL this item uses, including stylesheet dependencies. */
  assetUrls: string[];
  /** Where the item lives on disk. Not persisted; derived on read. */
  dir: string;
}

/**
 * Replaces the item on disk. `item.json` is written last: its presence is what
 * marks the item complete, so a kill mid-write leaves an incomplete item that
 * the next run re-fetches rather than a partial one it trusts.
 */
export async function writeStoredItem(
  app: string,
  key: ContentItemKey,
  fetched: FetchedContent,
  assetUrls: string[],
  now: string,
  root = '.',
): Promise<StoredItem> {
  const dir = join(root, rawItemDirFor(app, key));
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'files'), { recursive: true });
  await mkdir(join(dir, 'evidence'), { recursive: true });

  for (const file of fetched.files) {
    assertSafeFileName(file.name);
    await writeFile(join(dir, 'files', file.name), file.body);
  }
  for (const file of fetched.evidence) {
    assertSafeFileName(file.name);
    await writeFile(join(dir, 'evidence', file.name), file.body);
  }

  const persisted = {
    key,
    fetchedAt: now,
    record: fetched.record,
    files: fetched.files.map((f) => f.name),
    assetUrls,
  };
  await writeFile(join(dir, 'item.json'), JSON.stringify(persisted, null, 2), 'utf8');
  return { ...persisted, dir };
}

export async function readStoredItem(
  app: string,
  key: ContentItemKey,
  root = '.',
): Promise<StoredItem | null> {
  const dir = join(root, rawItemDirFor(app, key));
  try {
    const persisted = JSON.parse(await readFile(join(dir, 'item.json'), 'utf8')) as Omit<
      StoredItem,
      'dir'
    >;
    return { ...persisted, dir };
  } catch {
    return null;
  }
}

export function isItemStored(app: string, key: ContentItemKey, root = '.'): boolean {
  return existsSync(join(root, rawItemDirFor(app, key), 'item.json'));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/contentStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/store.ts test/contentStore.test.ts
git commit -m "feat: raw store for fetched campaign content"
```

---

### Task 5: Asset discovery

**Files:**
- Create: `src/content/assets/discover.ts`
- Test: `test/assetDiscover.test.ts`

**Interfaces:**
- Consumes: cheerio.
- Produces: `SkipReason`, `SkippedUrl { url; reason }`, `DiscoveredAssets { download; links; skipped }`, `KEAP_HOST_SUFFIXES`, `KEAP_FILE_PATHS`, `isKeapHosted(url)`, `isPrivateHost(hostname)`, `classifyUrl(raw, base): { url } | SkippedUrl`, `parseSrcset(value)`, `cssUrls(css)`, `discoverHtmlAssets(html, base)`, `discoverCssUrls(css, cssUrl)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/assetDiscover.test.ts
import { describe, expect, it } from 'vitest';
import {
  classifyUrl,
  cssUrls,
  discoverCssUrls,
  discoverHtmlAssets,
  isKeapHosted,
  isPrivateHost,
  parseSrcset,
} from '../src/content/assets/discover.js';

describe('classifyUrl', () => {
  it('accepts absolute http(s) and drops the fragment', () => {
    expect(classifyUrl('https://cdn.example.com/a.png#x', null)).toEqual({
      url: 'https://cdn.example.com/a.png',
    });
  });

  it('upgrades protocol-relative URLs to https', () => {
    expect(classifyUrl('//cdn.example.com/a.png', null)).toEqual({
      url: 'https://cdn.example.com/a.png',
    });
  });

  it('resolves relative URLs against a base', () => {
    expect(classifyUrl('img/a.png', 'https://x.example.com/css/site.css')).toEqual({
      url: 'https://x.example.com/css/img/a.png',
    });
  });

  it.each([
    ['https://x.com/p?id=~Contact.Id~', 'mergeField'],
    ['https://x.com/p?id=%7EContact.Id%7E', 'mergeField'],
    ['data:image/png;base64,AAAA', 'inline'],
    ['img/a.png', 'unresolvable'],
    ['ftp://x.com/a.png', 'unsupportedScheme'],
    ['http://192.168.1.4/a.png', 'privateHost'],
    ['http://localhost:3000/a.png', 'privateHost'],
  ])('skips %s as %s', (url, reason) => {
    expect(classifyUrl(url, null)).toMatchObject({ reason });
  });
});

describe('isKeapHosted / isPrivateHost', () => {
  it('recognises Keap hosts and their subdomains only', () => {
    expect(isKeapHosted('https://se232.infusionsoft.com/Download?x=1')).toBe(true);
    expect(isKeapHosted('https://keap.com/a.png')).toBe(true);
    expect(isKeapHosted('https://notkeap.com/a.png')).toBe(false);
    expect(isKeapHosted('not a url')).toBe(false);
  });

  it.each(['10.0.0.1', '127.0.0.1', '172.20.1.1', '169.254.1.1', '[::1]', 'localhost'])(
    'treats %s as private',
    (host) => expect(isPrivateHost(host)).toBe(true),
  );

  it('treats public hosts as public', () => {
    expect(isPrivateHost('172.32.0.1')).toBe(false);
    expect(isPrivateHost('cdn.example.com')).toBe(false);
  });
});

describe('parseSrcset / cssUrls', () => {
  it('takes the URL from each candidate', () => {
    expect(parseSrcset('a.png 1x, https://x.com/b.png 2x')).toEqual(['a.png', 'https://x.com/b.png']);
  });

  it('finds quoted and unquoted url()', () => {
    expect(cssUrls(`a{background:url("x.png")} b{background:url(y.png)} c{src:url('z.woff2')}`)).toEqual(
      ['x.png', 'y.png', 'z.woff2'],
    );
  });
});

describe('discoverHtmlAssets', () => {
  const html = `
    <html><head>
      <link rel="stylesheet" href="https://cdn.example.com/site.css">
      <style>.hero{background:url(https://cdn.example.com/hero.jpg)}</style>
    </head><body>
      <img src="https://cdn.example.com/logo.png" srcset="https://cdn.example.com/logo@2x.png 2x">
      <img src="https://track.example.com/open.gif" width="1" height="1">
      <table><tr><td background="https://cdn.example.com/bg.png"></td></tr></table>
      <div style="background-image:url('https://cdn.example.com/div.png')"></div>
      <a href="https://se232.infusionsoft.com/Download?Id=4">Guide</a>
      <a href="https://se232.infusionsoft.com/files/brochure.pdf">Brochure</a>
      <a href="https://example.com/pricing">Pricing</a>
      <a href="https://example.com/r?u=~Contact.Id~">Unsubscribe</a>
      <img src="https://cdn.example.com/p.png?e=~Contact.Email~">
    </body></html>`;

  const found = discoverHtmlAssets(html, null);

  it('collects images, backgrounds, stylesheets and inline CSS', () => {
    expect(found.download).toEqual(
      expect.arrayContaining([
        'https://cdn.example.com/site.css',
        'https://cdn.example.com/hero.jpg',
        'https://cdn.example.com/logo.png',
        'https://cdn.example.com/logo@2x.png',
        'https://cdn.example.com/bg.png',
        'https://cdn.example.com/div.png',
      ]),
    );
  });

  it('downloads Keap file links and leaves page links as links', () => {
    expect(found.download).toContain('https://se232.infusionsoft.com/Download?Id=4');
    expect(found.download).toContain('https://se232.infusionsoft.com/files/brochure.pdf');
    expect(found.links).toEqual(['https://example.com/pricing', 'https://example.com/r?u=~Contact.Id~']);
  });

  it('skips tracking pixels and merge-field images', () => {
    expect(found.skipped).toEqual(
      expect.arrayContaining([
        { url: 'https://track.example.com/open.gif', reason: 'trackingPixel' },
        { url: 'https://cdn.example.com/p.png?e=~Contact.Email~', reason: 'mergeField' },
      ]),
    );
    expect(found.download).not.toContain('https://track.example.com/open.gif');
  });
});

describe('discoverCssUrls', () => {
  it('resolves url() and @import against the stylesheet', () => {
    const css = `@import "fonts.css"; body{background:url(../img/bg.png)}`;
    expect(discoverCssUrls(css, 'https://cdn.example.com/css/site.css').download).toEqual([
      'https://cdn.example.com/img/bg.png',
      'https://cdn.example.com/css/fonts.css',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/assetDiscover.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/content/assets/discover.ts`**

```ts
import { load } from 'cheerio';

export type SkipReason =
  | 'mergeField'
  | 'trackingPixel'
  | 'inline'
  | 'unresolvable'
  | 'unsupportedScheme'
  | 'privateHost';

export interface SkippedUrl {
  url: string;
  reason: SkipReason;
}

export interface DiscoveredAssets {
  /** Resolved URLs to download. */
  download: string[];
  /** Ordinary links — recorded, never followed. */
  links: string[];
  skipped: SkippedUrl[];
}

/**
 * Hosts whose requests carry the Keap session. Everything else is fetched
 * anonymously. Phase 0 records any further Keap file host it sees.
 */
export const KEAP_HOST_SUFFIXES = ['infusionsoft.com', 'infusionsoft.app', 'keap.com', 'keap.app'];

/** Keap-hosted link paths that serve a file rather than a page. */
export const KEAP_FILE_PATHS: RegExp[] = [/\/download/i, /\/files?\//i, /\/storage\//i];

const FILE_EXTENSION =
  /\.(pdf|docx?|xlsx?|pptx?|csv|txt|rtf|zip|mp3|mp4|mov|png|jpe?g|gif|webp|svg)$/i;

/** `~Contact.Id~`, raw or percent-encoded. Such a URL is per-contact and cannot be fetched meaningfully. */
const MERGE_FIELD_IN_URL = /~[A-Za-z][\w.]*~|%7E[A-Za-z][\w.]*%7E/i;

export function isKeapHosted(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return KEAP_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * URLs come from content someone else authored, and are fetched from the
 * operator's machine. A link to a private address is refused rather than
 * requested.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') {
    return true;
  }
  const octets = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!octets) return false;
  const a = Number(octets[1]);
  const b = Number(octets[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function classifyUrl(raw: string, base: string | null): { url: string } | SkippedUrl {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith('data:')) {
    return { url: trimmed.slice(0, 40), reason: 'inline' };
  }
  if (MERGE_FIELD_IN_URL.test(trimmed)) return { url: trimmed, reason: 'mergeField' };

  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  let parsed: URL;
  try {
    parsed = base === null ? new URL(candidate) : new URL(candidate, base);
  } catch {
    return { url: trimmed, reason: 'unresolvable' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: trimmed, reason: 'unsupportedScheme' };
  }
  if (isPrivateHost(parsed.hostname)) return { url: parsed.href, reason: 'privateHost' };
  parsed.hash = '';
  return { url: parsed.href };
}

export function parseSrcset(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
    .filter((url) => url !== '');
}

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(['"])([^'"]+)\1/gi;

export function cssUrls(css: string): string[] {
  return [...css.matchAll(CSS_URL)].map((m) => m[2]?.trim() ?? '').filter((u) => u !== '');
}

const isTiny = (value: string | undefined): boolean =>
  value !== undefined && ['0', '1', '0px', '1px'].includes(value.trim());

export function discoverHtmlAssets(html: string, base: string | null): DiscoveredAssets {
  const $ = load(html);
  const download = new Set<string>();
  const links = new Set<string>();
  const skipped: SkippedUrl[] = [];

  const consider = (raw: string | undefined): void => {
    if (raw === undefined || raw.trim() === '') return;
    const result = classifyUrl(raw, base);
    if ('reason' in result) skipped.push(result);
    else download.add(result.url);
  };

  $('img').each((_, element) => {
    const img = $(element);
    const src = img.attr('src');
    if (src !== undefined && isTiny(img.attr('width')) && isTiny(img.attr('height'))) {
      skipped.push({ url: src, reason: 'trackingPixel' });
    } else {
      consider(src);
    }
    for (const url of parseSrcset(img.attr('srcset'))) consider(url);
  });
  $('source[srcset]').each((_, element) => {
    for (const url of parseSrcset($(element).attr('srcset'))) consider(url);
  });
  $('[background]').each((_, element) => consider($(element).attr('background')));
  $('link[href]').each((_, element) => {
    const rel = ($(element).attr('rel') ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('stylesheet') || rel.includes('icon')) consider($(element).attr('href'));
  });
  $('[style]').each((_, element) => {
    for (const url of cssUrls($(element).attr('style') ?? '')) consider(url);
  });
  $('style').each((_, element) => {
    for (const url of cssUrls($(element).text())) consider(url);
  });

  $('a[href]').each((_, element) => {
    const href = ($(element).attr('href') ?? '').trim();
    if (href === '' || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    const result = classifyUrl(href, base);
    if (!('reason' in result) && isKeapHosted(result.url)) {
      const path = new URL(result.url).pathname;
      if (FILE_EXTENSION.test(path) || KEAP_FILE_PATHS.some((p) => p.test(path))) {
        download.add(result.url);
        return;
      }
    }
    links.add(href);
  });

  return { download: [...download], links: [...links], skipped };
}

/** Assets a stylesheet pulls in. Followed one level only — see src/content/run.ts. */
export function discoverCssUrls(
  css: string,
  cssUrl: string,
): { download: string[]; skipped: SkippedUrl[] } {
  const download = new Set<string>();
  const skipped: SkippedUrl[] = [];
  const imports = [...css.matchAll(CSS_IMPORT)].map((m) => m[2] ?? '');
  for (const raw of [...cssUrls(css), ...imports]) {
    if (raw === '') continue;
    const result = classifyUrl(raw, cssUrl);
    if ('reason' in result) skipped.push(result);
    else download.add(result.url);
  }
  return { download: [...download], skipped };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/assetDiscover.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/assets/discover.ts test/assetDiscover.test.ts
git commit -m "feat: find the assets campaign content depends on"
```

---

### Task 6: Asset download and the asset store

**Files:**
- Create: `src/content/assets/download.ts`
- Create: `src/content/assets/assetStore.ts`
- Test: `test/assetDownload.test.ts`

**Interfaces:**
- Consumes: `isKeapHosted` (Task 5); `safeGet`; `assertResponseAuthenticated`; `isSessionExpired`; `assertSafeFileName`, `contentRootFor` (Task 4).
- Produces:
  - `MAX_ASSET_BYTES`, `ASSET_TIMEOUT_MS`, `AssetResponse`, `AssetFetcher`, `AssetFetchers { keap; anonymous }`, `AssetStatus`, `AssetRecord`, `AssetTooLargeError`, `extensionFor(url, contentType)`, `downloadAsset(url, fetchers, maxBytes?)`, `anonymousFetcher(maxBytes?, timeoutMs?, doFetch?)`, `sessionFetcher(context)`
  - `AssetIndex { updatedAt; assets: Record<string, AssetRecord> }`, `AssetLedger { get(url); put(record, bytes); read(record) }`, `assetDirFor(app, root?)`, `assetFilePathFor(app, file, root?)`, `loadAssetIndex(app, root?)`, `saveAssetIndex(app, index, root?)`, `createAssetLedger(app, index, root?)` returning `AssetLedger & { index(): AssetIndex }`

- [ ] **Step 1: Write the failing test**

```ts
// test/assetDownload.test.ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetFilePathFor, createAssetLedger } from '../src/content/assets/assetStore.js';
import {
  type AssetFetcher,
  type AssetResponse,
  anonymousFetcher,
  downloadAsset,
  extensionFor,
} from '../src/content/assets/download.js';
import { SessionExpiredError } from '../src/errors.js';

function respond(body: string, overrides: Partial<AssetResponse> = {}): AssetResponse {
  const bytes = Buffer.from(body);
  return {
    status: 200,
    contentType: 'image/png',
    contentLength: bytes.length,
    body: async () => bytes,
    ...overrides,
  };
}

function recording(response: AssetResponse | Error) {
  const calls: string[] = [];
  const fetcher: AssetFetcher = async (url) => {
    calls.push(url);
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, fetcher };
}

describe('downloadAsset', () => {
  it('sends Keap-hosted URLs through the session and everything else anonymously', async () => {
    const keap = recording(respond('k'));
    const anonymous = recording(respond('a'));
    const fetchers = { keap: keap.fetcher, anonymous: anonymous.fetcher };

    await downloadAsset('https://se232.infusionsoft.com/a.png', fetchers);
    await downloadAsset('https://cdn.example.com/b.png', fetchers);

    expect(keap.calls).toEqual(['https://se232.infusionsoft.com/a.png']);
    expect(anonymous.calls).toEqual(['https://cdn.example.com/b.png']);
  });

  it('names a download by content hash', async () => {
    const { record, bytes } = await downloadAsset('https://cdn.example.com/b.png', {
      keap: recording(respond('')).fetcher,
      anonymous: recording(respond('hello')).fetcher,
    });
    expect(record).toMatchObject({
      status: 'downloaded',
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      file: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824.png',
      size: 5,
    });
    expect(bytes?.toString()).toBe('hello');
  });

  it('records HTTP failures without throwing', async () => {
    const { record } = await downloadAsset('https://cdn.example.com/x.png', {
      keap: recording(respond('')).fetcher,
      anonymous: recording(respond('', { status: 404 })).fetcher,
    });
    expect(record).toMatchObject({ status: 'failed', httpStatus: 404 });
  });

  it('refuses a declared size over the limit without reading the body', async () => {
    const { record, bytes } = await downloadAsset(
      'https://cdn.example.com/huge.mp4',
      {
        keap: recording(respond('')).fetcher,
        anonymous: recording(
          respond('', {
            contentLength: 100,
            body: async () => {
              throw new Error('body must not be read');
            },
          }),
        ).fetcher,
      },
      10,
    );
    expect(record.status).toBe('tooLarge');
    expect(bytes).toBeNull();
  });

  it('lets session expiry through so the run can stop', async () => {
    await expect(
      downloadAsset('https://se232.infusionsoft.com/a.png', {
        keap: recording(new SessionExpiredError('expired')).fetcher,
        anonymous: recording(respond('')).fetcher,
      }),
    ).rejects.toThrow(/expired/);
  });
});

describe('anonymousFetcher', () => {
  it('stops reading once the body passes the limit', async () => {
    const fakeFetch = (async () =>
      new Response('0123456789abcdef', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })) as typeof fetch;
    const response = await anonymousFetcher(8, 1000, fakeFetch)('https://cdn.example.com/a.txt');
    await expect(response.body()).rejects.toThrow(/exceeds/);
  });

  it('sends no cookie or key headers', async () => {
    let seen: RequestInit | undefined;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response('x');
    }) as typeof fetch;
    await anonymousFetcher(8, 1000, fakeFetch)('https://cdn.example.com/a.txt');
    expect(seen?.headers).toBeUndefined();
    expect(seen?.method).toBe('GET');
  });
});

describe('extensionFor', () => {
  it('prefers the content type, then the path, then bin', () => {
    expect(extensionFor('https://x/a', 'image/jpeg; charset=binary')).toBe('jpg');
    expect(extensionFor('https://x/a.PDF', null)).toBe('pdf');
    expect(extensionFor('https://x/download', null)).toBe('bin');
  });
});

describe('asset ledger', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'asset-store-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores bytes once by hash and records every status', async () => {
    const ledger = createAssetLedger('jordan', { updatedAt: '', assets: {} }, root);
    const file = `${'a'.repeat(64)}.png`;
    await ledger.put(
      { url: 'https://cdn.example.com/a.png', status: 'downloaded', sha256: 'a'.repeat(64), file },
      Buffer.from('png'),
    );
    await ledger.put({ url: 'https://x/p?e=~Contact.Email~', status: 'skipped', reason: 'mergeField' }, null);

    expect(await readFile(assetFilePathFor('jordan', file, root), 'utf8')).toBe('png');
    expect(ledger.get('https://cdn.example.com/a.png')?.status).toBe('downloaded');
    expect((await ledger.read(ledger.get('https://cdn.example.com/a.png')!))?.toString()).toBe('png');
    expect(Object.keys(ledger.index().assets)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/assetDownload.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/content/assets/download.ts`**

```ts
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
```

- [ ] **Step 4: Write `src/content/assets/assetStore.ts`**

```ts
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSafeFileName, contentRootFor } from '../store.js';
import type { AssetRecord } from './download.js';

/** Every asset URL ever seen, keyed by URL, with how it went. */
export interface AssetIndex {
  updatedAt: string;
  assets: Record<string, AssetRecord>;
}

export interface AssetLedger {
  get(url: string): AssetRecord | undefined;
  put(record: AssetRecord, bytes: Buffer | null): Promise<void>;
  read(record: AssetRecord): Promise<Buffer | null>;
}

export function assetDirFor(app: string, root = '.'): string {
  return join(root, contentRootFor(app), 'assets');
}

export function assetFilePathFor(app: string, file: string, root = '.'): string {
  assertSafeFileName(file);
  return join(assetDirFor(app, root), file);
}

function indexPathFor(app: string, root: string): string {
  return join(assetDirFor(app, root), 'index.json');
}

export async function loadAssetIndex(app: string, root = '.'): Promise<AssetIndex> {
  try {
    return JSON.parse(await readFile(indexPathFor(app, root), 'utf8')) as AssetIndex;
  } catch {
    return { updatedAt: '', assets: {} };
  }
}

export async function saveAssetIndex(app: string, index: AssetIndex, root = '.'): Promise<void> {
  await mkdir(assetDirFor(app, root), { recursive: true });
  const path = indexPathFor(app, root);
  await writeFile(`${path}.tmp`, JSON.stringify(index, null, 2), 'utf8');
  await rename(`${path}.tmp`, path);
}

/** Files are content-addressed, so the same image used by forty emails is stored once. */
export function createAssetLedger(
  app: string,
  initial: AssetIndex,
  root = '.',
): AssetLedger & { index(): AssetIndex } {
  const assets: Record<string, AssetRecord> = { ...initial.assets };
  let updatedAt = initial.updatedAt;

  return {
    get: (url) => assets[url],
    async put(record, bytes) {
      if (record.status === 'downloaded' && record.file && bytes) {
        const path = assetFilePathFor(app, record.file, root);
        if (!existsSync(path)) {
          await mkdir(assetDirFor(app, root), { recursive: true });
          await writeFile(path, bytes);
        }
      }
      assets[record.url] = record;
      updatedAt = new Date().toISOString();
    },
    async read(record) {
      if (record.status !== 'downloaded' || !record.file) return null;
      try {
        return await readFile(assetFilePathFor(app, record.file, root));
      } catch {
        return null;
      }
    },
    index: () => ({ updatedAt, assets: { ...assets } }),
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/assetDownload.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/assets/download.ts src/content/assets/assetStore.ts test/assetDownload.test.ts
git commit -m "feat: download content assets, with the session kept to Keap hosts"
```

---

### Task 7: Secret redaction

**Files:**
- Create: `src/content/redact.ts`
- Test: `test/redact.test.ts`

**Interfaces:**
- Consumes: `HttpContent`, `NameValue` (Task 2).
- Produces: `REDACTED`, `SECRET_NAME_PATTERN`, `Redaction { location: 'header' | 'query' | 'field' | 'url' | 'body'; name }`, `redactHttp(content): { content: HttpContent; redacted: Redaction[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/redact.test.ts
import { describe, expect, it } from 'vitest';
import { REDACTED, redactHttp } from '../src/content/redact.js';
import type { HttpContent } from '../src/content/types.js';

const base: HttpContent = {
  kind: 'http',
  name: 'Zapier hook',
  method: 'POST',
  url: 'https://hooks.example.com/catch/1',
  headers: [],
  fields: [],
  body: null,
};

describe('redactHttp', () => {
  it('redacts secret headers by name', () => {
    const { content, redacted } = redactHttp({
      ...base,
      headers: [
        { name: 'Authorization', value: 'Bearer abc' },
        { name: 'X-Api-Key', value: 'k1' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    });
    expect(content.headers).toEqual([
      { name: 'Authorization', value: REDACTED },
      { name: 'X-Api-Key', value: REDACTED },
      { name: 'Content-Type', value: 'application/json' },
    ]);
    expect(redacted).toEqual([
      { location: 'header', name: 'Authorization' },
      { location: 'header', name: 'X-Api-Key' },
    ]);
  });

  it('redacts secret fields but never merge fields', () => {
    const { content, redacted } = redactHttp({
      ...base,
      fields: [
        { name: 'api_token', value: 's3cret' },
        { name: 'contact_token', value: '~Contact.Id~' },
        { name: 'email', value: '~Contact.Email~' },
      ],
    });
    expect(content.fields.map((f) => f.value)).toEqual([REDACTED, '~Contact.Id~', '~Contact.Email~']);
    expect(redacted).toEqual([{ location: 'field', name: 'api_token' }]);
  });

  it('redacts query parameters and userinfo, leaving the rest of the URL as written', () => {
    const { content, redacted } = redactHttp({
      ...base,
      url: 'https://user:pw@hooks.example.com/x?key=abc&id=~Contact.Id~&page=2#frag',
    });
    expect(content.url).toBe(
      `https://${REDACTED}@hooks.example.com/x?key=${REDACTED}&id=~Contact.Id~&page=2#frag`,
    );
    expect(redacted).toEqual([
      { location: 'url', name: 'userinfo' },
      { location: 'query', name: 'key' },
    ]);
  });

  it('redacts secret keys inside a JSON body, at any depth', () => {
    const { content, redacted } = redactHttp({
      ...base,
      body: JSON.stringify({ auth: { password: 'p' }, email: '~Contact.Email~' }),
    });
    expect(JSON.parse(content.body ?? '')).toEqual({
      auth: REDACTED,
      email: '~Contact.Email~',
    });
    expect(redacted).toEqual([{ location: 'body', name: 'auth' }]);
  });

  it('leaves a non-JSON body alone', () => {
    expect(redactHttp({ ...base, body: 'plain text' }).content.body).toBe('plain text');
  });

  it('does not mutate its input', () => {
    const input = { ...base, headers: [{ name: 'Authorization', value: 'x' }] };
    redactHttp(input);
    expect(input.headers[0]?.value).toBe('x');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/redact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/content/redact.ts`**

```ts
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

  const parts = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    const name = decode(pair.slice(0, eq));
    if (!isSecret(name, decode(pair.slice(eq + 1)), 'query')) return pair;
    redacted.push({ location: 'query', name });
    return `${pair.slice(0, eq)}=${REDACTED}`;
  });
  return `${out.slice(0, queryAt)}?${parts.join('&')}${tail}`;
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/redact.test.ts`
Expected: PASS (6 tests). `redacted` is ordered URL, headers, fields, body — the order `redactHttp` visits them.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/redact.ts test/redact.test.ts
git commit -m "feat: redact credentials from exported HTTP steps"
```

---

### Task 8: Fetching one item

**Files:**
- Create: `src/content/run.ts`
- Create: `src/content/sources/index.ts`
- Test: `test/contentRun.test.ts`

**Interfaces:**
- Consumes: Task 2 types; `emptyAssetCounts`, `AssetCounts`, `ItemStatus` (Task 3); `classifyUrl`, `discoverHtmlAssets`, `discoverCssUrls` (Task 5); `downloadAsset`, `AssetFetchers`, `AssetRecord` (Task 6); `AssetLedger` (Task 6); `isSessionExpired`.
- Produces:
  - `SOURCES: Partial<Record<ContentKind, ContentSource>>` (empty; the sources plan fills it)
  - `ContentInvalidError`, `ItemOutcome { status; error?; assets? }`, `RunDeps { sources; ctx; fetchers; assets; saveItem(key, fetched, assetUrls) }`
  - `fetchValidated(source, key, ctx)`, `itemAssetUrls(fetched)`, `collectAssets(fetched, deps)`, `fetchItem(key, deps)`

- [ ] **Step 1: Write the failing test**

```ts
// test/contentRun.test.ts
import { describe, expect, it } from 'vitest';
import type { AssetLedger } from '../src/content/assets/assetStore.js';
import type { AssetFetcher, AssetRecord } from '../src/content/assets/download.js';
import { type RunDeps, fetchItem } from '../src/content/run.js';
import {
  ContentNotFoundError,
  type ContentItemKey,
  type ContentSource,
  type FetchedContent,
} from '../src/content/types.js';
import { SessionExpiredError } from '../src/errors.js';

const KEY: ContentItemKey = { kind: 'email', attribute: 'marketingEmailId', id: '2048' };

const EMAIL: FetchedContent = {
  record: {
    kind: 'email',
    name: 'Welcome',
    from: 'team@example.com',
    replyTo: null,
    to: '~Contact.Email~',
    cc: null,
    bcc: null,
    subject: 'Hi ~Contact.FirstName~',
    previewText: null,
    attachments: [{ name: 'guide.pdf', url: 'https://se232.infusionsoft.com/Download?Id=9' }],
  },
  files: [
    {
      name: 'body.html',
      body: '<link rel="stylesheet" href="https://cdn.example.com/s.css"><img src="https://cdn.example.com/logo.png">',
    },
  ],
  evidence: [],
  assetUrls: [],
};

function source(results: (FetchedContent | Error)[], validate?: ContentSource['validate']) {
  let calls = 0;
  const src: ContentSource = {
    kind: 'email',
    attributes: ['marketingEmailId'],
    needsApiKey: false,
    needsBrowser: true,
    async fetch() {
      const next = results[Math.min(calls, results.length - 1)];
      calls++;
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error('no result');
      return next;
    },
    validate: validate ?? (() => null),
  };
  return { src, calls: () => calls };
}

function memoryLedger(): AssetLedger & { records: Record<string, AssetRecord> } {
  const records: Record<string, AssetRecord> = {};
  const bytes: Record<string, Buffer> = {};
  return {
    records,
    get: (url) => records[url],
    async put(record, data) {
      records[record.url] = record;
      if (data) bytes[record.url] = data;
    },
    async read(record) {
      return bytes[record.url] ?? null;
    },
  };
}

const serve =
  (bodies: Record<string, { body: string; type: string } | number>): AssetFetcher =>
  async (url) => {
    const entry = bodies[url];
    if (entry === undefined || typeof entry === 'number') {
      return { status: typeof entry === 'number' ? entry : 404, contentType: null, contentLength: 0, body: async () => Buffer.alloc(0) };
    }
    const data = Buffer.from(entry.body);
    return { status: 200, contentType: entry.type, contentLength: data.length, body: async () => data };
  };

function deps(src: ContentSource, ledger = memoryLedger()) {
  const saved: { key: ContentItemKey; assetUrls: string[] }[] = [];
  const d: RunDeps = {
    sources: { email: src },
    ctx: { app: 'se232', baseUrl: 'https://se232.infusionsoft.com', browser: null, api: null },
    fetchers: {
      keap: serve({ 'https://se232.infusionsoft.com/Download?Id=9': { body: 'pdf', type: 'application/pdf' } }),
      anonymous: serve({
        'https://cdn.example.com/s.css': { body: 'body{background:url(bg.png)}', type: 'text/css' },
        'https://cdn.example.com/logo.png': { body: 'png', type: 'image/png' },
        'https://cdn.example.com/bg.png': 500,
      }),
    },
    assets: ledger,
    saveItem: async (key, _fetched, assetUrls) => {
      saved.push({ key, assetUrls });
    },
  };
  return { d, saved, ledger };
}

describe('fetchItem', () => {
  it('stores the item with every asset, following stylesheets one level', async () => {
    const { d, saved, ledger } = deps(source([EMAIL]).src);
    const outcome = await fetchItem(KEY, d);

    expect(outcome).toEqual({
      status: 'done',
      assets: { downloaded: 3, failed: 1, tooLarge: 0, skipped: 0 },
    });
    // Traversal order: HTML (img before link), then attachments, then stylesheet dependencies.
    expect(saved[0]?.assetUrls).toEqual([
      'https://cdn.example.com/logo.png',
      'https://cdn.example.com/s.css',
      'https://se232.infusionsoft.com/Download?Id=9',
      'https://cdn.example.com/bg.png',
    ]);
    expect(ledger.records['https://cdn.example.com/bg.png']?.status).toBe('failed');
  });

  it('retries an invalid response once and succeeds', async () => {
    let seen = 0;
    const { src, calls } = source([EMAIL], () => (seen++ === 0 ? 'empty shell' : null));
    const { d } = deps(src);
    expect((await fetchItem(KEY, d)).status).toBe('done');
    expect(calls()).toBe(2);
  });

  it('fails an item that stays invalid, and stores nothing', async () => {
    const { d, saved } = deps(source([EMAIL], () => 'empty shell').src);
    expect(await fetchItem(KEY, d)).toEqual({ status: 'failed', error: 'empty shell' });
    expect(saved).toEqual([]);
  });

  it('rejects a record of the wrong kind', async () => {
    const sms: FetchedContent = {
      ...EMAIL,
      record: { kind: 'sms', name: null, text: 'x', sender: null },
    };
    const { d } = deps(source([sms]).src);
    expect((await fetchItem(KEY, d)).error).toMatch(/sms record for a email/);
  });

  it('records a deleted template as notFound without retrying', async () => {
    const { src, calls } = source([new ContentNotFoundError('404')]);
    const { d } = deps(src);
    expect(await fetchItem(KEY, d)).toEqual({ status: 'notFound', error: '404' });
    expect(calls()).toBe(1);
  });

  it('lets session expiry stop the run', async () => {
    const { d } = deps(source([new SessionExpiredError('expired')]).src);
    await expect(fetchItem(KEY, d)).rejects.toThrow(/expired/);
  });

  it('reuses assets already in the ledger', async () => {
    const ledger = memoryLedger();
    await ledger.put({ url: 'https://cdn.example.com/logo.png', status: 'downloaded', file: 'x.png' }, null);
    const { d } = deps(source([EMAIL]).src, ledger);
    let anonymousCalls = 0;
    const inner = d.fetchers.anonymous;
    d.fetchers.anonymous = async (url) => {
      anonymousCalls++;
      return inner(url);
    };
    await fetchItem(KEY, d);
    expect(anonymousCalls).toBe(2); // s.css and bg.png, not logo.png
  });

  it('fails clearly when no source serves the id space', async () => {
    const { d } = deps(source([EMAIL]).src);
    const outcome = await fetchItem({ kind: 'form', attribute: 'webformId', id: '1' }, d);
    expect(outcome).toEqual({ status: 'failed', error: 'no source reads form webformId yet' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/contentRun.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/content/sources/index.ts`**

```ts
import type { ContentKind, ContentSource } from '../types.js';

/**
 * One source per content kind, each settled by phase 0
 * (docs/spike-findings.md, "Content sources"). Empty until the content-sources
 * plan lands; `fetch-content` reports every kind it cannot yet read.
 */
export const SOURCES: Partial<Record<ContentKind, ContentSource>> = {};
```

- [ ] **Step 4: Write `src/content/run.ts`**

```ts
import { isSessionExpired } from '../errors.js';
import type { AssetLedger } from './assets/assetStore.js';
import {
  type SkippedUrl,
  classifyUrl,
  discoverCssUrls,
  discoverHtmlAssets,
} from './assets/discover.js';
import { type AssetFetchers, type AssetRecord, downloadAsset } from './assets/download.js';
import { type AssetCounts, type ItemStatus, emptyAssetCounts } from './progress.js';
import {
  type ContentItemKey,
  type ContentKind,
  ContentNotFoundError,
  type ContentSource,
  type FetchContext,
  type FetchedContent,
} from './types.js';

export class ContentInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentInvalidError';
  }
}

export interface ItemOutcome {
  status: ItemStatus;
  error?: string;
  assets?: AssetCounts;
}

export interface RunDeps {
  sources: Partial<Record<ContentKind, ContentSource>>;
  ctx: FetchContext;
  fetchers: AssetFetchers;
  assets: AssetLedger;
  saveItem(key: ContentItemKey, fetched: FetchedContent, assetUrls: string[]): Promise<void>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Two attempts. A response that fails validation is not stored — the decision
 * editor returned HTTP 200 with an empty shell, so status proves nothing.
 */
export async function fetchValidated(
  source: ContentSource,
  key: ContentItemKey,
  ctx: FetchContext,
): Promise<FetchedContent> {
  let reason = 'no attempt made';
  for (let attempt = 0; attempt < 2; attempt++) {
    let fetched: FetchedContent;
    try {
      fetched = await source.fetch(key, ctx);
    } catch (error) {
      if (isSessionExpired(error) || error instanceof ContentNotFoundError) throw error;
      reason = messageOf(error);
      continue;
    }
    const invalid =
      fetched.record.kind !== key.kind
        ? `source returned a ${fetched.record.kind} record for a ${key.kind}`
        : source.validate(fetched);
    if (invalid === null) return fetched;
    reason = invalid;
  }
  throw new ContentInvalidError(reason);
}

/** Every asset an item uses: HTML scanning, the source's extras, and attachments. */
export function itemAssetUrls(fetched: FetchedContent): { download: string[]; skipped: SkippedUrl[] } {
  const download = new Set<string>();
  const skipped: SkippedUrl[] = [];

  for (const file of fetched.files) {
    if (!file.name.endsWith('.html')) continue;
    const found = discoverHtmlAssets(file.body.toString(), null);
    for (const url of found.download) download.add(url);
    skipped.push(...found.skipped);
  }

  const attachments = fetched.record.kind === 'email' ? fetched.record.attachments.map((a) => a.url) : [];
  for (const raw of [...fetched.assetUrls, ...attachments]) {
    const result = classifyUrl(raw, null);
    if ('reason' in result) skipped.push(result);
    else download.add(result.url);
  }
  return { download: [...download], skipped };
}

const isCss = (record: AssetRecord): boolean =>
  (record.contentType ?? '').toLowerCase().includes('text/css') || (record.file ?? '').endsWith('.css');

/**
 * Downloads what the ledger does not already hold. Stylesheets are followed
 * one level, for the fonts and images they pull in; a stylesheet's own imports
 * are not followed further.
 */
export async function collectAssets(
  fetched: FetchedContent,
  deps: RunDeps,
): Promise<{ urls: string[]; counts: AssetCounts }> {
  const { download, skipped } = itemAssetUrls(fetched);
  const counts = emptyAssetCounts();
  const urls: string[] = [];

  const recordSkips = async (list: SkippedUrl[]): Promise<void> => {
    for (const skip of list) {
      if (deps.assets.get(skip.url) === undefined) {
        await deps.assets.put({ url: skip.url, status: 'skipped', reason: skip.reason }, null);
      }
      urls.push(skip.url);
      counts.skipped++;
    }
  };
  await recordSkips(skipped);

  const queue = download.map((url) => ({ url, depth: 0 }));
  const seen = new Set<string>();
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next.url)) continue;
    seen.add(next.url);
    urls.push(next.url);

    let record = deps.assets.get(next.url);
    let bytes: Buffer | null = null;
    if (record === undefined || record.status === 'failed') {
      const result = await downloadAsset(next.url, deps.fetchers);
      record = result.record;
      bytes = result.bytes;
      await deps.assets.put(record, bytes);
    }
    counts[record.status]++;

    if (next.depth === 0 && record.status === 'downloaded' && isCss(record)) {
      const css = (bytes ?? (await deps.assets.read(record)))?.toString('utf8') ?? '';
      const nested = discoverCssUrls(css, next.url);
      for (const url of nested.download) queue.push({ url, depth: 1 });
      await recordSkips(nested.skipped);
    }
  }
  return { urls, counts };
}

export async function fetchItem(key: ContentItemKey, deps: RunDeps): Promise<ItemOutcome> {
  const source = deps.sources[key.kind];
  if (!source || !source.attributes.includes(key.attribute)) {
    return { status: 'failed', error: `no source reads ${key.kind} ${key.attribute} yet` };
  }

  let fetched: FetchedContent;
  try {
    fetched = await fetchValidated(source, key, deps.ctx);
  } catch (error) {
    if (isSessionExpired(error)) throw error;
    if (error instanceof ContentNotFoundError) return { status: 'notFound', error: error.message };
    return { status: 'failed', error: messageOf(error) };
  }

  const { urls, counts } = await collectAssets(fetched, deps);
  await deps.saveItem(key, fetched, urls);
  return { status: 'done', assets: counts };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/contentRun.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/run.ts src/content/sources/index.ts test/contentRun.test.ts
git commit -m "feat: fetch, validate and store one content item with its assets"
```

---

### Task 9: The `fetch-content` command

**Files:**
- Create: `src/cli/fetchContentArgs.ts`
- Create: `src/cli/fetchContent.ts`
- Modify: `package.json` (add script)
- Modify: `.gitignore` (add `export/`)
- Test: `test/fetchContentArgs.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–8; `openSession`, `closeSession`; `createClient`; `isSessionExpired`.
- Produces: `parseFetchContentArgs(argv): FetchContentArgs` (exported for test), the `fetch-content` npm script.

- [ ] **Step 1: Write the failing test**

```ts
// test/fetchContentArgs.test.ts
import { describe, expect, it } from 'vitest';
import { parseFetchContentArgs } from '../src/cli/fetchContentArgs.js';

describe('parseFetchContentArgs', () => {
  it('parses every flag', () => {
    expect(
      parseFetchContentArgs([
        '--app', 'SE232', '--kinds', 'email,sms', '--funnel', '987',
        '--force', '--limit', '5', '--delay', '0', '--headed',
      ]),
    ).toEqual({
      app: 'se232',
      kinds: ['email', 'sms'],
      funnelId: '987',
      force: true,
      limit: 5,
      delayMs: 0,
      headed: true,
    });
  });

  it('defaults', () => {
    expect(parseFetchContentArgs(['--app', 'jordan'])).toEqual({
      app: 'jordan',
      kinds: null,
      funnelId: null,
      force: false,
      limit: null,
      delayMs: 250,
      headed: false,
    });
  });

  it('refuses an unknown kind by name', () => {
    expect(() => parseFetchContentArgs(['--app', 'x', '--kinds', 'email,fax'])).toThrow(/fax/);
  });

  it('requires --app', () => {
    expect(() => parseFetchContentArgs([])).toThrow(/Usage/);
  });
});
```

Argument parsing lives in its own module so the test can import it without running the CLI's top-level `await main()`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/fetchContentArgs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/cli/fetchContentArgs.ts`**

```ts
import { normalizeAppName, normalizeFunnelId } from '../app.js';
import { CONTENT_KINDS, type ContentKind } from '../content/types.js';

export interface FetchContentArgs {
  app: string;
  kinds: ContentKind[] | null;
  funnelId: string | null;
  force: boolean;
  limit: number | null;
  delayMs: number;
  headed: boolean;
}

export const FETCH_CONTENT_USAGE =
  'Usage: npm run fetch-content -- --app <appName> [--kinds email,sms,…] [--funnel <id>] ' +
  '[--force] [--limit <n>] [--delay <ms>] [--headed]';

function valueOf(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function numeric(argv: string[], flag: string): number | null {
  const raw = valueOf(argv, flag);
  if (!argv.includes(flag)) return null;
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${flag} ${JSON.stringify(raw)}. Expected a non-negative integer.`);
  }
  return value;
}

export function parseFetchContentArgs(argv: string[]): FetchContentArgs {
  const rawApp = valueOf(argv, '--app');
  if (!rawApp) throw new Error(FETCH_CONTENT_USAGE);

  let kinds: ContentKind[] | null = null;
  const rawKinds = valueOf(argv, '--kinds');
  if (rawKinds !== undefined) {
    const requested = rawKinds.split(',').map((k) => k.trim()).filter((k) => k !== '');
    const unknown = requested.filter((k) => !(CONTENT_KINDS as readonly string[]).includes(k));
    if (unknown.length > 0 || requested.length === 0) {
      throw new Error(
        `Unknown --kinds ${JSON.stringify(unknown.join(','))}. Expected: ${CONTENT_KINDS.join(', ')}.`,
      );
    }
    kinds = requested as ContentKind[];
  }

  const limit = numeric(argv, '--limit');
  if (limit === 0) throw new Error('Invalid --limit "0". Expected a positive integer.');
  const rawFunnel = valueOf(argv, '--funnel');

  return {
    app: normalizeAppName(rawApp),
    kinds,
    funnelId: rawFunnel === undefined ? null : normalizeFunnelId(rawFunnel),
    force: argv.includes('--force'),
    limit,
    delayMs: numeric(argv, '--delay') ?? 250,
    headed: argv.includes('--headed'),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/fetchContentArgs.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `src/cli/fetchContent.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '../api/client.js';
import { closeSession, openSession } from '../auth/session.js';
import { createAssetLedger, loadAssetIndex, saveAssetIndex } from '../content/assets/assetStore.js';
import { anonymousFetcher, sessionFetcher } from '../content/assets/download.js';
import { type ContentRef, buildQueue, campaignRefs, loadCampaignNodes } from '../content/collect.js';
import {
  type AssetCounts,
  emptyAssetCounts,
  emptyContentProgress,
  loadContentProgress,
  pendingItems,
  reconcileContent,
  recordItem,
  saveContentProgress,
} from '../content/progress.js';
import { type RunDeps, fetchItem } from '../content/run.js';
import { SOURCES } from '../content/sources/index.js';
import { isItemStored, writeStoredItem } from '../content/store.js';
import { type ContentItem, type ContentKind, itemKey } from '../content/types.js';
import { isSessionExpired } from '../errors.js';
import { type FetchContentArgs, parseFetchContentArgs } from './fetchContentArgs.js';

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function countBy<T>(items: T[], keyOf: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[keyOf(item)] = (out[keyOf(item)] ?? 0) + 1;
  return out;
}

function served(item: ContentItem): boolean {
  return SOURCES[item.kind]?.attributes.includes(item.attribute) ?? false;
}

async function funnelIdsFor(args: FetchContentArgs): Promise<string[] | null> {
  if (args.funnelId !== null) return [args.funnelId];
  const queuePath = join('artifacts', args.app, 'campaigns.json');
  try {
    const queue = JSON.parse(await readFile(queuePath, 'utf8')) as {
      campaigns?: { funnelId: string }[];
    };
    return (queue.campaigns ?? []).map((c) => c.funnelId);
  } catch {
    fail(`No campaign list at ${queuePath}. Run:  npm run enumerate -- --app ${args.app}`);
    return null;
  }
}

async function main(): Promise<void> {
  let args: FetchContentArgs;
  try {
    args = parseFetchContentArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const funnelIds = await funnelIdsFor(args);
  if (funnelIds === null) return;

  const refs: ContentRef[] = [];
  const notExtracted: string[] = [];
  for (const funnelId of funnelIds) {
    const nodes = await loadCampaignNodes(args.app, funnelId);
    if (nodes === null) notExtracted.push(funnelId);
    else refs.push(...campaignRefs(funnelId, nodes.draft, nodes.published));
  }
  if (notExtracted.length === funnelIds.length) {
    fail(`No extracted campaigns found. Run:  npm run extract-all -- --app ${args.app}`);
    return;
  }
  if (notExtracted.length > 0) {
    console.log(
      `  warning: ${notExtracted.length} campaign(s) not extracted and skipped — ` +
        `run extract-all first: ${notExtracted.slice(0, 10).join(', ')}` +
        `${notExtracted.length > 10 ? ' …' : ''}`,
    );
  }

  let items = buildQueue(refs);
  if (args.kinds !== null) {
    const wanted = new Set<ContentKind>(args.kinds);
    items = items.filter((item) => wanted.has(item.kind));
  }
  const byKey = new Map(items.map((item) => [itemKey(item), item]));

  const now = () => new Date().toISOString();
  let progress = (await loadContentProgress(args.app)) ?? emptyContentProgress(args.app, now());
  const reconciled = reconcileContent(
    progress,
    (key) => {
      const item = byKey.get(key);
      return item === undefined || isItemStored(args.app, item);
    },
    now(),
  );
  progress = reconciled.progress;
  if (reconciled.demoted.length > 0) {
    console.log(`  warning: ${reconciled.demoted.length} item(s) marked done are missing and will be re-fetched`);
  }

  let pending = pendingItems(progress, items, args.force);
  const unserved = pending.filter((item) => !served(item));
  pending = pending.filter(served);
  if (args.limit !== null) pending = pending.slice(0, args.limit);

  console.log(
    `\n[${args.app}] ${items.length} content items across ${funnelIds.length - notExtracted.length} ` +
      `campaigns — ${pending.length} to fetch${args.force ? ' (forced)' : ''}`,
  );
  console.log(`  by kind: ${JSON.stringify(countBy(items, (i) => i.kind))}`);
  if (unserved.length > 0) {
    // Loud, not silent: these are real content the export will show as notFetched.
    console.log(
      `  NOT FETCHED — no source reads these yet: ` +
        `${JSON.stringify(countBy(unserved, (i) => `${i.kind}/${i.attribute}`))}`,
    );
  }

  const needKey = [...new Set(pending.filter((i) => SOURCES[i.kind]?.needsApiKey).map((i) => i.kind))];
  const apiKey = process.env.KEAP_API_KEY;
  if (needKey.length > 0 && !apiKey) {
    fail(`KEAP_API_KEY is required to fetch: ${needKey.join(', ')}. Nothing was fetched.`);
    return;
  }

  if (pending.length === 0) {
    console.log('  nothing to do\n');
    return;
  }

  // Always opened: Keap-hosted assets are fetched with the session even when
  // every source uses REST.
  let session: Awaited<ReturnType<typeof openSession>>;
  try {
    session = await openSession({ app: args.app, headless: !args.headed });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const ledger = createAssetLedger(args.app, await loadAssetIndex(args.app));
  const deps: RunDeps = {
    sources: SOURCES,
    ctx: {
      app: args.app,
      baseUrl: session.baseUrl,
      browser: session.context,
      api: apiKey ? createClient(apiKey) : null,
    },
    fetchers: { keap: sessionFetcher(session.context), anonymous: anonymousFetcher() },
    assets: ledger,
    saveItem: async (key, fetched, assetUrls) => {
      await writeStoredItem(args.app, key, fetched, assetUrls, now());
    },
  };

  const tally: Record<string, { done: number; failed: number; notFound: number }> = {};
  const assetTotals: AssetCounts = emptyAssetCounts();
  let aborted = false;
  const started = Date.now();

  try {
    for (const [index, item] of pending.entries()) {
      const label = `[${index + 1}/${pending.length}] ${item.kind} ${item.attribute}=${item.id}`;
      const bucket = (tally[item.kind] ??= { done: 0, failed: 0, notFound: 0 });
      try {
        const outcome = await fetchItem(item, deps);
        bucket[outcome.status]++;
        for (const [status, count] of Object.entries(outcome.assets ?? {})) {
          assetTotals[status as keyof AssetCounts] += count;
        }
        progress = recordItem(
          progress,
          itemKey(item),
          { status: outcome.status, at: now(), error: outcome.error, assets: outcome.assets },
          now(),
        );
        const detail =
          outcome.status === 'done'
            ? `ok — ${outcome.assets?.downloaded ?? 0} asset(s), ${outcome.assets?.failed ?? 0} failed`
            : `${outcome.status.toUpperCase()} — ${outcome.error ?? ''}`;
        console.log(`  ${label} ${detail}`);
      } catch (error) {
        if (isSessionExpired(error)) {
          aborted = true;
          console.error(`  ${label} ABORT — ${error.message}`);
          break;
        }
        throw error;
      }

      await saveContentProgress(args.app, progress);
      await saveAssetIndex(args.app, ledger.index());
      if (args.delayMs > 0) await sleep(args.delayMs);
    }
  } finally {
    await saveContentProgress(args.app, progress);
    await saveAssetIndex(args.app, ledger.index());
    await closeSession(session);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n  ${elapsed}s elapsed`);
  for (const [kind, counts] of Object.entries(tally)) {
    console.log(`  ${kind}: ${counts.done} fetched, ${counts.failed} failed, ${counts.notFound} not found`);
  }
  console.log(
    `  assets: ${assetTotals.downloaded} downloaded, ${assetTotals.failed} failed, ` +
      `${assetTotals.tooLarge} too large, ${assetTotals.skipped} skipped`,
  );
  const nonGet = session.guard.blocked.filter((b) => b.reason === 'non-get');
  console.log(
    `  browser requests: ${session.guard.allowed.length} allowed, ` +
      `${session.guard.blocked.length} blocked (${nonGet.length} non-GET)`,
  );
  if (aborted) console.log(`  run aborted — re-run:  npm run login -- --app ${args.app}`);
  console.log('');

  const anyFailed = Object.values(tally).some((t) => t.failed > 0);
  if (aborted || anyFailed) process.exitCode = 1;
}

await main();
```

- [ ] **Step 6: Add the script and the ignore rule**

In `package.json` `scripts`, after `"enrich"`:

```json
    "fetch-content": "tsx src/cli/fetchContent.ts",
```

Append to `.gitignore`, under the client-lists block:

```
# Content exports — email bodies, landing pages, forms: client content
export/
```

- [ ] **Step 7: Smoke-run without sources**

Run: `npm run fetch-content -- --app jordan --limit 1`
Expected: prints item counts by kind and a `NOT FETCHED — no source reads these yet` line listing every kind, then `nothing to do`, and makes **no** network request (no session is opened). If `artifacts/jordan` has no extracted campaigns, expect the "Run: npm run extract-all" message instead.

- [ ] **Step 8: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/cli/fetchContent.ts src/cli/fetchContentArgs.ts test/fetchContentArgs.test.ts package.json .gitignore
git commit -m "feat: fetch-content command, resumable, with a loud list of unread kinds"
```

---

### Task 10: The neutral campaign document

**Files:**
- Create: `src/export/mergeFields.ts`
- Create: `src/export/htmlText.ts`
- Create: `src/export/paths.ts`
- Create: `src/export/campaignDoc.ts`
- Test: `test/exportCampaignDoc.test.ts`

**Interfaces:**
- Consumes: `contentRefsOf` (Task 2), Task 2 types, `NormalizedCampaign`, `NormalizedNode`, `CampaignSummary`, `stripLongSuffix`, `decodeEntities`.
- Produces:
  - `findMergeFields(...texts): string[]`
  - `htmlToText(html): string`
  - `slugify(name)`, `campaignFolderName(funnelId, name)`, `SINGLE_FILE_KINDS`, `RECORD_FILE`, `contentRef(key)`, `attachmentFileName(name, used)`
  - `ContentPointer`, `TaskDoc`, `StepDoc`, `SequenceDoc`, `DecisionDoc`, `CampaignDoc`, `CampaignDocInput`, `draftNodesOf(campaign)`, `buildCampaignDoc(input)`

- [ ] **Step 1: Write the failing test**

```ts
// test/exportCampaignDoc.test.ts
import { describe, expect, it } from 'vitest';
import { buildCampaignDoc, draftNodesOf } from '../src/export/campaignDoc.js';
import { htmlToText } from '../src/export/htmlText.js';
import { findMergeFields } from '../src/export/mergeFields.js';
import {
  attachmentFileName,
  campaignFolderName,
  contentRef,
  slugify,
} from '../src/export/paths.js';
import { makeCampaign, makeNode, makeSequence } from './fixtures/graphFixtures.js';

describe('findMergeFields', () => {
  it('finds unique merge fields across texts, sorted', () => {
    expect(
      findMergeFields('Hi ~Contact.FirstName~, from ~Owner.Name~', null, 'Bye ~Contact.FirstName~'),
    ).toEqual(['~Contact.FirstName~', '~Owner.Name~']);
  });

  it('ignores stray tildes', () => {
    expect(findMergeFields('~ not a field ~ and ~br~')).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('keeps paragraphs and line breaks and drops styles', () => {
    expect(
      htmlToText('<style>p{}</style><p>Hi&nbsp;there,</p><p>Line one<br>Line two</p><ul><li>A</li></ul>'),
    ).toBe('Hi there,\nLine one\nLine two\n- A');
  });
});

describe('paths', () => {
  it('slugs names to at most 60 characters', () => {
    expect(slugify('Trip Completed — Follow-Up (2024)!')).toBe('trip-completed-follow-up-2024');
    expect(slugify('x'.repeat(80))).toHaveLength(60);
    expect(slugify(null)).toBe('untitled');
    expect(campaignFolderName('987', 'Welcome')).toBe('987-welcome');
  });

  it('points single-file kinds at a json file and the rest at a folder', () => {
    expect(contentRef({ kind: 'email', attribute: 'marketingEmailId', id: '2048' })).toBe('emails/2048');
    expect(contentRef({ kind: 'sms', attribute: 'marketingAutomatedSmsId', id: '5' })).toBe('sms/5.json');
    expect(contentRef({ kind: 'form', attribute: 'internalFormId', id: '3' })).toBe(
      'forms/internalFormId-3',
    );
  });

  it('makes attachment names safe and unique', () => {
    const used = new Set<string>();
    expect(attachmentFileName('Price List.pdf', used)).toBe('Price_List.pdf');
    expect(attachmentFileName('Price List.pdf', used)).toBe('2-Price_List.pdf');
    expect(attachmentFileName('../../etc/passwd', used)).toBe('etc_passwd');
    expect(attachmentFileName('', used)).toBe('attachment');
  });
});

describe('buildCampaignDoc', () => {
  const task = makeNode({
    cellId: '19',
    style: 'task',
    parent: '5',
    name: 'Not Satisfied Follow-Up',
    config: {
      initialized: '1',
      name: 'Not Satisfied Follow-Up',
      taskTitle: 'Call ~Contact.FirstName~',
      taskBody: 'Reach out to ~Contact.Email~',
      taskType: 'Call',
      taskPriority: '2',
      taskAssignToOwner: '1',
      taskAssignToBackup: '0L',
      taskDaysTillDue: '0',
      taskDueAt: '17:00',
    },
  });
  const emailStep = makeNode({
    cellId: '7',
    style: 'email',
    parent: '5',
    name: 'Welcome',
    config: { marketingEmailId: '2048L', ready: '1' },
    references: { tagIds: [], tagCategoryIds: [], marketingEmailId: '2048' },
  });
  const campaign = makeCampaign({
    funnelId: '584',
    name: 'Satisfaction Survey',
    published: true,
    sequences: [
      makeSequence({
        cellId: '5',
        name: 'Follow up',
        steps: [
          { ...emailStep, position: 0 },
          { ...task, position: 1 },
        ],
      }),
    ],
    notes: [makeNode({ cellId: '78', style: 'notes', config: { notes: 'Owner: <b>Sam</b>' } })],
  });

  const doc = buildCampaignDoc({
    funnelId: '584',
    normalized: campaign,
    summary: {
      funnelId: '584',
      name: 'Satisfaction Survey',
      categories: ['Clients'],
      activeContacts: 3,
      publishedDate: null,
      publishedBy: null,
      published: true,
    },
    publishNodes: [emailStep, makeNode({ cellId: '44', style: 'email', parent: '5', name: 'Old' })],
    resolve: (key) =>
      key.id === '2048'
        ? { kind: key.kind, id: key.id, ref: 'emails/2048' }
        : { kind: key.kind, id: key.id, status: 'notFound' },
  });

  it('carries identity and status', () => {
    expect(doc).toMatchObject({
      formatVersion: 1,
      funnelId: '584',
      name: 'Satisfaction Survey',
      categories: ['Clients'],
      status: { liveNow: true, everPublished: true, hasUnpublishedChanges: false },
    });
  });

  it('orders steps and points content steps into the campaign folder', () => {
    const steps = doc.sequences[0]?.steps ?? [];
    expect(steps.map((s) => [s.position, s.type, s.version])).toEqual([
      [0, 'email', 'both'],
      [1, 'task', 'draft'],
    ]);
    expect(steps[0]?.content).toEqual([{ kind: 'email', id: '2048', ref: 'emails/2048' }]);
    expect(steps[0]?.settings).toEqual({ marketingEmailId: '2048L' });
  });

  it('writes tasks out in full', () => {
    expect(doc.sequences[0]?.steps[1]?.task).toEqual({
      title: 'Call ~Contact.FirstName~',
      body: 'Reach out to ~Contact.Email~',
      type: 'Call',
      priority: '2',
      daysTillDue: '0',
      dueAt: '17:00',
      assignToOwner: true,
      assignToUserId: null,
      assignToBackup: null,
      notifyOwner: null,
      reminder: null,
    });
  });

  it('keeps published-only steps and canvas notes', () => {
    expect(doc.publishedOnly.map((s) => [s.cellId, s.version])).toEqual([['44', 'published']]);
    expect(doc.canvasNotes).toEqual([{ cellId: '78', text: 'Owner: Sam' }]);
  });

  it('lists the merge fields its own text uses', () => {
    expect(doc.mergeFields).toEqual(['~Contact.Email~', '~Contact.FirstName~']);
  });

  it('exposes every draft node for reference collection', () => {
    expect(draftNodesOf(campaign).map((n) => n.cellId)).toEqual(['5', '7', '19', '78']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/exportCampaignDoc.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/export/mergeFields.ts`**

```ts
/**
 * Keap merge fields: `~Contact.FirstName~`, `~Owner.Email~`, `~Date.Today~`.
 * The dot is required, which is what keeps `~br~` — Keap's line-break token —
 * and prose tildes out.
 */
export const MERGE_FIELD_PATTERN = /~[A-Za-z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+~/g;

export function findMergeFields(...texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(MERGE_FIELD_PATTERN)) found.add(match[0]);
  }
  return [...found].sort();
}
```

- [ ] **Step 4: Write `src/export/htmlText.ts`**

```ts
import { decodeEntities } from '../render/text.js';

/**
 * A readable plain-text rendering of an email or note body.
 *
 * Unlike `plainText` in src/render/text.ts, which collapses everything onto one
 * line for labels, this keeps paragraph and line structure — it becomes an
 * email's text part on the new platform.
 */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(stripped)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

- [ ] **Step 5: Write `src/export/paths.ts`**

```ts
import { type ContentItemKey, type ContentKind, KIND_FOLDERS, itemDirName } from '../content/types.js';

export function slugify(name: string | null): string {
  const slug = (name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug === '' ? 'untitled' : slug;
}

/** The funnel id prefix keeps two campaigns with the same name apart. */
export function campaignFolderName(funnelId: string, name: string | null): string {
  return `${funnelId}-${slugify(name)}`;
}

/** Kinds with no body files are a single JSON file rather than a folder. */
export const SINGLE_FILE_KINDS: ReadonlySet<ContentKind> = new Set(['sms', 'note', 'http']);

export const RECORD_FILE: Partial<Record<ContentKind, string>> = {
  email: 'email.json',
  landingPage: 'page.json',
  form: 'form.json',
};

/** Where an item lives, relative to its campaign folder. */
export function contentRef(key: ContentItemKey): string {
  const folder = KIND_FOLDERS[key.kind];
  const name = itemDirName(key);
  return SINGLE_FILE_KINDS.has(key.kind) ? `${folder}/${name}.json` : `${folder}/${name}`;
}

/** Attachment names come from Keap; they become file names on someone else's disk. */
export function attachmentFileName(name: string, used: Set<string>): string {
  const base =
    name
      .split(/[\\/]/)
      .filter((part) => part !== '' && part !== '.' && part !== '..')
      .join('_')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._]+/, '')
      .slice(0, 100) || 'attachment';
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) candidate = `${n}-${base}`;
  used.add(candidate);
  return candidate;
}
```

- [ ] **Step 6: Write `src/export/campaignDoc.ts`**

```ts
import { contentRefsOf } from '../content/collect.js';
import type { ContentItemKey, ContentKind, StepVersion } from '../content/types.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { NormalizedNode } from '../normalize/nodes.js';
import { stripLongSuffix } from '../parse/cells.js';
import type { CampaignSummary } from '../parse/campaignList.js';
import { htmlToText } from './htmlText.js';
import { findMergeFields } from './mergeFields.js';

export type ContentPointer =
  | { kind: ContentKind; id: string; ref: string }
  | { kind: ContentKind; id: string; status: 'failed' | 'notFound' | 'notFetched' };

export interface TaskDoc {
  title: string | null;
  body: string | null;
  type: string | null;
  priority: string | null;
  daysTillDue: string | null;
  dueAt: string | null;
  assignToOwner: boolean | null;
  assignToUserId: string | null;
  assignToBackup: string | null;
  notifyOwner: boolean | null;
  reminder: string | null;
}

export interface StepDoc {
  cellId: string;
  type: string;
  name: string | null;
  version: StepVersion;
  settings: Record<string, string>;
  content: ContentPointer[];
  task?: TaskDoc;
}

export interface SequenceDoc {
  cellId: string;
  name: string | null;
  version: StepVersion;
  orderVerified: boolean;
  steps: (StepDoc & { position: number })[];
}

export interface DecisionDoc {
  cellId: string;
  name: string | null;
  version: StepVersion;
  branches: { flowId: string; rules: unknown }[];
}

export interface CampaignDoc {
  formatVersion: 1;
  funnelId: string;
  name: string | null;
  categories: string[];
  status: { liveNow: boolean | null; everPublished: boolean; hasUnpublishedChanges: boolean };
  goals: StepDoc[];
  sequences: SequenceDoc[];
  decisions: DecisionDoc[];
  /** Steps present only in the published version — rare, and easy to miss. */
  publishedOnly: StepDoc[];
  canvasNotes: { cellId: string; text: string }[];
  mergeFields: string[];
}

export interface CampaignDocInput {
  funnelId: string;
  normalized: NormalizedCampaign;
  summary: CampaignSummary | null;
  publishNodes: NormalizedNode[];
  resolve: (key: ContentItemKey) => ContentPointer;
}

/** Status and bookkeeping attributes: nothing a migrator rebuilds. */
const HIDDEN_CONFIG = new Set([
  'initialized', 'deepCopy', 'global', 'name', 'ready', 'published', 'broken',
  'appName', 'buildNumber', 'funnelId',
]);

const STRUCTURAL = new Set(['flow', 'edge', 'start', '(none)']);
const NOTE_STYLES = new Set(['notes', 'note']);

/** Every node of the draft, in document-ish order: goals, sequences and their steps, decisions, notes. */
export function draftNodesOf(campaign: NormalizedCampaign): NormalizedNode[] {
  return [
    ...campaign.goals,
    ...campaign.sequences.flatMap((sequence) => [sequence, ...sequence.steps]),
    ...campaign.decisions,
    ...campaign.notes,
  ];
}

function settingsOf(node: NormalizedNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.config)) {
    if (HIDDEN_CONFIG.has(key) || (node.style === 'task' && key.startsWith('task'))) continue;
    out[key] = value;
  }
  return out;
}

function taskOf(node: NormalizedNode): TaskDoc | undefined {
  if (node.style !== 'task') return undefined;
  const text = (key: string): string | null => {
    const value = node.config[key];
    return value === undefined || value === '' ? null : value;
  };
  const flag = (key: string): boolean | null =>
    node.config[key] === '1' ? true : node.config[key] === '0' ? false : null;
  const user = (value: string | null | undefined): string | null => {
    const id = value ? stripLongSuffix(value) : null;
    return id === null || id === '0' ? null : id;
  };
  const userIds = node.references.userId;
  return {
    title: text('taskTitle'),
    body: text('taskBody'),
    type: text('taskType'),
    priority: text('taskPriority'),
    daysTillDue: text('taskDaysTillDue'),
    dueAt: text('taskDueAt'),
    assignToOwner: flag('taskAssignToOwner'),
    assignToUserId: user(typeof userIds === 'string' ? userIds : userIds?.[0]),
    assignToBackup: user(text('taskAssignToBackup')),
    notifyOwner: flag('taskNotifyOwner'),
    reminder: text('taskReminder') === '0' ? null : text('taskReminder'),
  };
}

function stepDoc(
  node: NormalizedNode,
  version: StepVersion,
  resolve: CampaignDocInput['resolve'],
): StepDoc {
  const doc: StepDoc = {
    cellId: node.cellId,
    type: node.style,
    name: node.name,
    version,
    settings: settingsOf(node),
    content: contentRefsOf([node]).map(({ key }) => resolve(key)),
  };
  const task = taskOf(node);
  if (task) doc.task = task;
  return doc;
}

export function buildCampaignDoc(input: CampaignDocInput): CampaignDoc {
  const { normalized, publishNodes, resolve } = input;
  const publishedIds = new Set(publishNodes.map((n) => n.cellId));
  const versionOf = (cellId: string): StepVersion => (publishedIds.has(cellId) ? 'both' : 'draft');
  const draftIds = new Set(draftNodesOf(normalized).map((n) => n.cellId));

  const sequences: SequenceDoc[] = normalized.sequences.map((sequence) => ({
    cellId: sequence.cellId,
    name: sequence.name,
    version: versionOf(sequence.cellId),
    orderVerified: sequence.orderVerified,
    steps: sequence.steps
      .filter((step) => step.style !== 'start')
      .map((step) => ({ ...stepDoc(step, versionOf(step.cellId), resolve), position: step.position })),
  }));

  const decisions: DecisionDoc[] = normalized.decisions.map((decision) => ({
    cellId: decision.cellId,
    name: decision.name,
    version: versionOf(decision.cellId),
    branches: decision.branches.map((branch) => ({ flowId: branch.flowId, rules: branch.rules })),
  }));

  const publishedOnly = publishNodes
    .filter((n) => !draftIds.has(n.cellId) && !STRUCTURAL.has(n.style) && !NOTE_STYLES.has(n.style))
    .map((n) => stepDoc(n, 'published', resolve));

  const canvasNotes = normalized.notes.map((note) => ({
    cellId: note.cellId,
    text: htmlToText(note.config.notes ?? note.name ?? ''),
  }));

  const tasks = sequences.flatMap((s) => s.steps).flatMap((s) => (s.task ? [s.task] : []));
  const mergeFields = findMergeFields(
    ...tasks.flatMap((t) => [t.title, t.body]),
    ...canvasNotes.map((n) => n.text),
  );

  return {
    formatVersion: 1,
    funnelId: input.funnelId,
    name: normalized.name ?? input.summary?.name ?? null,
    categories: input.summary?.categories ?? [],
    status: {
      liveNow: input.summary?.published ?? null,
      everPublished: normalized.published,
      hasUnpublishedChanges: normalized.hasUnpublishedChanges,
    },
    goals: normalized.goals.map((goal) => stepDoc(goal, versionOf(goal.cellId), resolve)),
    sequences,
    decisions,
    publishedOnly,
    canvasNotes,
    mergeFields,
  };
}
```

`stripLongSuffix(value: string | undefined | null): string | null` (in `src/parse/cells.ts`) turns `"0L"` into `"0"`, which `user()` maps to null — Keap writes `0L` for "nobody".

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run test/exportCampaignDoc.test.ts`
Expected: PASS. The `draftNodesOf` expectation includes the sequence node `5` itself, then its steps.

- [ ] **Step 8: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/export/mergeFields.ts src/export/htmlText.ts src/export/paths.ts src/export/campaignDoc.ts test/exportCampaignDoc.test.ts
git commit -m "feat: neutral campaign document for the migration export"
```

---

### Task 11: Export planning, writing and the `export` command

**Files:**
- Create: `src/export/plan.ts`
- Create: `src/export/write.ts`
- Create: `src/cli/export.ts`
- Modify: `package.json` (add script)
- Modify: `README.md` (new step 8)
- Test: `test/exportPlan.test.ts`

**Interfaces:**
- Consumes: Tasks 2–10.
- Produces: `PlannedFile`, `ExportCampaignInput`, `ExportInput`, `Manifest`, `ExportPlan { files; manifest }`, `planExport(input)`, `writeExport(plan, outDir)`, the `export` npm script.

- [ ] **Step 1: Write the failing test**

```ts
// test/exportPlan.test.ts
import { describe, expect, it } from 'vitest';
import type { AssetRecord } from '../src/content/assets/download.js';
import type { ItemStatus } from '../src/content/progress.js';
import type { StoredItem } from '../src/content/store.js';
import { itemKey } from '../src/content/types.js';
import { type ExportInput, type PlannedFile, planExport } from '../src/export/plan.js';
import { makeCampaign, makeNode, makeSequence } from './fixtures/graphFixtures.js';

const emailNode = (cellId: string, id: string) =>
  makeNode({
    cellId,
    style: 'email',
    parent: '5',
    name: `Email ${id}`,
    references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
  });
const httpNode = makeNode({
  cellId: '9',
  style: 'http',
  parent: '5',
  references: { tagIds: [], tagCategoryIds: [], httpRequestConfigId: '77' },
});

const campaign = (funnelId: string, name: string, nodes: ReturnType<typeof makeNode>[]) => ({
  funnelId,
  summary: null,
  publishNodes: [],
  normalized: makeCampaign({
    funnelId,
    name,
    sequences: [
      makeSequence({ cellId: '5', steps: nodes.map((n, position) => ({ ...n, position })) }),
    ],
  }),
});

const EMAIL_KEY = { kind: 'email' as const, attribute: 'marketingEmailId', id: '2048' };
const HTTP_KEY = { kind: 'http' as const, attribute: 'httpRequestConfigId', id: '77' };
const LOGO = 'https://cdn.example.com/logo.png';
const PDF = 'https://se232.infusionsoft.com/Download?Id=9';

const items = new Map<string, StoredItem>([
  [
    itemKey(EMAIL_KEY),
    {
      key: EMAIL_KEY,
      fetchedAt: 't',
      dir: '/raw/email/2048',
      files: ['body.html'],
      assetUrls: [LOGO, PDF],
      record: {
        kind: 'email',
        name: 'Welcome',
        from: 'team@example.com',
        replyTo: null,
        to: '~Contact.Email~',
        cc: null,
        bcc: null,
        subject: 'Hi ~Contact.FirstName~',
        previewText: null,
        attachments: [{ name: 'Price List.pdf', url: PDF }],
      },
    },
  ],
  [
    itemKey(HTTP_KEY),
    {
      key: HTTP_KEY,
      fetchedAt: 't',
      dir: '/raw/http/77',
      files: [],
      assetUrls: [],
      record: {
        kind: 'http',
        name: 'Hook',
        method: 'POST',
        url: 'https://hooks.example.com/x?token=abc',
        headers: [],
        fields: [],
        body: null,
      },
    },
  ],
]);

const assets: Record<string, AssetRecord> = {
  [LOGO]: { url: LOGO, status: 'downloaded', file: `${'a'.repeat(64)}.png`, size: 3 },
  [PDF]: { url: PDF, status: 'downloaded', file: `${'b'.repeat(64)}.pdf`, size: 9 },
};

function input(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    app: 'se232',
    exportedAt: '2026-09-21T00:00:00.000Z',
    includeSecrets: false,
    campaigns: [
      campaign('1', 'Welcome Series', [emailNode('7', '2048'), httpNode]),
      campaign('2', 'Re-engagement', [emailNode('3', '2048'), emailNode('4', '999')]),
    ],
    items,
    statuses: new Map<string, ItemStatus>([['email:marketingEmailId:999', 'notFound']]),
    assets,
    assetSource: (file) => `/assets/${file}`,
    readText: (path) => (path === '/raw/email/2048/files/body.html' ? '<p>Hi ~Contact.FirstName~</p>' : ''),
    ...overrides,
  };
}

const byPath = (files: PlannedFile[]) => new Map(files.map((f) => [f.path, f]));
const json = (file: PlannedFile | undefined) =>
  JSON.parse(file && 'data' in file ? file.data.toString() : 'null');

describe('planExport', () => {
  const plan = planExport(input());
  const files = byPath(plan.files);

  it('gives every campaign its own folder with a campaign.json', () => {
    expect(files.has('campaigns/1-welcome-series/campaign.json')).toBe(true);
    expect(files.has('campaigns/2-re-engagement/campaign.json')).toBe(true);
  });

  it('copies shared content into each campaign and says who else uses it', () => {
    const first = json(files.get('campaigns/1-welcome-series/emails/2048/email.json'));
    const second = json(files.get('campaigns/2-re-engagement/emails/2048/email.json'));
    expect(first.sharedWith).toEqual([{ funnelId: '2', name: 'Re-engagement' }]);
    expect(second.sharedWith).toEqual([{ funnelId: '1', name: 'Welcome Series' }]);
    expect(first).toMatchObject({ id: '2048', idAttribute: 'marketingEmailId', subject: 'Hi ~Contact.FirstName~' });
    expect(first.mergeFields).toEqual(['~Contact.Email~', '~Contact.FirstName~']);
  });

  it('copies body files and derives body.txt when Keap gave none', () => {
    expect(files.get('campaigns/1-welcome-series/emails/2048/body.html')).toEqual({
      path: 'campaigns/1-welcome-series/emails/2048/body.html',
      copyFrom: '/raw/email/2048/files/body.html',
    });
    const text = files.get('campaigns/1-welcome-series/emails/2048/body.txt');
    expect(text && 'data' in text ? text.data : null).toBe('Hi ~Contact.FirstName~');
    expect(json(files.get('campaigns/1-welcome-series/emails/2048/email.json')).textDerivedFromHtml).toBe(true);
  });

  it('copies attachments under a safe name and assets per campaign', () => {
    expect(files.get('campaigns/1-welcome-series/emails/2048/attachments/Price_List.pdf')).toMatchObject({
      copyFrom: `/assets/${'b'.repeat(64)}.pdf`,
    });
    expect(files.has(`campaigns/2-re-engagement/assets/${'a'.repeat(64)}.png`)).toBe(true);
    const assetsJson = json(files.get('campaigns/1-welcome-series/assets/assets.json'));
    expect(assetsJson[0]).toMatchObject({ url: LOGO, status: 'downloaded', file: `assets/${'a'.repeat(64)}.png` });
  });

  it('redacts HTTP secrets by default and lists them', () => {
    const http = json(files.get('campaigns/1-welcome-series/http/77.json'));
    expect(http.url).toBe('https://hooks.example.com/x?token=«redacted»');
    expect(http.redacted).toEqual([{ location: 'query', name: 'token' }]);
    expect(plan.manifest.secretsIncluded).toBe(false);
  });

  it('keeps secrets only when asked, and says so', () => {
    const withSecrets = planExport(input({ includeSecrets: true }));
    const http = json(byPath(withSecrets.files).get('campaigns/1-welcome-series/http/77.json'));
    expect(http.url).toBe('https://hooks.example.com/x?token=abc');
    expect(http.secretsIncluded).toBe(true);
    expect(withSecrets.manifest.secretsIncluded).toBe(true);
  });

  it('shows missing content as a gap rather than dropping the step', () => {
    const doc = json(files.get('campaigns/2-re-engagement/campaign.json'));
    expect(doc.sequences[0].steps.map((s: { content: unknown[] }) => s.content[0])).toEqual([
      { kind: 'email', id: '2048', ref: 'emails/2048' },
      { kind: 'email', id: '999', status: 'notFound' },
    ]);
    expect(plan.manifest.content.email).toEqual({ exported: 2, failed: 0, notFound: 1, notFetched: 0 });
  });

  it('writes the manifest and an account-wide merge-field list', () => {
    expect(json(files.get('manifest.json'))).toMatchObject({
      formatVersion: 1,
      app: 'se232',
      campaignCount: 2,
      assets: { downloaded: 2, failed: 0, tooLarge: 0, skipped: 0 },
    });
    expect(json(files.get('merge-fields.json'))).toEqual([
      { field: '~Contact.Email~', campaignCount: 2, campaigns: ['1', '2'] },
      { field: '~Contact.FirstName~', campaignCount: 2, campaigns: ['1', '2'] },
    ]);
  });

  it('never plans a path outside the export', () => {
    for (const file of plan.files) expect(file.path).not.toMatch(/(^\/|\.\.)/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/exportPlan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/export/plan.ts`**

```ts
import { join } from 'node:path';
import type { AssetRecord, AssetStatus } from '../content/assets/download.js';
import { campaignRefs } from '../content/collect.js';
import type { ItemStatus } from '../content/progress.js';
import { redactHttp } from '../content/redact.js';
import type { StoredItem } from '../content/store.js';
import { CONTENT_KINDS, type ContentItemKey, type ContentKind, itemKey } from '../content/types.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { NormalizedNode } from '../normalize/nodes.js';
import type { CampaignSummary } from '../parse/campaignList.js';
import { type ContentPointer, buildCampaignDoc, draftNodesOf } from './campaignDoc.js';
import { htmlToText } from './htmlText.js';
import { findMergeFields } from './mergeFields.js';
import {
  RECORD_FILE,
  SINGLE_FILE_KINDS,
  attachmentFileName,
  campaignFolderName,
  contentRef,
} from './paths.js';

export type PlannedFile = { path: string; data: string | Buffer } | { path: string; copyFrom: string };

export interface ExportCampaignInput {
  funnelId: string;
  summary: CampaignSummary | null;
  normalized: NormalizedCampaign;
  publishNodes: NormalizedNode[];
}

export interface ExportInput {
  app: string;
  exportedAt: string;
  includeSecrets: boolean;
  campaigns: ExportCampaignInput[];
  /** Stored items, keyed by itemKey. */
  items: Map<string, StoredItem>;
  /** Progress statuses, keyed by itemKey — tells failed from notFound from never tried. */
  statuses: Map<string, ItemStatus>;
  assets: Record<string, AssetRecord>;
  /** Path on disk of a stored asset file. */
  assetSource: (file: string) => string;
  readText: (path: string) => string;
}

type KindCounts = { exported: number; failed: number; notFound: number; notFetched: number };

export interface Manifest {
  formatVersion: 1;
  app: string;
  exportedAt: string;
  secretsIncluded: boolean;
  campaignCount: number;
  content: Record<ContentKind, KindCounts>;
  assets: Record<AssetStatus, number>;
  campaigns: { funnelId: string; name: string | null; folder: string; missingContent: number }[];
}

export interface ExportPlan {
  files: PlannedFile[];
  manifest: Manifest;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function uniqueKeys(keys: ContentItemKey[]): ContentItemKey[] {
  const seen = new Map<string, ContentItemKey>();
  for (const key of keys) if (!seen.has(itemKey(key))) seen.set(itemKey(key), key);
  return [...seen.values()];
}

/**
 * Everything the export will write, computed without touching the disk except
 * through `readText`. The writer only executes this list.
 */
export function planExport(input: ExportInput): ExportPlan {
  const files: PlannedFile[] = [];
  const content = Object.fromEntries(
    CONTENT_KINDS.map((kind) => [kind, { exported: 0, failed: 0, notFound: 0, notFetched: 0 }]),
  ) as Record<ContentKind, KindCounts>;
  const accountAssets = new Map<string, AssetStatus>();
  const mergeIndex = new Map<string, Set<string>>();
  const manifestCampaigns: Manifest['campaigns'] = [];

  const perCampaign = input.campaigns.map((campaign) => ({
    campaign,
    name: campaign.normalized.name ?? campaign.summary?.name ?? null,
    refs: campaignRefs(campaign.funnelId, draftNodesOf(campaign.normalized), campaign.publishNodes),
  }));

  // Account-wide usage, for sharedWith.
  const usage = new Map<string, Map<string, string | null>>();
  for (const { campaign, name, refs } of perCampaign) {
    for (const { key } of refs) {
      const users = usage.get(itemKey(key)) ?? new Map<string, string | null>();
      users.set(campaign.funnelId, name);
      usage.set(itemKey(key), users);
    }
  }

  for (const { campaign, name, refs } of perCampaign) {
    const folder = `campaigns/${campaignFolderName(campaign.funnelId, name)}`;

    const resolve = (key: ContentItemKey): ContentPointer => {
      const k = itemKey(key);
      if (input.items.has(k)) return { kind: key.kind, id: key.id, ref: contentRef(key) };
      const status = input.statuses.get(k);
      return {
        kind: key.kind,
        id: key.id,
        status: status === 'failed' || status === 'notFound' ? status : 'notFetched',
      };
    };

    const doc = buildCampaignDoc({
      funnelId: campaign.funnelId,
      normalized: campaign.normalized,
      summary: campaign.summary,
      publishNodes: campaign.publishNodes,
      resolve,
    });

    const campaignMerge = new Set(doc.mergeFields);
    const campaignAssets = new Map<string, Set<string>>();
    let missingContent = 0;

    for (const key of uniqueKeys(refs.map((r) => r.key))) {
      const k = itemKey(key);
      const stored = input.items.get(k);
      if (!stored) {
        const pointer = resolve(key);
        if ('status' in pointer) content[key.kind][pointer.status]++;
        missingContent++;
        continue;
      }
      content[key.kind].exported++;

      const ref = contentRef(key);
      const itemPath = `${folder}/${ref}`;
      const filePath = (name: string) => join(stored.dir, 'files', name);
      const texts = stored.files
        .filter((name) => /\.(html|txt)$/.test(name))
        .map((name) => input.readText(filePath(name)));
      const mergeFields = findMergeFields(JSON.stringify(stored.record), ...texts);
      for (const field of mergeFields) campaignMerge.add(field);

      for (const url of stored.assetUrls) {
        const users = campaignAssets.get(url) ?? new Set<string>();
        users.add(ref);
        campaignAssets.set(url, users);
      }

      const sharedWith = [...(usage.get(k) ?? new Map<string, string | null>())]
        .filter(([funnelId]) => funnelId !== campaign.funnelId)
        .map(([funnelId, otherName]) => ({ funnelId, name: otherName }));

      let record: object = stored.record;
      let secrets: object = {};
      if (stored.record.kind === 'http') {
        if (input.includeSecrets) {
          secrets = { secretsIncluded: true };
        } else {
          const redaction = redactHttp(stored.record);
          record = redaction.content;
          secrets = { redacted: redaction.redacted };
        }
      }

      const assetList = stored.assetUrls.map((url) => {
        const asset = input.assets[url];
        return {
          url,
          status: asset?.status ?? 'failed',
          file: asset?.status === 'downloaded' && asset.file ? `assets/${asset.file}` : null,
        };
      });

      const derivedText =
        stored.record.kind === 'email' &&
        stored.files.includes('body.html') &&
        !stored.files.includes('body.txt');

      const body = {
        id: key.id,
        idAttribute: key.attribute,
        ...record,
        ...(derivedText ? { textDerivedFromHtml: true } : {}),
        ...secrets,
        mergeFields,
        usedBy: refs.filter((r) => itemKey(r.key) === k).map((r) => r.use),
        sharedWith,
        assets: assetList,
      };

      if (SINGLE_FILE_KINDS.has(key.kind)) {
        files.push({ path: itemPath, data: json(body) });
        continue;
      }

      files.push({ path: `${itemPath}/${RECORD_FILE[key.kind]}`, data: json(body) });
      for (const name of stored.files) {
        files.push({ path: `${itemPath}/${name}`, copyFrom: filePath(name) });
      }
      if (derivedText) {
        files.push({
          path: `${itemPath}/body.txt`,
          data: htmlToText(input.readText(filePath('body.html'))),
        });
      }
      if (stored.record.kind === 'email') {
        const used = new Set<string>();
        for (const attachment of stored.record.attachments) {
          const asset = input.assets[attachment.url];
          if (asset?.status !== 'downloaded' || !asset.file) continue;
          files.push({
            path: `${itemPath}/attachments/${attachmentFileName(attachment.name, used)}`,
            copyFrom: input.assetSource(asset.file),
          });
        }
      }
    }

    const assetEntries = [...campaignAssets].map(([url, users]) => {
      const asset: AssetRecord = input.assets[url] ?? {
        url,
        status: 'failed',
        reason: 'not in the asset index',
      };
      accountAssets.set(url, asset.status);
      const downloaded = asset.status === 'downloaded' && asset.file !== undefined;
      if (downloaded && asset.file) {
        files.push({ path: `${folder}/assets/${asset.file}`, copyFrom: input.assetSource(asset.file) });
      }
      return {
        ...asset,
        file: downloaded ? `assets/${asset.file}` : null,
        usedBy: [...users].sort(),
      };
    });
    files.push({ path: `${folder}/assets/assets.json`, data: json(assetEntries) });

    doc.mergeFields = [...campaignMerge].sort();
    for (const field of doc.mergeFields) {
      const users = mergeIndex.get(field) ?? new Set<string>();
      users.add(campaign.funnelId);
      mergeIndex.set(field, users);
    }
    files.push({ path: `${folder}/campaign.json`, data: json(doc) });
    manifestCampaigns.push({ funnelId: campaign.funnelId, name, folder, missingContent });
  }

  const assetCounts: Record<AssetStatus, number> = { downloaded: 0, failed: 0, tooLarge: 0, skipped: 0 };
  for (const status of accountAssets.values()) assetCounts[status]++;

  const manifest: Manifest = {
    formatVersion: 1,
    app: input.app,
    exportedAt: input.exportedAt,
    secretsIncluded: input.includeSecrets,
    campaignCount: input.campaigns.length,
    content,
    assets: assetCounts,
    campaigns: manifestCampaigns,
  };
  files.push({ path: 'manifest.json', data: json(manifest) });
  files.push({
    path: 'merge-fields.json',
    data: json(
      [...mergeIndex]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([field, users]) => ({ field, campaignCount: users.size, campaigns: [...users].sort() })),
    ),
  });

  return { files, manifest };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/exportPlan.test.ts`
Expected: PASS. If `manifest.content.email` reports `exported: 2` differently, recall shared content counts once **per campaign copy** — two campaigns exporting 2048 is 2. That is the intended meaning (copies written), and the test encodes it.

- [ ] **Step 5: Write `src/export/write.ts`**

```ts
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import type { ExportPlan } from './plan.js';

/** A planned path is relative and stays inside the export. */
function assertInside(path: string): void {
  const normalized = normalize(path);
  if (normalized.startsWith('..') || normalized.startsWith(sep) || normalized.includes(`..${sep}`)) {
    throw new Error(`Refusing to write outside the export: ${path}`);
  }
}

/**
 * Replaces the export directory wholesale, so a campaign or asset that has
 * gone away does not linger from a previous run.
 */
export async function writeExport(plan: ExportPlan, outDir: string): Promise<void> {
  for (const file of plan.files) assertInside(file.path);
  await rm(outDir, { recursive: true, force: true });
  for (const file of plan.files) {
    const target = join(outDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    if ('copyFrom' in file) await copyFile(file.copyFrom, target);
    else await writeFile(target, file.data);
  }
}
```

- [ ] **Step 6: Write `src/cli/export.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName, normalizeFunnelId } from '../app.js';
import { assetFilePathFor, loadAssetIndex } from '../content/assets/assetStore.js';
import { campaignRefs, loadCampaignNodes } from '../content/collect.js';
import type { ItemStatus } from '../content/progress.js';
import { loadContentProgress } from '../content/progress.js';
import { type StoredItem, readStoredItem } from '../content/store.js';
import { itemKey } from '../content/types.js';
import { draftNodesOf } from '../export/campaignDoc.js';
import { type ExportCampaignInput, planExport } from '../export/plan.js';
import { writeExport } from '../export/write.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { CampaignSummary } from '../parse/campaignList.js';

interface Args {
  app: string;
  funnelId: string | null;
  includeSecrets: boolean;
}

function parseArgs(argv: string[]): Args {
  const usage = 'Usage: npm run export -- --app <appName> [--funnel <funnelId>] [--include-secrets]';
  const appIndex = argv.indexOf('--app');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  if (!rawApp) throw new Error(usage);
  const funnelIndex = argv.indexOf('--funnel');
  const rawFunnel = funnelIndex >= 0 ? argv[funnelIndex + 1] : undefined;
  return {
    app: normalizeAppName(rawApp),
    funnelId: rawFunnel === undefined ? null : normalizeFunnelId(rawFunnel),
    includeSecrets: argv.includes('--include-secrets'),
  };
}

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const normalizedDir = join('artifacts', args.app, 'normalized');
  if (!existsSync(normalizedDir)) {
    fail(`No normalised campaigns at ${normalizedDir}. Run:  npm run normalize -- --app ${args.app}`);
    return;
  }

  const summaries = new Map<string, CampaignSummary>();
  try {
    const list = JSON.parse(
      await readFile(join('artifacts', args.app, 'campaigns.json'), 'utf8'),
    ) as { campaigns?: CampaignSummary[] };
    for (const summary of list.campaigns ?? []) summaries.set(summary.funnelId, summary);
  } catch {
    console.log('  warning: no campaigns.json — live status and categories will be empty');
  }

  const funnelIds =
    args.funnelId !== null
      ? [args.funnelId]
      : (await readdir(normalizedDir))
          .map((f) => /^(\d+)\.json$/.exec(f)?.[1])
          .filter((id): id is string => id !== undefined)
          .sort((a, b) => Number(a) - Number(b));

  const campaigns: ExportCampaignInput[] = [];
  const items = new Map<string, StoredItem>();
  for (const funnelId of funnelIds) {
    const path = join(normalizedDir, `${funnelId}.json`);
    if (!existsSync(path)) {
      console.log(`  warning: ${funnelId} is not normalised — skipped`);
      continue;
    }
    const normalized = JSON.parse(await readFile(path, 'utf8')) as NormalizedCampaign;
    const publishNodes = (await loadCampaignNodes(args.app, funnelId))?.published ?? [];
    campaigns.push({ funnelId, summary: summaries.get(funnelId) ?? null, normalized, publishNodes });

    for (const { key } of campaignRefs(funnelId, draftNodesOf(normalized), publishNodes)) {
      const k = itemKey(key);
      if (items.has(k)) continue;
      const stored = await readStoredItem(args.app, key);
      if (stored) items.set(k, stored);
    }
  }

  if (campaigns.length === 0) {
    fail('No campaigns to export.');
    return;
  }

  const progress = await loadContentProgress(args.app);
  const statuses = new Map<string, ItemStatus>(
    Object.entries(progress?.entries ?? {}).map(([key, entry]) => [key, entry.status]),
  );
  const assetIndex = await loadAssetIndex(args.app);

  const plan = planExport({
    app: args.app,
    exportedAt: new Date().toISOString(),
    includeSecrets: args.includeSecrets,
    campaigns,
    items,
    statuses,
    assets: assetIndex.assets,
    assetSource: (file) => assetFilePathFor(args.app, file),
    readText: (path) => readFileSync(path, 'utf8'),
  });

  // --funnel exports into its own folder, so it never replaces a full export.
  const outDir =
    args.funnelId !== null ? join('export', args.app, `_funnel-${args.funnelId}`) : join('export', args.app);
  await writeExport(plan, outDir);

  const m = plan.manifest;
  console.log(`\n[${args.app}] exported ${m.campaignCount} campaigns to ${outDir}`);
  for (const [kind, c] of Object.entries(m.content)) {
    if (c.exported + c.failed + c.notFound + c.notFetched === 0) continue;
    console.log(
      `  ${kind}: ${c.exported} exported, ${c.failed} failed, ${c.notFound} not found, ${c.notFetched} not fetched`,
    );
  }
  console.log(
    `  assets: ${m.assets.downloaded} downloaded, ${m.assets.failed} failed, ` +
      `${m.assets.tooLarge} too large, ${m.assets.skipped} skipped`,
  );
  if (m.secretsIncluded) {
    console.log('\n  WARNING: --include-secrets was set. HTTP steps contain live credentials.');
    console.log('  Treat this export as a secret. manifest.json records secretsIncluded: true.');
  }
  console.log('');
}

await main();
```

- [ ] **Step 7: Add the script and document the step**

In `package.json` `scripts`, after `"fetch-content"`:

```json
    "export": "tsx src/cli/export.ts",
```

In `README.md`: add `- [Step 8 — Export campaign content (migration)](#step-8--export-campaign-content-migration)` to Contents after Step 7, and insert this section after the Step 7 section:

````markdown
## Step 8 — Export campaign content (migration)

```bash
npm run fetch-content -- --app se232
```

```bash
npm run export -- --app se232
```

`fetch-content` reads the content every campaign step points at — emails, landing pages, forms,
SMS, note templates, HTTP steps — and every image, stylesheet, font and attachment that content uses.
It is resumable like `extract-all`, fetches shared content once, and needs a login session (plus
`KEAP_API_KEY` if any content kind is read through the REST API — it says which before starting).

`export` needs no network. It writes `export/se232/`, one self-contained folder per campaign:

```
export/se232/
  manifest.json          counts, and any content that could not be fetched
  merge-fields.json      every ~Contact.X~ style merge field, to map onto the new platform
  campaigns/<id>-<name>/
    campaign.json        goals, sequences, steps, decisions, tasks and canvas notes
    emails/<id>/         email.json (to, cc, bcc, subject…), body.html, body.txt, attachments/
    landing-pages/<id>/  page.json, page.html
    forms/<id>/          form.json, form.html
    sms/ notes/ http/    one JSON file each
    assets/              every image and file the campaign's content uses, plus assets.json
```

Content used by several campaigns is copied into each and lists the others under `sharedWith`.
HTML is never modified; `assets.json` maps each original URL to its local file.

**HTTP step credentials are redacted** and listed under `redacted` in each file.
`--include-secrets` keeps them and marks the manifest; treat such an export as a secret.

| Flag | Command | Meaning |
|---|---|---|
| `--kinds email,sms` | fetch-content | Fetch only these kinds. |
| `--funnel <id>` | both | One campaign. `export` writes it to `export/<app>/_funnel-<id>/`. |
| `--force`, `--limit`, `--delay`, `--headed` | fetch-content | As for `extract-all`. |
| `--include-secrets` | export | Keep HTTP credentials. |

`export/` is gitignored. It holds client content — do not commit it.
````

- [ ] **Step 8: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/export/plan.ts src/export/write.ts src/cli/export.ts test/exportPlan.test.ts package.json README.md
git commit -m "feat: export command writing a neutral per-campaign migration package"
```

- [ ] **Step 9: Smoke-run the export**

Run: `npm run export -- --app jordan`
Expected: exports every normalised campaign, with every content kind counted as `not fetched` (no sources yet) and `campaign.json` in each folder showing tasks and canvas notes in full. Open one `campaign.json` and one `manifest.json` to confirm they read sensibly.

---

## After this plan

Execute the content-sources plan written in Task 1 Step 9. Its final task is the spec's live check: `npm run fetch-content -- --app <app> --limit 5`, `npm run export -- --app <app>`, and a hand spot-check of one email, one landing page, one SMS and one HTTP step against the Keap UI.
