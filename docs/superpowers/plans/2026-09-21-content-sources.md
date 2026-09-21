# Content Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `fetch-content` actually read content, for the five kinds the discovery spike found a read-only source for: emails, web forms, SMS, Apply Note templates and HTTP Requests.

**Architecture:** One module per kind under `src/content/sources/`, each implementing the existing `ContentSource` contract (`src/content/types.ts`) and registered in `SOURCES`. REST-backed kinds (email, web form) use the existing allowlisted `ApiClient`. App-backed kinds (SMS, note, HTTP Request) go through one new helper, `appGet`, which adds a content-endpoint allowlist on top of `safeGet`, refuses redirects, and turns a sign-in redirect into `SessionExpiredError`. Each source maps Keap's response to the neutral record, keeps the raw response as evidence, and validates content rather than status.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), cheerio, vitest, tsx. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-content-export-design.md` — §6 (phase 0), §7.2 (sources), §7.3 (validation). Evidence for every endpoint: `docs/spike-findings.md` §18.

## Global Constraints

- **Read-only.** REST calls only through `ctx.api` (`src/api/client.ts`, which enforces `src/api/guard.ts`). App calls only through `appGet` (Task 1), which enforces its own allowlist and then `safeGet`. No other network access.
- **No redirects are followed by `appGet`.** A redirect to sign-in is `SessionExpiredError`; any other redirect is an error.
- **Status is not evidence.** Every source validates the body it got; an empty shell or a sign-in page must never be stored as content.
- **A 404 is `ContentNotFoundError`** — a deleted template is a finding, not a failure.
- **The API key is never logged, echoed, written or put in an error message.**
- **No test touches the network.** Use the fixtures in `test/fixtures/content/` (scrubbed; see its README) and fake `ApiClient` / `BrowserContext` objects.
- Import specifiers carry `.js`. `npm run typecheck` and `npm test` pass at the end of every task; the existing 682 tests pass unchanged.
- Never stage `.superpowers/` or `export/`.

---

## Context an implementer needs

- **The contract** (already on the branch, `src/content/types.ts`):
  ```ts
  interface ContentSource {
    kind: ContentKind;
    attributes: readonly string[];      // id spaces served — subset of KIND_ATTRIBUTES[kind]
    needsApiKey: boolean;
    needsBrowser: boolean;
    fetch(key: ContentItemKey, ctx: FetchContext): Promise<FetchedContent>;
    validate(content: FetchedContent): string | null;   // null = genuine
  }
  interface FetchContext { app: string; baseUrl: string; browser: BrowserContext | null; api: ApiClient | null }
  interface FetchedContent { record: ContentRecord; files: ContentFile[]; evidence: ContentFile[]; assetUrls: string[] }
  ```
  `fetchItem` (`src/content/run.ts`) calls `fetch`, rejects a record of the wrong kind, calls `validate`, retries once, and stores `files` (exported) and `evidence` (kept, never exported). HTML files named `*.html` are scanned for assets automatically — do not add their images to `assetUrls` yourself.
- **File names** in `files`/`evidence` must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/` (`assertSafeFileName`).
- **`ApiClient`** (`src/api/client.ts`): `get(path)` returns parsed JSON and throws `ApiError` (with `.status`) on a non-2xx; `getAll(path)` follows paging and returns the items array.
- **`safeGet(context, url, { timeout, maxRedirects })`** (`src/guard/readonly.ts`) returns a Playwright `APIResponse`: `status()`, `headers()`, `text()`.
- **`LOGIN_URL_PATTERN`** is in `src/config.ts`; `SessionExpiredError` in `src/errors.ts`; `cleanName` and `stripLongSuffix` in `src/parse/cells.ts`; `decodeEntities` in `src/render/text.ts`.
- **What is deliberately not served** (and stays "NOT FETCHED" in the run summary): landing pages (all builders), `smartFormInstanceId` and `internalFormId` forms, SMS steps that carry only `automationMessageId`, legacy HTTP Post (`http` style, keyed by `fileBoxId`), email attachments.

## File structure

```
src/content/sources/
  appGet.ts        guarded GET for Keap app content endpoints (allowlist, no redirects, 404, sign-in)
  email.ts         emails — REST templates
  webform.ts       web forms — REST list, cached per run
  sms.ts           SMS — app JSON
  note.ts          Apply Note templates — app editor HTML
  httpRequest.ts   HTTP Request steps — app editor HTML
  index.ts         SOURCES registry (modified)
src/content/types.ts   optional fields added to FormContent, SmsContent, NoteContent (modified)
```

---

### Task 1: Record fields and the guarded app GET

**Files:**
- Modify: `src/content/types.ts`
- Create: `src/content/sources/appGet.ts`
- Test: `test/sourceAppGet.test.ts`

**Interfaces:**
- Produces: `APP_CONTENT_PATHS: RegExp[]`, `APP_GET_TIMEOUT_MS`, `AppResponse { status; contentType; body }`, `assertContentPath(path)`, `appGet(ctx, path): Promise<AppResponse>`; optional record fields `FormContent.publicUrl/formType/fieldsAvailable`, `SmsContent.phoneTypes`, `NoteContent.notifyUsers/assignTo`.

- [ ] **Step 1: Extend the records in `src/content/types.ts`**

Add these optional fields (keep every existing field and export):

```ts
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
```

- [ ] **Step 2: Write the failing test**

```ts
// test/sourceAppGet.test.ts
import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { APP_GET_TIMEOUT_MS, appGet, assertContentPath } from '../src/content/sources/appGet.js';
import { ContentNotFoundError, type FetchContext } from '../src/content/types.js';
import { isSessionExpired } from '../src/errors.js';

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

function fakeContext(reply: Reply) {
  const calls: { url: string; options: unknown }[] = [];
  const browser = {
    request: {
      get: async (url: string, options: unknown) => {
        calls.push({ url, options });
        return {
          status: () => reply.status,
          headers: () => reply.headers ?? {},
          text: async () => reply.body ?? '',
          url: () => url,
        };
      },
    },
  } as unknown as BrowserContext;
  const ctx: FetchContext = { app: 'se232', baseUrl: 'https://se232.infusionsoft.com', browser, api: null };
  return { ctx, calls };
}

describe('assertContentPath', () => {
  it.each([
    '/app/automatedSmsFunnel/45179',
    '/app/noteFunnel/edit?marketingNoteId=1&mayPickUser=false',
    '/app/httpRequestFunnel/requests/5',
  ])('allows %s', (path) => expect(() => assertContentPath(path)).not.toThrow());

  it.each([
    '/app/automatedSmsFunnel/sendTest',
    '/app/automatedSmsFunnel/45179/clone',
    '/app/httpFunnel/3061033',
    '/app/funnel/105',
    '/app/noteFunnel/editSomethingElse',
    '/crm/rest/v2/emails',
  ])('refuses %s', (path) => expect(() => assertContentPath(path)).toThrow(/not a content endpoint/));
});

describe('appGet', () => {
  it('returns the body of a 200, with the timeout and no redirects', async () => {
    const { ctx, calls } = fakeContext({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    const response = await appGet(ctx, '/app/automatedSmsFunnel/45179');
    expect(response).toEqual({ status: 200, contentType: 'application/json', body: '{"a":1}' });
    expect(calls).toEqual([
      {
        url: 'https://se232.infusionsoft.com/app/automatedSmsFunnel/45179',
        options: { timeout: APP_GET_TIMEOUT_MS, maxRedirects: 0 },
      },
    ]);
  });

  it('refuses a path off the allowlist without making a request', async () => {
    const { ctx, calls } = fakeContext({ status: 200 });
    await expect(appGet(ctx, '/app/automatedSmsFunnel/sendTest')).rejects.toThrow(/not a content endpoint/);
    expect(calls).toEqual([]);
  });

  it('treats a redirect to sign-in as an expired session', async () => {
    const { ctx } = fakeContext({ status: 302, headers: { location: 'https://signin.infusionsoft.com/login' } });
    const error = await appGet(ctx, '/app/automatedSmsFunnel/1').catch((e: unknown) => e);
    expect(isSessionExpired(error)).toBe(true);
  });

  it('refuses any other redirect', async () => {
    const { ctx } = fakeContext({ status: 302, headers: { location: '/app/somewhere' } });
    await expect(appGet(ctx, '/app/automatedSmsFunnel/1')).rejects.toThrow(/redirected unexpectedly/);
  });

  it('reports a 404 as not found', async () => {
    const { ctx } = fakeContext({ status: 404 });
    await expect(appGet(ctx, '/app/automatedSmsFunnel/1')).rejects.toBeInstanceOf(ContentNotFoundError);
  });

  it('fails on other statuses', async () => {
    const { ctx } = fakeContext({ status: 500 });
    await expect(appGet(ctx, '/app/automatedSmsFunnel/1')).rejects.toThrow(/HTTP 500/);
  });

  it('needs the session', async () => {
    const { ctx } = fakeContext({ status: 200 });
    await expect(appGet({ ...ctx, browser: null }, '/app/automatedSmsFunnel/1')).rejects.toThrow(/session/);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run test/sourceAppGet.test.ts`
Expected: FAIL — cannot find module `../src/content/sources/appGet.js`.

- [ ] **Step 4: Write `src/content/sources/appGet.ts`**

```ts
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
  if (status === 404) throw new ContentNotFoundError(`${path} → 404`);
  if (status < 200 || status >= 300) throw new Error(`${path} → HTTP ${status}`);

  return { status, contentType: headers['content-type'] ?? '', body: await response.text() };
}
```

The SMS and HTTP Request patterns accept digits only: both ids are integers in every observed step, and a digits-only pattern cannot be bent into another path.

- [ ] **Step 5: Run it to see it pass**

Run: `npx vitest run test/sourceAppGet.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/types.ts src/content/sources/appGet.ts test/sourceAppGet.test.ts
git commit -m "feat: guarded GET for Keap app content endpoints"
```

---

### Task 2: Email source

**Files:**
- Create: `src/content/sources/email.ts`
- Test: `test/sourceEmail.test.ts`

**Interfaces:**
- Consumes: `ApiClient`, `ApiError`; `cleanName`; Task 2-of-previous-plan types.
- Produces: `templatePath(id)`, `mapTemplate(raw)`, `emailSource: ContentSource`.

- [ ] **Step 1: Write the failing test**

```ts
// test/sourceEmail.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError, type ApiClient } from '../src/api/client.js';
import { emailSource } from '../src/content/sources/email.js';
import { ContentNotFoundError, type ContentItemKey, type FetchContext } from '../src/content/types.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(`test/fixtures/content/${name}`, 'utf8'));

function ctxReturning(result: unknown | Error) {
  const paths: string[] = [];
  const api: ApiClient = {
    get: async (path) => {
      paths.push(path);
      if (result instanceof Error) throw result;
      return result;
    },
    getAll: async () => {
      throw new Error('not used');
    },
  };
  const ctx: FetchContext = { app: 'jordan', baseUrl: 'https://jordan.infusionsoft.com', browser: null, api };
  return { ctx, paths };
}

const key = (id: string): ContentItemKey => ({ kind: 'email', attribute: 'marketingEmailId', id });

describe('emailSource', () => {
  it('declares what it needs', () => {
    expect(emailSource).toMatchObject({
      kind: 'email',
      attributes: ['marketingEmailId'],
      needsApiKey: true,
      needsBrowser: false,
    });
  });

  it('maps a legacy template and drops the HTML-only placeholder text part', async () => {
    const { ctx, paths } = ctxReturning(fixture('email-template-legacy.json'));
    const fetched = await emailSource.fetch(key('1261'), ctx);

    expect(paths).toEqual(['/crm/rest/v2/emails/templates/1261']);
    expect(fetched.record).toEqual({
      kind: 'email',
      name: 'Untitled Email',
      from: '"Example Sender" <sender@example.com>',
      replyTo: null,
      to: '~Contact.Email~',
      cc: null,
      bcc: 'records@example.com',
      subject: 'Hi ~Contact.FirstName~',
      previewText: null,
      attachments: [],
    });
    expect(fetched.files.map((f) => f.name)).toEqual(['body.html']);
    expect(fetched.evidence.map((f) => f.name)).toEqual(['response.json']);
    expect(emailSource.validate(fetched)).toBeNull();
  });

  it('cleans ~br~ from the title and handles an HTML-only template', async () => {
    const { ctx } = ctxReturning(fixture('email-template-unlayer.json'));
    const fetched = await emailSource.fetch(key('2415'), ctx);
    expect(fetched.record).toMatchObject({ name: 'EM1 Initial Notification', subject: 'Your payment failed' });
    expect(fetched.files.map((f) => f.name)).toEqual(['body.html']);
  });

  it('keeps a real text part and omits an empty HTML part', async () => {
    const { ctx } = ctxReturning(fixture('email-template-plain.json'));
    const fetched = await emailSource.fetch(key('3001'), ctx);
    expect(fetched.files).toEqual([{ name: 'body.txt', body: 'Hi ~Contact.FirstName~, see you tomorrow.' }]);
  });

  it('reports a deleted template as not found', async () => {
    const { ctx } = ctxReturning(new ApiError(404, '/crm/rest/v2/emails/templates/9', 'GET … failed with 404'));
    await expect(emailSource.fetch(key('9'), ctx)).rejects.toBeInstanceOf(ContentNotFoundError);
  });

  it('refuses a response for a different template', async () => {
    const { ctx } = ctxReturning(fixture('email-template-legacy.json'));
    await expect(emailSource.fetch(key('1262'), ctx)).rejects.toThrow(/asked for template 1262/);
  });

  it('needs the API client', async () => {
    const { ctx } = ctxReturning({});
    await expect(emailSource.fetch(key('1'), { ...ctx, api: null })).rejects.toThrow(/KEAP_API_KEY/);
  });

  it('rejects evidence that is not a template', () => {
    expect(
      emailSource.validate({
        record: { kind: 'email', name: null, from: null, replyTo: null, to: null, cc: null, bcc: null, subject: null, previewText: null, attachments: [] },
        files: [],
        evidence: [{ name: 'response.json', body: '{"message":"oops"}' }],
        assetUrls: [],
      }),
    ).toMatch(/not an email template/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/sourceEmail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/content/sources/email.ts`**

```ts
import { ApiError } from '../../api/client.js';
import { cleanName } from '../../parse/cells.js';
import {
  type ContentFile,
  ContentNotFoundError,
  type ContentSource,
  type EmailContent,
  type FetchedContent,
} from '../types.js';

/**
 * Keap's text part for an HTML-only email is a pointer to the hosted copy
 * (`~HostedEmail.Url~`), not content. Dropped, so the export derives a readable
 * text part from the HTML instead.
 */
const HTML_ONLY_PLACEHOLDER = /^This email was sent as HTML-only\./;

interface TemplateResponse {
  id?: unknown;
  piece_title?: unknown;
  from_address?: unknown;
  to_address?: unknown;
  cc_address?: unknown;
  bcc_address?: unknown;
  subject?: unknown;
  text_body?: unknown;
  html_body?: unknown;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

export function templatePath(id: string): string {
  return `/crm/rest/v2/emails/templates/${encodeURIComponent(id)}`;
}

/**
 * One email template, from `GET /crm/rest/v2/emails/templates/{id}` — confirmed
 * for the legacy, beta (`bardEmail`) and Unlayer builders (spike-findings §18).
 * The API has no attachments, reply-to or preview text; those stay empty.
 */
export function mapTemplate(raw: unknown): FetchedContent {
  const t = (raw ?? {}) as TemplateResponse;
  const record: EmailContent = {
    kind: 'email',
    name: cleanName(typeof t.piece_title === 'string' ? t.piece_title : null),
    from: text(t.from_address),
    replyTo: null,
    to: text(t.to_address),
    cc: text(t.cc_address),
    bcc: text(t.bcc_address),
    subject: text(t.subject),
    previewText: null,
    attachments: [],
  };

  const files: ContentFile[] = [];
  const html = text(t.html_body);
  if (html !== null) files.push({ name: 'body.html', body: html });
  const plain = text(t.text_body);
  if (plain !== null && !HTML_ONLY_PLACEHOLDER.test(plain.trim())) {
    files.push({ name: 'body.txt', body: plain });
  }

  return {
    record,
    files,
    evidence: [{ name: 'response.json', body: JSON.stringify(raw, null, 2) }],
    assetUrls: [],
  };
}

export const emailSource: ContentSource = {
  kind: 'email',
  attributes: ['marketingEmailId'],
  needsApiKey: true,
  needsBrowser: false,

  async fetch(key, ctx) {
    if (ctx.api === null) throw new Error('emails are read through the REST API — set KEAP_API_KEY');
    let raw: unknown;
    try {
      raw = await ctx.api.get(templatePath(key.id));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new ContentNotFoundError(`email template ${key.id} does not exist`);
      }
      throw error;
    }
    const id = (raw as TemplateResponse | null)?.id;
    if (String(id) !== key.id) {
      throw new Error(`asked for template ${key.id}, got ${String(id)}`);
    }
    return mapTemplate(raw);
  },

  validate(content) {
    const evidence = content.evidence.find((file) => file.name === 'response.json');
    try {
      const parsed = JSON.parse(String(evidence?.body ?? '')) as TemplateResponse;
      if (typeof parsed.id === 'number' || typeof parsed.id === 'string') return null;
    } catch {
      // fall through
    }
    return 'response is not an email template';
  },
};
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run test/sourceEmail.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/sources/email.ts test/sourceEmail.test.ts
git commit -m "feat: read campaign emails through the REST templates endpoint"
```

---

### Task 3: Web form source

**Files:**
- Create: `src/content/sources/webform.ts`
- Test: `test/sourceWebform.test.ts`

**Interfaces:**
- Produces: `WEBFORMS_PATH`, `mapWebform(entry)`, `createWebformSource(): ContentSource`.

There is no single-form endpoint (`/webforms/{id}` 404s on v1 and v2); the list has everything the API offers. The public form page answered "Error 640" in the spike, so fields and HTML are not available and the record says so (`fieldsAvailable: false`).

- [ ] **Step 1: Write the failing test**

```ts
// test/sourceWebform.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../src/api/client.js';
import { WEBFORMS_PATH, createWebformSource } from '../src/content/sources/webform.js';
import { ContentNotFoundError, type ContentItemKey, type FetchContext } from '../src/content/types.js';

const list = (JSON.parse(readFileSync('test/fixtures/content/webforms-list.json', 'utf8')) as {
  webforms: unknown[];
}).webforms;

function ctxWith(getAll: ApiClient['getAll']) {
  const api: ApiClient = {
    get: async () => {
      throw new Error('not used');
    },
    getAll,
  };
  const ctx: FetchContext = { app: 'jordan', baseUrl: 'https://jordan.infusionsoft.com', browser: null, api };
  return ctx;
}

const key = (id: string): ContentItemKey => ({ kind: 'form', attribute: 'webformId', id });

describe('createWebformSource', () => {
  it('declares what it needs', () => {
    expect(createWebformSource()).toMatchObject({
      kind: 'form',
      attributes: ['webformId'],
      needsApiKey: true,
      needsBrowser: false,
    });
  });

  it('maps a list entry and says fields were not available', async () => {
    const source = createWebformSource();
    const fetched = await source.fetch(key('5'), ctxWith(async () => list));
    expect(fetched.record).toEqual({
      kind: 'form',
      name: 'Test Form',
      fields: [],
      fieldsAvailable: false,
      thankYou: { type: 'redirect', value: 'https://example.com/thanks' },
      publicUrl: 'https://example.infusionsoft.com/app/form/933be0bce44888029d76a647dbd42673',
      formType: 'LEGACY',
    });
    expect(fetched.files).toEqual([]);
    expect(fetched.assetUrls).toEqual([]);
    expect(fetched.evidence.map((f) => f.name)).toEqual(['webform.json']);
    expect(source.validate(fetched)).toBeNull();
  });

  it('maps a message exit with no thank-you URL', async () => {
    const fetched = await createWebformSource().fetch(key('3'), ctxWith(async () => list));
    expect(fetched.record).toMatchObject({ thankYou: { type: 'message', value: null } });
  });

  it('reads the list once per run', async () => {
    let calls = 0;
    const paths: string[] = [];
    const source = createWebformSource();
    const ctx = ctxWith(async (path) => {
      calls++;
      paths.push(path);
      return list;
    });
    await source.fetch(key('3'), ctx);
    await source.fetch(key('5'), ctx);
    expect(calls).toBe(1);
    expect(paths).toEqual([WEBFORMS_PATH]);
  });

  it('retries the list after a failed read', async () => {
    let calls = 0;
    const source = createWebformSource();
    const ctx = ctxWith(async () => {
      calls++;
      if (calls === 1) throw new Error('rate limited');
      return list;
    });
    await expect(source.fetch(key('3'), ctx)).rejects.toThrow(/rate limited/);
    await expect(source.fetch(key('3'), ctx)).resolves.toMatchObject({ record: { name: 'E-mail Opt-Out Form' } });
  });

  it('reports a form missing from the list as not found', async () => {
    await expect(createWebformSource().fetch(key('999'), ctxWith(async () => list))).rejects.toBeInstanceOf(
      ContentNotFoundError,
    );
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/sourceWebform.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/content/sources/webform.ts`**

```ts
import { cleanName } from '../../parse/cells.js';
import {
  ContentNotFoundError,
  type ContentSource,
  type FetchContext,
  type FetchedContent,
  type FormContent,
} from '../types.js';

export const WEBFORMS_PATH = '/crm/rest/v2/webforms';

interface WebformEntry {
  id?: unknown;
  name?: unknown;
  webform_url?: unknown;
  thank_you_page_url?: unknown;
  exit_option?: unknown;
  webform_type?: unknown;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

export function mapWebform(entry: WebformEntry): FetchedContent {
  const exit = entry.exit_option;
  const record: FormContent = {
    kind: 'form',
    name: cleanName(text(entry.name)),
    fields: [],
    fieldsAvailable: false,
    thankYou: {
      type: exit === 'REDIRECT' ? 'redirect' : exit === 'MESSAGE' ? 'message' : 'unknown',
      value: text(entry.thank_you_page_url),
    },
    publicUrl: text(entry.webform_url),
    formType: text(entry.webform_type),
  };
  return {
    record,
    files: [],
    evidence: [{ name: 'webform.json', body: JSON.stringify(entry, null, 2) }],
    assetUrls: [],
  };
}

/**
 * Web forms, from the v2 list — the only form resource the API has
 * (spike-findings §18). The list is read once per run and shared by every form
 * item; a failed read is not cached, so the next item tries again.
 */
export function createWebformSource(): ContentSource {
  let listing: Promise<Map<string, WebformEntry>> | null = null;

  const load = (ctx: FetchContext): Promise<Map<string, WebformEntry>> => {
    if (ctx.api === null) {
      return Promise.reject(new Error('web forms are read through the REST API — set KEAP_API_KEY'));
    }
    if (listing === null) {
      listing = ctx.api.getAll(WEBFORMS_PATH).then(
        (items) =>
          new Map(
            items
              .filter((item): item is WebformEntry => item !== null && typeof item === 'object')
              .map((item) => [String(item.id), item] as const),
          ),
        (error: unknown) => {
          listing = null;
          throw error;
        },
      );
    }
    return listing;
  };

  return {
    kind: 'form',
    attributes: ['webformId'],
    needsApiKey: true,
    needsBrowser: false,

    async fetch(key, ctx) {
      const entry = (await load(ctx)).get(key.id);
      if (entry === undefined) throw new ContentNotFoundError(`web form ${key.id} is not in the account`);
      return mapWebform(entry);
    },

    validate(content) {
      if (content.record.kind !== 'form') return 'not a web form';
      const evidence = content.evidence.find((file) => file.name === 'webform.json');
      try {
        const parsed = JSON.parse(String(evidence?.body ?? '')) as WebformEntry;
        if (parsed.id !== undefined && parsed.id !== null) return null;
      } catch {
        // fall through
      }
      return 'response is not a web form';
    },
  };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run test/sourceWebform.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/sources/webform.ts test/sourceWebform.test.ts
git commit -m "feat: read web forms from the REST list, once per run"
```

---

### Task 4: SMS source

**Files:**
- Create: `src/content/sources/sms.ts`
- Test: `test/sourceSms.test.ts`

**Interfaces:**
- Consumes: `appGet` (Task 1).
- Produces: `smsPath(id)`, `mapSms(raw)`, `smsSource: ContentSource`.

Only `marketingAutomatedSmsId` is served. `automationMessageId` is a different id space (it equals the response's `id`), and there is no GET keyed by it; steps that carry only that attribute stay unserved.

- [ ] **Step 1: Write the failing test**

```ts
// test/sourceSms.test.ts
import { readFileSync } from 'node:fs';
import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { smsSource } from '../src/content/sources/sms.js';
import type { ContentItemKey, FetchContext } from '../src/content/types.js';

const fixture = (name: string) => readFileSync(`test/fixtures/content/${name}`, 'utf8');

function ctxServing(body: string, contentType = 'application/json;charset=UTF-8') {
  const urls: string[] = [];
  const browser = {
    request: {
      get: async (url: string) => {
        urls.push(url);
        return {
          status: () => 200,
          headers: () => ({ 'content-type': contentType }),
          text: async () => body,
          url: () => url,
        };
      },
    },
  } as unknown as BrowserContext;
  const ctx: FetchContext = { app: 'se232', baseUrl: 'https://se232.infusionsoft.com', browser, api: null };
  return { ctx, urls };
}

const key = (id: string): ContentItemKey => ({ kind: 'sms', attribute: 'marketingAutomatedSmsId', id });

describe('smsSource', () => {
  it('declares what it needs', () => {
    expect(smsSource).toMatchObject({
      kind: 'sms',
      attributes: ['marketingAutomatedSmsId'],
      needsApiKey: false,
      needsBrowser: true,
    });
  });

  it('maps a configured message', async () => {
    const { ctx, urls } = ctxServing(fixture('sms-configured.json'));
    const fetched = await smsSource.fetch(key('50970'), ctx);
    expect(urls).toEqual(['https://se232.infusionsoft.com/app/automatedSmsFunnel/50970']);
    expect(fetched.record).toEqual({
      kind: 'sms',
      name: null,
      text: 'Hi ~Contact.FirstName~, your trip departs tomorrow. Reply STOP to opt out.',
      sender: null,
      phoneTypes: ['Mobile'],
    });
    expect(fetched.files).toEqual([]);
    expect(fetched.evidence.map((f) => f.name)).toEqual(['response.json']);
    expect(smsSource.validate(fetched)).toBeNull();
  });

  it('keeps an unconfigured step as an empty message', async () => {
    const { ctx } = ctxServing(fixture('sms-unconfigured.json'));
    const fetched = await smsSource.fetch(key('45179'), ctx);
    expect(fetched.record).toMatchObject({ text: '', phoneTypes: ['Mobile', 'Work', 'Home', 'Other'] });
    expect(smsSource.validate(fetched)).toBeNull();
  });

  it('refuses an HTML page served in place of the message', async () => {
    const { ctx } = ctxServing('<html><body>Sign in</body></html>', 'text/html');
    await expect(smsSource.fetch(key('1'), ctx)).rejects.toThrow(/expected JSON/);
  });

  it('rejects JSON that is not an SMS message', () => {
    expect(
      smsSource.validate({
        record: { kind: 'sms', name: null, text: '', sender: null },
        files: [],
        evidence: [{ name: 'response.json', body: '{"error":"nope"}' }],
        assetUrls: [],
      }),
    ).toMatch(/not an automated SMS/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/sourceSms.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/content/sources/sms.ts`**

```ts
import type { ContentSource, FetchedContent, SmsContent } from '../types.js';
import { appGet } from './appGet.js';

interface SmsResponse {
  id?: unknown;
  message?: unknown;
  phoneTypes?: unknown;
}

export function smsPath(id: string): string {
  return `/app/automatedSmsFunnel/${encodeURIComponent(id)}`;
}

/**
 * An automated SMS step, from the JSON the SMS builder itself loads
 * (spike-findings §18). An unconfigured step answers `message: null` — genuine,
 * and exported as an empty message rather than a failure.
 */
export function mapSms(raw: unknown, body: string): FetchedContent {
  const r = (raw ?? {}) as SmsResponse;
  const record: SmsContent = {
    kind: 'sms',
    name: null,
    text: typeof r.message === 'string' ? r.message : '',
    sender: null,
    phoneTypes: Array.isArray(r.phoneTypes)
      ? r.phoneTypes.filter((t): t is string => typeof t === 'string')
      : [],
  };
  return { record, files: [], evidence: [{ name: 'response.json', body }], assetUrls: [] };
}

export const smsSource: ContentSource = {
  kind: 'sms',
  attributes: ['marketingAutomatedSmsId'],
  needsApiKey: false,
  needsBrowser: true,

  async fetch(key, ctx) {
    const response = await appGet(ctx, smsPath(key.id));
    if (!response.contentType.toLowerCase().includes('json')) {
      throw new Error(`expected JSON from ${smsPath(key.id)}, got ${response.contentType || 'no content type'}`);
    }
    return mapSms(JSON.parse(response.body) as unknown, response.body);
  },

  validate(content) {
    const evidence = content.evidence.find((file) => file.name === 'response.json');
    try {
      const parsed = JSON.parse(String(evidence?.body ?? '')) as SmsResponse & Record<string, unknown>;
      if (parsed.id !== undefined && 'message' in parsed) return null;
    } catch {
      // fall through
    }
    return 'response is not an automated SMS message';
  },
};
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run test/sourceSms.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/sources/sms.ts test/sourceSms.test.ts
git commit -m "feat: read automated SMS messages"
```

---

### Task 5: Apply Note source

**Files:**
- Create: `src/content/sources/note.ts`
- Test: `test/sourceNote.test.ts`

**Interfaces:**
- Consumes: `appGet`; cheerio `load`; `decodeEntities`; `stripLongSuffix`.
- Produces: `notePath(id)`, `parseNoteEditor(html): NoteContent | null`, `noteSource: ContentSource`.

- [ ] **Step 1: Write the failing test**

```ts
// test/sourceNote.test.ts
import { readFileSync } from 'node:fs';
import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { noteSource, parseNoteEditor } from '../src/content/sources/note.js';
import type { ContentItemKey, FetchContext } from '../src/content/types.js';

const editor = readFileSync('test/fixtures/content/note-editor.html', 'utf8');

function ctxServing(body: string) {
  const urls: string[] = [];
  const browser = {
    request: {
      get: async (url: string) => {
        urls.push(url);
        return {
          status: () => 200,
          headers: () => ({ 'content-type': 'text/html;charset=UTF-8' }),
          text: async () => body,
          url: () => url,
        };
      },
    },
  } as unknown as BrowserContext;
  const ctx: FetchContext = { app: 'se232', baseUrl: 'https://se232.infusionsoft.com', browser, api: null };
  return { ctx, urls };
}

const key = (id: string): ContentItemKey => ({ kind: 'note', attribute: 'marketingNoteId', id });

describe('parseNoteEditor', () => {
  it('reads type, title, body, notified users and assignment', () => {
    expect(parseNoteEditor(editor)).toEqual({
      kind: 'note',
      name: 'Purchased - Example Trip Kickoff',
      type: 'UPDATE',
      subject: 'Purchased - Example Trip Kickoff',
      body: 'Call ~Contact.FirstName~ about the deposit & flights.',
      notifyUsers: [
        { id: '336317', name: 'User 13' },
        { id: '504756', name: 'User 14' },
      ],
      assignTo: 'systemUserId',
    });
  });

  it('treats "Please select one" as no type', () => {
    const unselected = editor.replace('<option selected="selected">UPDATE</option>', '<option>UPDATE</option>');
    expect(parseNoteEditor(unselected)?.type).toBeNull();
  });

  it('returns null for anything that is not the note editor', () => {
    expect(parseNoteEditor('<div id="wrapper_note"></div>')).toBeNull();
    expect(parseNoteEditor('<html><body>Sign in</body></html>')).toBeNull();
  });
});

describe('noteSource', () => {
  it('declares what it needs', () => {
    expect(noteSource).toMatchObject({
      kind: 'note',
      attributes: ['marketingNoteId'],
      needsApiKey: false,
      needsBrowser: true,
    });
  });

  it('fetches the editor and keeps it as evidence', async () => {
    const { ctx, urls } = ctxServing(editor);
    const fetched = await noteSource.fetch(key('35421'), ctx);
    expect(urls).toEqual([
      'https://se232.infusionsoft.com/app/noteFunnel/edit?marketingNoteId=35421&mayPickUser=false',
    ]);
    expect(fetched.record).toMatchObject({ kind: 'note', type: 'UPDATE' });
    expect(fetched.files).toEqual([]);
    expect(fetched.evidence.map((f) => f.name)).toEqual(['editor.html']);
    expect(noteSource.validate(fetched)).toBeNull();
  });

  it('refuses an empty shell', async () => {
    const { ctx } = ctxServing('<div id="wrapper_note"></div>');
    await expect(noteSource.fetch(key('1'), ctx)).rejects.toThrow(/not the note editor/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/sourceNote.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/content/sources/note.ts`**

```ts
import { load } from 'cheerio';
import { stripLongSuffix } from '../../parse/cells.js';
import { decodeEntities } from '../../render/text.js';
import type { ContentSource, NoteContent } from '../types.js';
import { appGet } from './appGet.js';

export function notePath(id: string): string {
  return `/app/noteFunnel/edit?marketingNoteId=${encodeURIComponent(id)}&mayPickUser=false`;
}

/**
 * Keap's own template comment: values "may or may not be HTML encoded already in
 * the database". cheerio decodes the markup once; this decodes the stored layer.
 */
const clean = (value: string): string => decodeEntities(value).trim();

/** The Apply Note editor form, or null when the page is anything else. */
export function parseNoteEditor(html: string): NoteContent | null {
  const $ = load(html);
  if ($('#actionDescription').length === 0 || $('#creationNotes').length === 0) return null;

  const selectedType = $('#actionType option[selected]').first();
  const typeText = clean(selectedType.text());
  const typeValue = selectedType.attr('value');
  const type = selectedType.length === 0 || typeValue === '' || typeText === '' ? null : typeText;

  const subject = clean($('#actionDescription').attr('value') ?? '') || null;
  const body = clean($('#creationNotes').text());

  const notifyUsers = $('#notifyUsers option[selected]')
    .toArray()
    .map((option) => {
      const raw = $(option).attr('value') ?? '';
      return { id: stripLongSuffix(raw) ?? raw, name: clean($(option).text()) };
    });

  const assignTo = $('#assignmentUserId').attr('value') || null;

  return { kind: 'note', name: subject, type, subject, body, notifyUsers, assignTo };
}

export const noteSource: ContentSource = {
  kind: 'note',
  attributes: ['marketingNoteId'],
  needsApiKey: false,
  needsBrowser: true,

  async fetch(key, ctx) {
    const response = await appGet(ctx, notePath(key.id));
    const record = parseNoteEditor(response.body);
    if (record === null) {
      throw new Error(`${notePath(key.id)} returned something that is not the note editor`);
    }
    return { record, files: [], evidence: [{ name: 'editor.html', body: response.body }], assetUrls: [] };
  },

  validate(content) {
    const evidence = content.evidence.find((file) => file.name === 'editor.html');
    return parseNoteEditor(String(evidence?.body ?? '')) === null ? 'response is not the note editor' : null;
  },
};
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run test/sourceNote.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/sources/note.ts test/sourceNote.test.ts
git commit -m "feat: read Apply Note templates from the note editor"
```

---

### Task 6: HTTP Request source

**Files:**
- Create: `src/content/sources/httpRequest.ts`
- Test: `test/sourceHttpRequest.test.ts`

**Interfaces:**
- Consumes: `appGet`; cheerio; `redactHttp` (test only, to prove the export redacts this record).
- Produces: `httpRequestPath(id)`, `parseHttpRequestEditor(html): { configId: string | null; record: HttpContent } | null`, `httpRequestSource: ContentSource`.

Query parameters are appended to `url` as written (`name=value`, joined with `&`, not re-encoded), so the export's existing URL redaction covers them and merge fields survive intact. **The populated-row markup is an assumption** (the only HTTP Request in se232 is unconfigured — see `test/fixtures/content/README.md`); Task 8's live check confirms it.

- [ ] **Step 1: Write the failing test**

```ts
// test/sourceHttpRequest.test.ts
import { readFileSync } from 'node:fs';
import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { redactHttp } from '../src/content/redact.js';
import { httpRequestSource, parseHttpRequestEditor } from '../src/content/sources/httpRequest.js';
import type { ContentItemKey, FetchContext, HttpContent } from '../src/content/types.js';

const empty = readFileSync('test/fixtures/content/http-request-empty.html', 'utf8');
const configured = readFileSync('test/fixtures/content/http-request-configured.html', 'utf8');

function ctxServing(body: string) {
  const urls: string[] = [];
  const browser = {
    request: {
      get: async (url: string) => {
        urls.push(url);
        return {
          status: () => 200,
          headers: () => ({ 'content-type': 'text/html;charset=UTF-8' }),
          text: async () => body,
          url: () => url,
        };
      },
    },
  } as unknown as BrowserContext;
  const ctx: FetchContext = { app: 'se232', baseUrl: 'https://se232.infusionsoft.com', browser, api: null };
  return { ctx, urls };
}

const key = (id: string): ContentItemKey => ({ kind: 'http', attribute: 'httpRequestConfigId', id });

describe('parseHttpRequestEditor', () => {
  it('reads an unconfigured request as an empty POST', () => {
    expect(parseHttpRequestEditor(empty)).toEqual({
      configId: '5',
      record: { kind: 'http', name: null, method: 'POST', url: '', headers: [], fields: [], body: null },
    });
  });

  it('reads method, URL with query parameters, headers and body', () => {
    expect(parseHttpRequestEditor(configured)?.record).toEqual({
      kind: 'http',
      name: null,
      method: 'PUT',
      url: 'https://hooks.example.com/contacts/~Contact.Id~?source=keap&api_key=EXAMPLE_KEY_123',
      headers: [
        { name: 'Authorization', value: 'Bearer EXAMPLE_TOKEN' },
        { name: 'Content-Type', value: 'application/json' },
      ],
      fields: [],
      body: '{"email":"~Contact.Email~"}',
    });
  });

  it('produces a record the export redaction fully covers', () => {
    const record = parseHttpRequestEditor(configured)?.record as HttpContent;
    const { content, redacted } = redactHttp(record);
    expect(content.url).toBe('https://hooks.example.com/contacts/~Contact.Id~?source=keap&api_key=«redacted»');
    expect(content.headers[0]?.value).toBe('«redacted»');
    expect(redacted).toEqual(
      expect.arrayContaining([
        { location: 'query', name: 'api_key' },
        { location: 'header', name: 'Authorization' },
      ]),
    );
  });

  it('returns null for anything that is not the request editor', () => {
    expect(parseHttpRequestEditor('<div id="wrapper_httpRequest"></div>')).toBeNull();
  });
});

describe('httpRequestSource', () => {
  it('declares what it needs', () => {
    expect(httpRequestSource).toMatchObject({
      kind: 'http',
      attributes: ['httpRequestConfigId'],
      needsApiKey: false,
      needsBrowser: true,
    });
  });

  it('fetches the editor for its config id', async () => {
    const { ctx, urls } = ctxServing(configured);
    const fetched = await httpRequestSource.fetch(key('5'), ctx);
    expect(urls).toEqual(['https://se232.infusionsoft.com/app/httpRequestFunnel/requests/5']);
    expect(fetched.record).toMatchObject({ kind: 'http', method: 'PUT' });
    expect(fetched.evidence.map((f) => f.name)).toEqual(['editor.html']);
    expect(httpRequestSource.validate(fetched)).toBeNull();
  });

  it('refuses an editor for a different config', async () => {
    const { ctx } = ctxServing(configured);
    await expect(httpRequestSource.fetch(key('6'), ctx)).rejects.toThrow(/asked for HTTP request 6/);
  });

  it('refuses an empty shell', async () => {
    const { ctx } = ctxServing('<div id="wrapper_httpRequest"></div>');
    await expect(httpRequestSource.fetch(key('5'), ctx)).rejects.toThrow(/not the HTTP request editor/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/sourceHttpRequest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/content/sources/httpRequest.ts`**

```ts
import { type CheerioAPI, load } from 'cheerio';
import type { ContentSource, HttpContent, NameValue } from '../types.js';
import { appGet } from './appGet.js';

export function httpRequestPath(id: string): string {
  return `/app/httpRequestFunnel/requests/${encodeURIComponent(id)}`;
}

/**
 * Name/value rows of one parameter table (QUERY or HEADER). The editor's blank
 * row template lives in a <template> outside the tables, so it never matches.
 */
function rows($: CheerioAPI, table: 'QUERY' | 'HEADER'): NameValue[] {
  return $(`#paramTable-${table} tr.parameter-table-line-item`)
    .toArray()
    .map((row) => ({
      name: ($(row).find('.http-request-param-name input').attr('value') ?? '').trim(),
      value: $(row).find('.http-request-param-value input').attr('value') ?? '',
    }))
    .filter((pair) => pair.name !== '');
}

/** The HTTP Request editor form, or null when the page is anything else. */
export function parseHttpRequestEditor(
  html: string,
): { configId: string | null; record: HttpContent } | null {
  const $ = load(html);
  if ($('#httpRequestType').length === 0) return null;

  const selected = $('#httpRequestType option[selected]').first();
  const method = (
    (selected.length > 0 ? selected.attr('value') : $('#httpRequestType option').first().attr('value')) ?? 'POST'
  ).toUpperCase();

  // Written as Keap stores it — not re-encoded — so merge fields stay readable
  // and the export's URL redaction sees every parameter.
  const query = rows($, 'QUERY');
  let url = ($('#targetUrl').attr('value') ?? '').trim();
  if (query.length > 0) {
    url += (url.includes('?') ? '&' : '?') + query.map((p) => `${p.name}=${p.value}`).join('&');
  }

  const body = $('#http-request-body').text();
  return {
    configId: $('#httpRequestConfigId').attr('value') ?? null,
    record: {
      kind: 'http',
      name: null,
      method,
      url,
      headers: rows($, 'HEADER'),
      fields: [],
      body: body.trim() === '' ? null : body,
    },
  };
}

export const httpRequestSource: ContentSource = {
  kind: 'http',
  attributes: ['httpRequestConfigId'],
  needsApiKey: false,
  needsBrowser: true,

  async fetch(key, ctx) {
    const response = await appGet(ctx, httpRequestPath(key.id));
    const parsed = parseHttpRequestEditor(response.body);
    if (parsed === null) {
      throw new Error(`${httpRequestPath(key.id)} returned something that is not the HTTP request editor`);
    }
    if (parsed.configId !== key.id) {
      throw new Error(`asked for HTTP request ${key.id}, got ${parsed.configId ?? 'none'}`);
    }
    return { record: parsed.record, files: [], evidence: [{ name: 'editor.html', body: response.body }], assetUrls: [] };
  },

  validate(content) {
    const evidence = content.evidence.find((file) => file.name === 'editor.html');
    return parseHttpRequestEditor(String(evidence?.body ?? '')) === null
      ? 'response is not the HTTP request editor'
      : null;
  },
};
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run test/sourceHttpRequest.test.ts`
Expected: PASS. If the configured-fixture assertion on `body` fails on whitespace, fix the parser, not the fixture — the textarea holds exactly `{"email":"~Contact.Email~"}` after entity decoding.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/sources/httpRequest.ts test/sourceHttpRequest.test.ts
git commit -m "feat: read HTTP Request steps from the request editor"
```

---

### Task 7: Register the sources

**Files:**
- Modify: `src/content/sources/index.ts`
- Modify: `README.md` (Step 8)
- Test: `test/contentSources.test.ts`

**Interfaces:**
- Consumes: every source above.
- Produces: `SOURCES` populated.

- [ ] **Step 1: Write the failing test**

```ts
// test/contentSources.test.ts
import { describe, expect, it } from 'vitest';
import { SOURCES } from '../src/content/sources/index.js';
import { KIND_ATTRIBUTES, type ContentKind } from '../src/content/types.js';

describe('SOURCES', () => {
  const entries = Object.entries(SOURCES) as [ContentKind, NonNullable<(typeof SOURCES)[ContentKind]>][];

  it('serves exactly the id spaces the spike confirmed', () => {
    expect(
      entries.flatMap(([, source]) => source.attributes.map((a) => `${source.kind}:${a}`)).sort(),
    ).toEqual([
      'email:marketingEmailId',
      'form:webformId',
      'http:httpRequestConfigId',
      'note:marketingNoteId',
      'sms:marketingAutomatedSmsId',
    ]);
  });

  it('files every source under its own kind, serving only that kind’s attributes', () => {
    for (const [kind, source] of entries) {
      expect(source.kind).toBe(kind);
      for (const attribute of source.attributes) expect(KIND_ATTRIBUTES[kind]).toContain(attribute);
    }
  });

  it('asks for the API key only for REST-backed kinds', () => {
    expect(entries.filter(([, s]) => s.needsApiKey).map(([k]) => k).sort()).toEqual(['email', 'form']);
    expect(entries.filter(([, s]) => s.needsBrowser).map(([k]) => k).sort()).toEqual(['http', 'note', 'sms']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/contentSources.test.ts`
Expected: FAIL — the registry is empty.

- [ ] **Step 3: Replace `src/content/sources/index.ts`**

```ts
import type { ContentKind, ContentSource } from '../types.js';
import { emailSource } from './email.js';
import { httpRequestSource } from './httpRequest.js';
import { noteSource } from './note.js';
import { smsSource } from './sms.js';
import { createWebformSource } from './webform.js';

/**
 * One source per content kind, each settled by the discovery spike
 * (docs/spike-findings.md §18). Not served, and reported as NOT FETCHED by
 * fetch-content: landing pages (all builders), smart and internal forms, SMS
 * steps keyed only by automationMessageId, legacy HTTP Post, email attachments.
 */
export const SOURCES: Partial<Record<ContentKind, ContentSource>> = {
  email: emailSource,
  form: createWebformSource(),
  sms: smsSource,
  note: noteSource,
  http: httpRequestSource,
};
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run test/contentSources.test.ts`
Expected: PASS.

- [ ] **Step 5: Update README Step 8**

Replace the status note at the top of Step 8 (the one saying content sources land in a follow-up plan) with:

```markdown
**What is read today.** Emails (from, to, cc, bcc, subject, HTML and text — through the REST API),
web forms (name, hosted URL, redirect or thank-you setting — the API has no field list, and the
record says `fieldsAvailable: false`), SMS messages, Apply Note templates, and HTTP Request steps.
Emails and web forms need `KEAP_API_KEY`; the rest use your login session.

**Not read yet**, and listed as NOT FETCHED in every run and as `notFetched` in the export: landing
pages, email attachments, legacy HTTP Post steps, smart and internal forms.
```

- [ ] **Step 6: Offline smoke checks**

Run: `npm run fetch-content -- --app jordan --kinds email --limit 1`
With `KEAP_API_KEY` unset, expected: the run stops before opening a browser with `KEAP_API_KEY is required to fetch: email. Nothing was fetched.`

Run: `npm run fetch-content -- --app jordan --kinds sms`
Expected: `0 content items …` and `nothing to do` (jordan has no SMS steps) — no browser opened.

- [ ] **Step 7: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/content/sources/index.ts test/contentSources.test.ts README.md
git commit -m "feat: register the five content sources"
```

---

### Task 8: Live check (with the user)

Not a subagent task — done in the main session with the user, against se232.

- [ ] **Step 1:** User runs `npm run login -- --app se232` and sets `KEAP_API_KEY` for se232 in their own terminal (`read -s KEAP_API_KEY && export KEAP_API_KEY`).
- [ ] **Step 2:** In that terminal: `npm run fetch-content -- --app se232 --kinds sms,note,http --limit 8`. Expect every item `ok` or `NOT FOUND`; `browser requests: … 0 non-GET`.
- [ ] **Step 3:** `npm run fetch-content -- --app se232 --kinds email --limit 5`, then `--kinds form --limit 3`.
- [ ] **Step 4:** `npm run export -- --app se232 --funnel 14848` (a campaign with a configured SMS) and one campaign with Apply Note steps (e.g. `--funnel 10253`). Spot-check `campaign.json`, one `emails/<id>/email.json` + `body.html`, one SMS and one note against what Keap shows.
- [ ] **Step 5:** If se232 has no configured HTTP Request, say so; the populated-row parser stays unconfirmed and is noted in `docs/spike-findings.md` §18.
- [ ] **Step 6:** Record the results as a short addendum to `docs/spike-findings.md` §18 and commit.
- [ ] **Step 7:** Remind the user to revoke the API keys when finished.
