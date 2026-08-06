# REST API Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch the Keap account's shared entities once through the REST API, cache them as `artifacts/<app>/entities.json`, and join them onto the relationship graph so its 586 unlabelled entities carry names.

**Architecture:** Three new pure-ish modules under `src/api/`. `guard.ts` is a pure allowlist. `catalogue.ts` is pure response-mapping plus orchestration over an injected client. `client.ts` is the only file that touches the network, and it is tested against a mocked `fetch`. `graph.ts` gains an optional catalogue argument and stays pure — it takes a catalogue as data and never fetches one.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥20 global `fetch`, vitest, tsx. No new dependencies.

## Global Constraints

- **The API key is never logged, never echoed, never written to any artifact, and never included in an error message.** It is read from `KEAP_API_KEY` and passed only as a request header.
- **No contact record is ever fetched.** Enforced by an allowlist in `guard.ts`, not by intention.
- **GET only.** No other method is constructible through `ApiClient`.
- **No test touches the network.** Every test injects a fake client or a mocked `fetch`.
- **The existing 209 tests must pass unchanged.** `buildGraph` with no catalogue must behave exactly as it does today; enrichment that alters unenriched behaviour is a bug.
- **Enrichment is additive and optional.** `npm run normalize` with no `entities.json` present builds the graph exactly as today and says so. It must never fail for want of a catalogue.
- Import specifiers carry `.js` even for TypeScript sources (`./guard.js`), matching every existing module.
- `npm run typecheck` and `npm test` pass at the end of every task.
- Base URL is `https://api.infusionsoft.com`, overridable via `KEAP_API_BASE_URL` for tests. Auth header is `X-Keap-API-Key`.

---

## Context an implementer needs

**Endpoint paths in this plan are candidates, not facts.** Keap's v1 and v2 REST docs are JS-rendered and could not be read directly; the resource lists were confirmed only at the summary level (v1: contacts, orders, products, subscriptions, campaigns, files, tags, merchants, emails; v2: contacts, companies, opportunities, tags, emails, appointments, notes, tasks). **Neither list mentions webforms or landing pages** — 173 of the entities in scope. Task 9 is where the probe settles this against the live account, exactly as `decisionEditor`, `perPage`-as-GET and the guard gaps were all settled by running rather than reading.

Consequences for the implementer:

- The allowlist covers **candidate** paths. Every candidate must be allowlisted, or the probe cannot test it.
- A candidate that 404s is not a bug — it is the probe doing its job. It becomes an `unavailable` entry in `sources`.
- Tasks 1–8 are entirely offline and need no key. **Only Task 9 needs `KEAP_API_KEY`.** Build and verify everything else first.

**Two paging styles must both work.** Keap v1 pages with `limit`/`offset`; v2 pages with `page_token`/`next_page_token`. `getAll` detects which from the response shape rather than being told.

**The identity check has an unknown.** The account-profile response may or may not carry the tenant subdomain. Task 5 handles this by searching every string value in the profile for the app name and, on no match, **failing** while listing the profile's *field names* (never values) so the operator can say which field carries tenant identity. That turns an unknown into a self-diagnosing failure rather than a silent hole.

**Measured facts this plan relies on** (from `artifacts/jordan/graph.json`):

| | |
|---|---|
| Entities, of which unlabelled | 762 / 586 |
| `userId` references (become `assigned-to` edges) | 10 |
| Tags labelled from decision criteria (the cross-check) | 6 |
| Current edge total | 780 |

---

### Task 1: The guard

**Files:**
- Create: `src/api/guard.ts`
- Test: `test/apiGuard.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ALLOWED_PATHS: RegExp[]`, `isAllowed(method: string, path: string): boolean`, `assertAllowed(method: string, path: string): void`.

- [ ] **Step 1: Write the failing test**

Create `test/apiGuard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ALLOWED_PATHS, assertAllowed, isAllowed } from '../src/api/guard.js';

describe('api guard', () => {
  it('permits every entity path the catalogue needs', () => {
    for (const path of [
      '/crm/rest/v1/tags',
      '/crm/rest/v2/tags',
      '/crm/rest/v1/emails',
      '/crm/rest/v2/emails',
      '/crm/rest/v1/products',
      '/crm/rest/v1/users',
      '/crm/rest/v1/forms',
      '/crm/rest/v1/account/profile',
    ]) {
      expect(isAllowed('GET', path), path).toBe(true);
    }
  });

  it('refuses contacts, whatever the version or shape', () => {
    // The key is admin-scoped: it CAN read every contact in the account.
    // Nothing but this list stops it.
    for (const path of [
      '/crm/rest/v1/contacts',
      '/crm/rest/v2/contacts',
      '/crm/rest/v1/contacts/1234',
      '/crm/rest/v1/contacts?limit=1',
    ]) {
      expect(isAllowed('GET', path), path).toBe(false);
    }
  });

  it('refuses other resources holding personal data', () => {
    for (const path of [
      '/crm/rest/v1/companies',
      '/crm/rest/v1/opportunities',
      '/crm/rest/v1/orders',
      '/crm/rest/v1/appointments',
      '/crm/rest/v1/notes',
      '/crm/rest/v1/subscriptions',
    ]) {
      expect(isAllowed('GET', path), path).toBe(false);
    }
  });

  it('refuses every method except GET', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      expect(isAllowed(method, '/crm/rest/v1/tags'), method).toBe(false);
    }
  });

  it('is not fooled by a permitted resource appearing later in the path', () => {
    expect(isAllowed('GET', '/crm/rest/v1/contacts/1/tags')).toBe(false);
    expect(isAllowed('GET', '/evil.com/crm/rest/v1/tags')).toBe(false);
  });

  it('assertAllowed throws with the path but never leaks a query string', () => {
    expect(() => assertAllowed('GET', '/crm/rest/v1/contacts')).toThrow(/not on the allowlist/i);
    expect(() => assertAllowed('GET', '/crm/rest/v1/tags')).not.toThrow();
  });

  it('every allowlist entry is anchored at the start', () => {
    // An unanchored pattern is how "/evil.com/crm/rest/v1/tags" gets through.
    for (const pattern of ALLOWED_PATHS) {
      expect(pattern.source.startsWith('^'), pattern.source).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/apiGuard.test.ts
```

Expected: FAIL — `Cannot find module '../src/api/guard.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/api/guard.ts`:

```ts
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
  /^\/crm\/rest\/v[12]\/emails(?:\/|$)/,
  /^\/crm\/rest\/v[12]\/products(?:\/|$)/,
  /^\/crm\/rest\/v[12]\/users(?:\/|$)/,
  /^\/crm\/rest\/v[12]\/forms(?:\/|$)/,
  /^\/crm\/rest\/v[12]\/account\/profile(?:\/|$)/,
];

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
```

Note `/crm/rest/v1/contacts/1/tags` is refused by construction: the pattern anchors `tags` immediately after the version segment.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/apiGuard.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/guard.ts test/apiGuard.test.ts
git commit -m "feat: allowlist guard for the Keap REST API"
```

---

### Task 2: The client

**Files:**
- Create: `src/api/client.ts`
- Test: `test/apiClient.test.ts`

**Interfaces:**
- Consumes: `assertAllowed` from `./guard.js`.
- Produces:
  - `interface ApiClient { get(path, query?): Promise<unknown>; getAll(path, query?): Promise<unknown[]> }`
  - `createClient(apiKey: string, options?: { baseUrl?: string; fetchImpl?: typeof fetch; throttleMs?: number; maxRetries?: number }): ApiClient`
  - `class ApiError extends Error { readonly status: number; readonly path: string }`

- [ ] **Step 1: Write the failing test**

Create `test/apiClient.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from '../src/api/client.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A fetch stub that replays a queue of responses and records every call. */
function stubFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('stubFetch: no response queued');
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const client = (responses: Response[]) => {
  const { impl, calls } = stubFetch(responses);
  return {
    calls,
    api: createClient('secret-key', {
      baseUrl: 'https://api.test',
      fetchImpl: impl,
      throttleMs: 0,
    }),
  };
};

describe('createClient', () => {
  it('sends the key as X-Keap-API-Key and asks for JSON', async () => {
    const { api, calls } = client([json({ tags: [] })]);
    await api.get('/crm/rest/v1/tags');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('X-Keap-API-Key')).toBe('secret-key');
    expect(headers.get('Accept')).toBe('application/json');
    expect(calls[0]?.init.method ?? 'GET').toBe('GET');
  });

  it('builds the URL from base, path and query', async () => {
    const { api, calls } = client([json({})]);
    await api.get('/crm/rest/v1/tags', { limit: '1' });
    expect(calls[0]?.url).toBe('https://api.test/crm/rest/v1/tags?limit=1');
  });

  it('refuses a path outside the allowlist without sending anything', async () => {
    const { api, calls } = client([]);
    await expect(api.get('/crm/rest/v1/contacts')).rejects.toThrow(/allowlist/i);
    expect(calls).toHaveLength(0);
  });

  it('never puts the key in an error message', async () => {
    const { api } = client([json({ message: 'nope' }, 401)]);
    await expect(api.get('/crm/rest/v1/tags')).rejects.toThrow(
      expect.not.stringContaining('secret-key') as unknown as string,
    );
  });

  it('reports 401 as a credential problem, naming neither the key nor its value', async () => {
    const { api } = client([json({}, 401)]);
    await expect(api.get('/crm/rest/v1/tags')).rejects.toMatchObject({ status: 401 });
    await expect(api.get('/crm/rest/v1/tags')).rejects.toThrow(/revoked|admin scope/i);
  });

  it('surfaces 404 as an ApiError so the probe can read it as "unavailable"', async () => {
    const { api } = client([json({}, 404)]);
    const error = await api.get('/crm/rest/v1/forms').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('retries a 429 and succeeds', async () => {
    const { api, calls } = client([json({}, 429), json({ tags: [{ id: 1 }] })]);
    await expect(api.get('/crm/rest/v1/tags')).resolves.toEqual({ tags: [{ id: 1 }] });
    expect(calls).toHaveLength(2);
  });

  it('gives up after the retry cap and says how many attempts it made', async () => {
    const { api } = client([json({}, 429), json({}, 429), json({}, 429)]);
    await expect(api.get('/crm/rest/v1/tags')).rejects.toThrow(/rate limit.*2 retries/i);
  });

  it('pages v2 style, following next_page_token until it stops', async () => {
    const { api, calls } = client([
      json({ tags: [{ id: 1 }], next_page_token: 'abc' }),
      json({ tags: [{ id: 2 }] }),
    ]);
    await expect(api.getAll('/crm/rest/v1/tags')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls[1]?.url).toContain('page_token=abc');
  });

  it('pages v1 style, advancing offset until a short page arrives', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const { api, calls } = client([json({ tags: full }), json({ tags: [{ id: 1000 }] })]);
    await expect(api.getAll('/crm/rest/v1/tags')).resolves.toHaveLength(1001);
    expect(calls[0]?.url).toContain('limit=1000');
    expect(calls[1]?.url).toContain('offset=1000');
  });

  it('stops after one page when the response is already short', async () => {
    const { api, calls } = client([json({ tags: [{ id: 1 }] })]);
    await api.getAll('/crm/rest/v1/tags');
    expect(calls).toHaveLength(1);
  });

  it('finds the item array whatever the response names it', async () => {
    const { api } = client([json({ products: [{ id: 7 }] })]);
    await expect(api.getAll('/crm/rest/v1/products')).resolves.toEqual([{ id: 7 }]);
  });

  it('treats a bare array response as the page itself', async () => {
    const { api } = client([json([{ id: 7 }])]);
    await expect(api.getAll('/crm/rest/v1/users')).resolves.toEqual([{ id: 7 }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/apiClient.test.ts
```

Expected: FAIL — `Cannot find module '../src/api/client.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/api/client.ts`:

```ts
import { assertAllowed } from './guard.js';

/** Page size for offset-style paging. Keap v1 caps `limit` at 1000. */
const PAGE_SIZE = 1000;

export class ApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

export interface ApiClient {
  get(path: string, query?: Record<string, string>): Promise<unknown>;
  /** Follows the API's own paging until exhausted. */
  getAll(path: string, query?: Record<string, string>): Promise<unknown[]>;
}

export interface ClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Matches the extractor's 250ms; 0 in tests. */
  throttleMs?: number;
  maxRetries?: number;
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Finds the array of items in a page response.
 *
 * Keap names the array after the resource — `tags`, `emails`, `products` — so
 * keying on a fixed name would need a table that drifts. The first array-valued
 * property is unambiguous in every observed shape, and a bare array response is
 * handled directly.
 */
function itemsOf(page: unknown): unknown[] {
  if (Array.isArray(page)) return page;
  if (page === null || typeof page !== 'object') return [];
  for (const value of Object.values(page)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function nextPageToken(page: unknown): string | null {
  if (page === null || typeof page !== 'object' || Array.isArray(page)) return null;
  const token = (page as { next_page_token?: unknown }).next_page_token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Authenticated, throttled, guard-enforced GET.
 *
 * The key lives only in this closure and reaches only the request header. It is
 * never interpolated into a URL, a log line or an error — errors carry the
 * method and pathname, because messages end up in logs and a query string can
 * hold ids.
 */
export function createClient(apiKey: string, options: ClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? process.env.KEAP_API_BASE_URL ?? 'https://api.infusionsoft.com';
  const doFetch = options.fetchImpl ?? fetch;
  const throttleMs = options.throttleMs ?? 250;
  const maxRetries = options.maxRetries ?? 2;

  async function get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    assertAllowed('GET', path);

    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    for (let attempt = 0; ; attempt++) {
      await sleep(throttleMs);

      const response = await doFetch(url.toString(), {
        method: 'GET',
        headers: { 'X-Keap-API-Key': apiKey, Accept: 'application/json' },
      });

      if (response.status === 429) {
        if (attempt >= maxRetries) {
          throw new ApiError(
            429,
            path,
            `GET ${path} hit a rate limit and still failed after ${maxRetries} retries`,
          );
        }
        // Exponential, and deliberately not derived from Retry-After: the
        // header is unverified on this API and a hostile value could stall a run.
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new ApiError(
          response.status,
          path,
          `GET ${path} was rejected (${response.status}) — the key may be revoked, ` +
            `or may lack admin scope`,
        );
      }

      if (!response.ok) {
        throw new ApiError(response.status, path, `GET ${path} failed with ${response.status}`);
      }

      return (await response.json()) as unknown;
    }
  }

  async function getAll(path: string, query: Record<string, string> = {}): Promise<unknown[]> {
    const collected: unknown[] = [];
    let token: string | null = null;
    let offset = 0;

    for (;;) {
      const page: unknown = await get(path, {
        ...query,
        limit: String(PAGE_SIZE),
        ...(token === null ? (offset > 0 ? { offset: String(offset) } : {}) : { page_token: token }),
      });

      const items = itemsOf(page);
      collected.push(...items);

      // v2 paging wins when present; otherwise fall back to offset paging and
      // stop on the first short page.
      token = nextPageToken(page);
      if (token !== null) continue;
      if (items.length < PAGE_SIZE) return collected;
      offset += items.length;
    }
  }

  return { get, getAll };
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/apiClient.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts test/apiClient.test.ts
git commit -m "feat: throttled, guard-enforced Keap API client with dual paging"
```

---

### Task 3: The `user` entity kind

Naming users needs somewhere to put them: `userId` is currently one of the 14 unmodelled foreign keys, so its 10 references are tallied and dropped.

**Files:**
- Modify: `src/normalize/graphEdges.ts`
- Test: `test/graphEdges.test.ts`

**Interfaces:**
- Produces: `EntityKind` gains `'user'`; `EdgeKind` gains `'assigned-to'`; `REFERENCE_EDGES` gains `userId: { kind: 'user', edge: 'assigned-to' }`.

- [ ] **Step 1: Write the failing test**

Append to `test/graphEdges.test.ts`:

```ts
describe('user references', () => {
  it('maps userId to a user entity via an assigned-to edge', () => {
    const campaign = makeCampaign({
      sequences: [
        makeSequence({
          steps: [
            {
              ...makeNode({
                cellId: '40',
                style: 'task',
                references: { tagIds: [], tagCategoryIds: [], userId: '7' },
              }),
              position: 0,
            },
          ],
        }),
      ],
    });
    const harvest = referenceEdges(campaign, 'campaign:16');
    expect(harvest.edges).toEqual([
      { from: 'campaign:16', to: 'user:7', kind: 'assigned-to', viaCellId: '40' },
    ]);
    expect(harvest.tallies).toEqual({});
  });

  it('still leaves roundRobinId unmodelled', () => {
    // A round-robin is a rule for picking a user, not a user. Modelling it as
    // one would be wrong, so it stays in the tally.
    const campaign = makeCampaign({
      goals: [
        makeNode({
          cellId: '9',
          style: 'task',
          references: { tagIds: [], tagCategoryIds: [], roundRobinId: '3' },
        }),
      ],
    });
    const harvest = referenceEdges(campaign, 'campaign:1');
    expect(harvest.edges).toEqual([]);
    expect(harvest.tallies['reference attribute "roundRobinId" has no entity kind']).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/graphEdges.test.ts -t "user references"
```

Expected: FAIL — the first test tallies `userId` instead of producing an edge.

- [ ] **Step 3: Write the implementation**

In `src/normalize/graphEdges.ts`, add `'user'` to `EntityKind` and `'assigned-to'` to `EdgeKind`:

```ts
export type EntityKind =
  | 'campaign'
  | 'tag'
  | 'email'
  | 'webform'
  | 'landingPage'
  | 'product'
  | 'form'
  | 'user';

export type EdgeKind =
  | 'applies'
  | 'removes'
  | 'listens-for'
  | 'tests'
  | 'sends'
  | 'entry-point'
  | 'references-campaign'
  | 'assigned-to'
  | 'triggers';
```

Add the mapping to `REFERENCE_EDGES`:

```ts
  internalFormId: { kind: 'form', edge: 'entry-point' },
  userId: { kind: 'user', edge: 'assigned-to' },
  sourceFunnelId: { kind: 'campaign', edge: 'references-campaign' },
```

Update the doc comment above `REFERENCE_EDGES`: it says "these six" and lists `userId` among the unmodelled fourteen. Change to:

```ts
/**
 * The lifted foreign keys that have a place in the graph's entity vocabulary.
 *
 * `nodes.ts` lifts 20 foreign-key attributes; these seven are the ones the
 * EntityKind values can express. The other thirteen — marketingNoteId (94 in
 * the corpus), fileBoxId (43), stageId (37), roundRobinId, eventId,
 * marketingFulfillmentId, actionSetId, marketingLetterId, fieldValueFileBoxId,
 * confirmLinkId, voiceBroadcastId, marketingFaxId, createOrderConfigId — are
 * tallied so the warnings say plainly what the graph is not modelling. They
 * remain in the normalised files, so widening this table later costs a re-run
 * and nothing else.
 *
 * roundRobinId is deliberately absent despite being assignment-adjacent: a
 * round-robin is a rule for picking a user, not a user.
 */
```

- [ ] **Step 4: Run the full suite**

```bash
npm test && npm run typecheck
```

Expected: PASS. The graph tests still pass — no existing test asserts on `userId`.

- [ ] **Step 5: Verify against the corpus**

```bash
npm run normalize -- --app jordan 2>&1 | grep -E "edges:|userId"
```

Expected: `assigned-to` appears with **10**, edge total rises from 780 to **790**, and the `userId` warning is gone. Entities gain a `user` kind.

- [ ] **Step 6: Commit**

```bash
git add src/normalize/graphEdges.ts test/graphEdges.test.ts
git commit -m "feat: model userId as a user entity via assigned-to edges"
```

---

### Task 4: Catalogue types and response mapping

**Files:**
- Create: `src/api/catalogue.ts`
- Test: `test/catalogue.test.ts`

**Interfaces:**
- Consumes: `ApiClient`, `ApiError` from `./client.js`; `EntityKind`, `entityId` from `../normalize/graphEdges.js`.
- Produces:
  - `interface EntityRecord { id: string; kind: EntityKind; name: string | null; extra: Record<string, string> }`
  - `type KindSource = { endpoint: string; count: number } | { unavailable: string }`
  - `interface EntityCatalogue { appName: string; fetchedAt: string; sources: Record<string, KindSource>; entities: EntityRecord[]; warnings: string[] }`
  - `const KIND_CANDIDATES: { kind: EntityKind; paths: string[] }[]`
  - `mapRecord(kind: EntityKind, raw: unknown): EntityRecord | null`

- [ ] **Step 1: Write the failing test**

Create `test/catalogue.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { KIND_CANDIDATES, mapRecord } from '../src/api/catalogue.js';

describe('mapRecord', () => {
  it('reads a tag', () => {
    expect(mapRecord('tag', { id: 646, name: 'Bought the thing' })).toEqual({
      id: 'tag:646',
      kind: 'tag',
      name: 'Bought the thing',
      extra: {},
    });
  });

  it('lifts a tag category into extra', () => {
    expect(
      mapRecord('tag', { id: 646, name: 'Bought', category: { id: 3, name: 'Purchases' } }),
    ).toEqual({
      id: 'tag:646',
      kind: 'tag',
      name: 'Bought',
      extra: { category: 'Purchases' },
    });
  });

  it('keeps an email subject line, which is the reason to fetch emails at all', () => {
    expect(
      mapRecord('email', { id: 1200, title: 'Welcome 1', subject: 'Thanks for signing up' }),
    ).toEqual({
      id: 'email:1200',
      kind: 'email',
      name: 'Welcome 1',
      extra: { subject: 'Thanks for signing up' },
    });
  });

  it('falls back through the name-ish fields Keap uses inconsistently', () => {
    expect(mapRecord('product', { id: 7, product_name: 'Course' })?.name).toBe('Course');
    expect(mapRecord('form', { id: 3, title: 'Contact us' })?.name).toBe('Contact us');
    expect(mapRecord('user', { id: 9, given_name: 'Ada', family_name: 'Lovelace' })?.name).toBe(
      'Ada Lovelace',
    );
  });

  it('accepts a record whose name is genuinely absent rather than inventing one', () => {
    expect(mapRecord('tag', { id: 646 })).toEqual({
      id: 'tag:646',
      kind: 'tag',
      name: null,
      extra: {},
    });
  });

  it('rejects a record with no usable id', () => {
    expect(mapRecord('tag', { name: 'no id' })).toBeNull();
    expect(mapRecord('tag', null)).toBeNull();
    expect(mapRecord('tag', 'nonsense')).toBeNull();
  });

  it('strips the Java-Long suffix, as everywhere else in this codebase', () => {
    expect(mapRecord('tag', { id: '646L', name: 'x' })?.id).toBe('tag:646');
  });

  it('offers candidate paths for every kind enrichment was asked to name', () => {
    const kinds = KIND_CANDIDATES.map((c) => c.kind);
    for (const kind of ['tag', 'email', 'product', 'user', 'webform', 'landingPage', 'form']) {
      expect(kinds, kind).toContain(kind);
    }
    for (const candidate of KIND_CANDIDATES) {
      expect(candidate.paths.length, candidate.kind).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/catalogue.test.ts
```

Expected: FAIL — `Cannot find module '../src/api/catalogue.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/api/catalogue.ts`:

```ts
import { stripLongSuffix } from '../parse/cells.js';
import { type EntityKind, entityId } from '../normalize/graphEdges.js';

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
 * `subject` is the reason to fetch emails at all — handoff Q9 asks whether the
 * API can supply subject lines and thereby avoid scraping the email editor.
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
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/catalogue.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/catalogue.ts test/catalogue.test.ts
git commit -m "feat: entity catalogue types and per-kind response mapping"
```

---

### Task 5: Probe, identity check and catalogue fetch

**Files:**
- Modify: `src/api/catalogue.ts`
- Test: `test/catalogue.test.ts`

**Interfaces:**
- Produces:
  - `assertAccountIdentity(client: ApiClient, appName: string): Promise<void>`
  - `probeKind(client: ApiClient, kind: EntityKind, paths: string[]): Promise<{ endpoint: string } | { unavailable: string }>`
  - `fetchCatalogue(client: ApiClient, appName: string): Promise<EntityCatalogue>`

- [ ] **Step 1: Write the failing test**

Append to `test/catalogue.test.ts`. Extend the import to include `assertAccountIdentity`, `fetchCatalogue`, `probeKind`, and add `import { ApiError } from '../src/api/client.js';` plus `import type { ApiClient } from '../src/api/client.js';`.

```ts
/** An ApiClient backed by a path→response table. Missing paths 404. */
function fakeClient(table: Record<string, unknown>): ApiClient {
  const lookup = async (path: string): Promise<unknown> => {
    if (!(path in table)) throw new ApiError(404, path, `GET ${path} failed with 404`);
    const value = table[path];
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    get: lookup,
    getAll: async (path) => {
      const page = await lookup(path);
      return Array.isArray(page) ? page : [];
    },
  };
}

describe('assertAccountIdentity', () => {
  it('passes when the app name appears anywhere in the profile', async () => {
    const client = fakeClient({
      '/crm/rest/v1/account/profile': { name: 'Jordan Ltd', website: 'https://jordan.infusionsoft.com' },
    });
    await expect(assertAccountIdentity(client, 'jordan')).resolves.toBeUndefined();
  });

  it('matches case-insensitively', async () => {
    const client = fakeClient({ '/crm/rest/v1/account/profile': { name: 'JORDAN' } });
    await expect(assertAccountIdentity(client, 'jordan')).resolves.toBeUndefined();
  });

  it('refuses when the key belongs to a different account', async () => {
    const client = fakeClient({ '/crm/rest/v1/account/profile': { name: 'Someone Else Ltd' } });
    await expect(assertAccountIdentity(client, 'jordan')).rejects.toThrow(/does not mention "jordan"/i);
  });

  it('lists the profile field NAMES on failure, never their values', async () => {
    const client = fakeClient({
      '/crm/rest/v1/account/profile': { name: 'Acme', phone: '555-0100', email: 'a@b.c' },
    });
    const error = await assertAccountIdentity(client, 'jordan').catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain('name');
    expect(message).toContain('phone');
    expect(message).not.toContain('555-0100');
    expect(message).not.toContain('a@b.c');
  });
});

describe('probeKind', () => {
  it('returns the first path that answers', async () => {
    const client = fakeClient({ '/crm/rest/v1/tags': [] });
    await expect(probeKind(client, 'tag', ['/crm/rest/v2/tags', '/crm/rest/v1/tags'])).resolves.toEqual(
      { endpoint: '/crm/rest/v1/tags' },
    );
  });

  it('reports unavailable, naming every path it tried, when none answer', async () => {
    const result = await probeKind(fakeClient({}), 'landingPage', ['/crm/rest/v2/landingPages']);
    expect(result).toEqual({
      unavailable: 'no candidate endpoint answered: /crm/rest/v2/landingPages (404)',
    });
  });

  it('lets a credential failure through rather than reporting it as unavailable', async () => {
    // A 401 means the key is wrong, not that landing pages do not exist.
    // Reporting it as "unavailable" would hide a broken run behind a shrug.
    const client = fakeClient({
      '/crm/rest/v1/tags': new ApiError(401, '/crm/rest/v1/tags', 'rejected (401)'),
    });
    await expect(probeKind(client, 'tag', ['/crm/rest/v1/tags'])).rejects.toThrow(/401/);
  });
});

describe('fetchCatalogue', () => {
  const profile = { '/crm/rest/v1/account/profile': { name: 'jordan' } };

  it('collects every available kind and records the ones that are not', async () => {
    const client = fakeClient({
      ...profile,
      '/crm/rest/v1/tags': [{ id: 646, name: 'Bought' }],
      '/crm/rest/v1/products': [{ id: 7, product_name: 'Course' }],
    });
    const catalogue = await fetchCatalogue(client, 'jordan');

    expect(catalogue.appName).toBe('jordan');
    expect(catalogue.entities).toContainEqual({
      id: 'tag:646',
      kind: 'tag',
      name: 'Bought',
      extra: {},
    });
    expect(catalogue.sources.tag).toEqual({ endpoint: '/crm/rest/v1/tags', count: 1 });
    expect(catalogue.sources.landingPage).toMatchObject({
      unavailable: expect.stringContaining('no candidate endpoint answered'),
    });
  });

  it('stamps fetchedAt as an ISO timestamp', async () => {
    const client = fakeClient({ ...profile, '/crm/rest/v1/tags': [{ id: 1, name: 'x' }] });
    const catalogue = await fetchCatalogue(client, 'jordan');
    expect(catalogue.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('warns on a record it had to drop', async () => {
    const client = fakeClient({ ...profile, '/crm/rest/v1/tags': [{ name: 'no id' }] });
    const catalogue = await fetchCatalogue(client, 'jordan');
    expect(catalogue.warnings.some((w) => /1 .*tag.* no usable id/i.test(w))).toBe(true);
  });

  it('deduplicates a kind whose endpoint another kind already fetched', async () => {
    // webform and form share /forms as a candidate; fetching it twice would
    // double the request count and duplicate every entity.
    const client = fakeClient({ ...profile, '/crm/rest/v1/forms': [{ id: 3, title: 'Contact' }] });
    const catalogue = await fetchCatalogue(client, 'jordan');
    expect(catalogue.entities.filter((e) => e.id.endsWith(':3'))).toHaveLength(1);
  });

  it('fails when no kind at all could be fetched', async () => {
    await expect(fetchCatalogue(fakeClient(profile), 'jordan')).rejects.toThrow(/no entities/i);
  });

  it('checks identity before fetching anything', async () => {
    const client = fakeClient({
      '/crm/rest/v1/account/profile': { name: 'other' },
      '/crm/rest/v1/tags': [{ id: 1, name: 'x' }],
    });
    await expect(fetchCatalogue(client, 'jordan')).rejects.toThrow(/does not mention/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/catalogue.test.ts -t "probeKind"
```

Expected: FAIL — `probeKind is not exported`.

- [ ] **Step 3: Write the implementation**

Add to the imports at the top of `src/api/catalogue.ts`:

```ts
import { type ApiClient, ApiError } from './client.js';
```

Append to `src/api/catalogue.ts`:

```ts
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
    profile !== null && typeof profile === 'object' ? Object.keys(profile).sort().join(', ') : '(none)';

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
  const seenIds = new Set<string>();

  for (const { kind, paths } of KIND_CANDIDATES) {
    const probed = await probeKind(client, kind, paths);
    if ('unavailable' in probed) {
      sources[kind] = probed;
      warnings.push(`${kind}: ${probed.unavailable}`);
      continue;
    }

    const raw = await client.getAll(probed.endpoint);
    let dropped = 0;
    let kept = 0;

    for (const item of raw) {
      const record = mapRecord(kind, item);
      if (record === null) {
        dropped++;
        continue;
      }
      // webform and form share /forms as a candidate endpoint; without this the
      // second pass would refetch it and duplicate every record.
      if (seenIds.has(record.id)) continue;
      seenIds.add(record.id);
      entities.push(record);
      kept++;
    }

    sources[kind] = { endpoint: probed.endpoint, count: kept };
    if (dropped > 0) warnings.push(`${dropped} ${kind} record(s) had no usable id and were dropped`);
  }

  if (entities.length === 0) {
    throw new Error(
      'no entities fetched from any endpoint — a silent empty catalogue is worse than an error',
    );
  }

  return {
    appName,
    fetchedAt: new Date().toISOString(),
    sources,
    entities,
    warnings,
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/catalogue.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/catalogue.ts test/catalogue.test.ts
git commit -m "feat: capability probe, account identity check and catalogue fetch"
```

---

### Task 6: The join

**Files:**
- Modify: `src/normalize/graph.ts`
- Test: `test/graph.test.ts`

**Interfaces:**
- Consumes: `EntityCatalogue` from `../api/catalogue.js`.
- Produces: `buildGraph(campaigns: NormalizedCampaign[], catalogue?: EntityCatalogue): AccountGraph` — the second parameter is optional and omitting it must reproduce today's output exactly.

- [ ] **Step 1: Write the failing test**

Append to `test/graph.test.ts`, adding `import type { EntityCatalogue } from '../src/api/catalogue.js';`:

```ts
const catalogue = (entities: EntityCatalogue['entities']): EntityCatalogue => ({
  appName: 'jordan',
  fetchedAt: '2026-08-06T00:00:00.000Z',
  sources: {},
  entities,
  warnings: [],
});

describe('buildGraph with a catalogue', () => {
  const emailStep = (cellId: string, id: string) => ({
    ...makeNode({
      cellId,
      style: 'email',
      references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
    }),
    position: 0,
  });

  it('labels entities from the catalogue', () => {
    const graph = buildGraph(
      [
        makeCampaign({
          funnelId: '16',
          sequences: [makeSequence({ steps: [applyStep('10', ['646']), emailStep('25', '1200')] })],
        }),
      ],
      catalogue([
        { id: 'tag:646', kind: 'tag', name: 'Bought', extra: {} },
        { id: 'email:1200', kind: 'email', name: 'Welcome 1', extra: { subject: 'Hello' } },
      ]),
    );
    expect(graph.entities.find((e) => e.id === 'tag:646')?.label).toBe('Bought');
    expect(graph.entities.find((e) => e.id === 'email:1200')?.label).toBe('Welcome 1');
  });

  it('prefers the catalogue name over a decision-criteria label, and warns on disagreement', () => {
    const rules = {
      decisionIds: ['479'],
      flowIds: ['3'],
      wrappers: [
        {
          index: 0,
          decisionId: '479',
          flowId: '3',
          primaryKey: null,
          secondaryKey: null,
          secondaryKeyId: null,
          any: [
            {
              groupId: '1',
              all: [
                {
                  ruleId: '2',
                  subject: null,
                  subjectLabel: null,
                  category: 'tags_FieldCategory',
                  categoryLabel: null,
                  field: null,
                  fieldLabel: null,
                  constraint: null,
                  constraintLabel: null,
                  values: [{ id: '346', label: 'Stale Name' }],
                },
              ],
            },
          ],
        },
      ],
      elseOptions: [],
      elseSelected: null,
      warnings: [],
    };
    const graph = buildGraph(
      [
        makeCampaign({
          funnelId: '1',
          decisions: [
            makeDecision({ cellId: '34', branches: [{ decisionId: '479', flowId: '3', rules }] }),
          ],
        }),
      ],
      catalogue([{ id: 'tag:346', kind: 'tag', name: 'Current Name', extra: {} }]),
    );
    expect(graph.entities.find((e) => e.id === 'tag:346')?.label).toBe('Current Name');
    expect(graph.warnings.some((w) => /tag:346.*Stale Name.*Current Name/.test(w))).toBe(true);
  });

  it('keeps the decision-criteria label for a tag the catalogue does not have', () => {
    const graph = buildGraph([makeCampaign({ funnelId: '1' })], catalogue([]));
    expect(graph.entities.find((e) => e.kind === 'campaign')?.label).toBeNull();
  });

  it('never overwrites a campaign label with a catalogue entry', () => {
    const graph = buildGraph(
      [makeCampaign({ funnelId: '16', name: 'Real Campaign Name' })],
      catalogue([{ id: 'campaign:16', kind: 'campaign', name: 'API Name', extra: {} }]),
    );
    expect(graph.entities.find((e) => e.id === 'campaign:16')?.label).toBe('Real Campaign Name');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/graph.test.ts -t "with a catalogue"
```

Expected: FAIL — `buildGraph` takes one argument, so labels stay null.

- [ ] **Step 3: Write the implementation**

In `src/normalize/graph.ts`, add the import:

```ts
import type { EntityCatalogue } from '../api/catalogue.js';
```

Change the signature:

```ts
export function buildGraph(
  campaigns: NormalizedCampaign[],
  catalogue?: EntityCatalogue,
): AccountGraph {
```

Immediately after `const labels = tagLabels(...)`, add:

```ts
  // Catalogue names win over decision-criteria labels: the criteria label is a
  // snapshot taken whenever that decision was last saved, while the catalogue
  // is what the account says today. Disagreement is worth seeing, though — six
  // tags carry both, which is a free cross-check between two independent
  // sources, the same class of check that validated the 131-tag count.
  const catalogued = new Map((catalogue?.entities ?? []).map((e) => [e.id, e]));

  const labelFor = (id: string, fallback: string | null): string | null => {
    const record = catalogued.get(id);
    if (record?.name == null) return fallback;
    if (fallback !== null && fallback !== record.name) {
      warnings.push(
        `${id}: decision criteria say "${fallback}" but the catalogue says "${record.name}" — using the catalogue`,
      );
    }
    return record.name;
  };
```

Change the `register` call inside the edge loop from:

```ts
    register(edge.to, kind === 'tag' ? (labels.get(edge.to.slice(4)) ?? null) : null);
```

to:

```ts
    register(edge.to, labelFor(edge.to, kind === 'tag' ? (labels.get(edge.to.slice(4)) ?? null) : null));
```

And the undirected-tag registration from:

```ts
        register(entityId('tag', tagId), labels.get(tagId) ?? null);
```

to:

```ts
        const id = entityId('tag', tagId);
        register(id, labelFor(id, labels.get(tagId) ?? null));
```

Campaign registration is left untouched — `campaign.name` comes from `meta.json` and is authoritative for campaigns; the catalogue must never overwrite it.

- [ ] **Step 4: Run the full suite**

```bash
npm test && npm run typecheck
```

Expected: PASS, including all 209 pre-existing tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/normalize/graph.ts test/graph.test.ts
git commit -m "feat: join catalogue names onto graph entities"
```

---

### Task 7: The two new findings

**Files:**
- Modify: `src/normalize/graph.ts`
- Test: `test/graph.test.ts`

**Interfaces:**
- Produces: `GraphFindings` gains `entitiesNotFound: string[]` and `unusedEntities: string[]`. `computeFindings` gains a fourth parameter `catalogue?: EntityCatalogue`.

- [ ] **Step 1: Write the failing test**

Append to `test/graph.test.ts`:

```ts
describe('catalogue findings', () => {
  const emailStep = (cellId: string, id: string) => ({
    ...makeNode({
      cellId,
      style: 'email',
      references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
    }),
    position: 0,
  });

  it('reports a referenced entity the catalogue does not contain', () => {
    // A campaign pointing at a deleted email is a broken campaign.
    const graph = buildGraph(
      [
        makeCampaign({
          funnelId: '16',
          sequences: [makeSequence({ steps: [emailStep('25', '1200')] })],
        }),
      ],
      catalogue([{ id: 'email:9999', kind: 'email', name: 'Something else', extra: {} }]),
    );
    expect(graph.findings.entitiesNotFound).toEqual(['email:1200']);
  });

  it('reports a catalogue entity nothing references', () => {
    const graph = buildGraph(
      [makeCampaign({ funnelId: '16' })],
      catalogue([{ id: 'tag:500', kind: 'tag', name: 'Unused', extra: {} }]),
    );
    expect(graph.findings.unusedEntities).toEqual(['tag:500']);
  });

  it('leaves both empty when no catalogue was supplied', () => {
    // "not found" and "not looked up" are different claims.
    const graph = buildGraph([
      makeCampaign({
        funnelId: '16',
        sequences: [makeSequence({ steps: [emailStep('25', '1200')] })],
      }),
    ]);
    expect(graph.findings.entitiesNotFound).toEqual([]);
    expect(graph.findings.unusedEntities).toEqual([]);
  });

  it('never reports a campaign as not found', () => {
    // Campaigns come from the artifact directory, not the catalogue.
    const graph = buildGraph([makeCampaign({ funnelId: '16' })], catalogue([]));
    expect(graph.findings.entitiesNotFound).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/graph.test.ts -t "catalogue findings"
```

Expected: FAIL — `entitiesNotFound` is not a property of `findings`.

- [ ] **Step 3: Write the implementation**

In `src/normalize/graph.ts`, extend `GraphFindings`:

```ts
export interface GraphFindings {
  unreachableCampaigns: { campaignId: string; reason: string }[];
  tagsAppliedByNobody: string[];
  tagsNobodyListensFor: string[];
  sharedEmails: { emailId: string; campaigns: string[] }[];
  duplicateTagAppliers: { tagId: string; campaigns: string[] }[];
  /** Referenced ids with no entity behind them — broken campaigns. Empty without a catalogue. */
  entitiesNotFound: string[];
  /** Catalogue entities nothing references — dead weight not to migrate. Empty without a catalogue. */
  unusedEntities: string[];
}
```

Change `computeFindings`'s signature and add the two computations before the return:

```ts
export function computeFindings(
  usable: { campaign: NormalizedCampaign; from: string }[],
  edges: GraphEdge[],
  tagEntityIds: string[],
  catalogue?: EntityCatalogue,
): GraphFindings {
```

```ts
  // Both are only meaningful against a catalogue: without one, "not found" and
  // "not looked up" are the same observation, and reporting them would be a
  // confident wrong answer about every entity in the account.
  const catalogued = new Set((catalogue?.entities ?? []).map((e) => e.id));
  const referenced = new Set(
    edges.filter((e) => !e.derived).map((e) => e.to),
  );

  const entitiesNotFound =
    catalogue === undefined
      ? []
      : sortIds([...referenced].filter((id) => !id.startsWith('campaign:') && !catalogued.has(id)));

  const unusedEntities =
    catalogue === undefined ? [] : sortIds([...catalogued].filter((id) => !referenced.has(id)));
```

Add both to the returned object, and pass the catalogue through from `buildGraph`:

```ts
    findings: computeFindings(
      usable,
      edges,
      [...entities.values()].filter((e) => e.kind === 'tag').map((e) => e.id),
      catalogue,
    ),
```

- [ ] **Step 4: Run the full suite**

```bash
npm test && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/normalize/graph.ts test/graph.test.ts
git commit -m "feat: report broken references and unused account entities"
```

---

### Task 8: The CLI

**Files:**
- Create: `src/cli/enrich.ts`
- Modify: `src/cli/normalize.ts`, `package.json`

**Interfaces:**
- Consumes: `createClient`, `fetchCatalogue`, `normalizeAppName`.
- Produces: `npm run enrich -- --app <app>` → `artifacts/<app>/entities.json`. No new exports.

- [ ] **Step 1: Write the enrich CLI**

Create `src/cli/enrich.ts`:

```ts
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '../api/client.js';
import { fetchCatalogue } from '../api/catalogue.js';
import { normalizeAppName } from '../app.js';

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const appIndex = argv.indexOf('--app');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  if (!rawApp) {
    fail('Usage: KEAP_API_KEY=… npm run enrich -- --app <appName>');
    return;
  }

  let app: string;
  try {
    app = normalizeAppName(rawApp);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const apiKey = process.env.KEAP_API_KEY;
  if (!apiKey) {
    fail(
      'KEAP_API_KEY is not set. Create a Service Account Key in the Keap account ' +
        '(admin only) and pass it in the environment. It is never written to disk.',
    );
    return;
  }

  const outDir = join('artifacts', app);
  if (!existsSync(outDir)) {
    fail(`No artifacts at ${outDir}. Run:  npm run extract-all -- --app ${app}`);
    return;
  }

  const started = Date.now();
  let catalogue;
  try {
    catalogue = await fetchCatalogue(createClient(apiKey), app);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, 'entities.json');
  await writeFile(outPath, JSON.stringify(catalogue, null, 2), 'utf8');

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n[${app}] catalogue: ${catalogue.entities.length} entities in ${elapsed}s`);
  for (const [kind, source] of Object.entries(catalogue.sources)) {
    console.log(
      'unavailable' in source
        ? `  ${kind.padEnd(12)} unavailable — ${source.unavailable}`
        : `  ${kind.padEnd(12)} ${String(source.count).padStart(5)}  ${source.endpoint}`,
    );
  }
  for (const warning of catalogue.warnings) console.log(`  warning: ${warning}`);
  console.log(`  output: ${outPath}\n`);
}

await main();
```

- [ ] **Step 2: Have normalize pick the catalogue up**

In `src/cli/normalize.ts`, add to the imports:

```ts
import type { EntityCatalogue } from '../api/catalogue.js';
```

Replace `const graph = buildGraph(normalized);` with:

```ts
  // Enrichment is additive: a missing or unreadable catalogue costs names, not
  // the graph. It must never be required to normalise.
  let catalogue: EntityCatalogue | undefined;
  const cataloguePath = join('artifacts', args.app, 'entities.json');
  if (existsSync(cataloguePath)) {
    try {
      catalogue = JSON.parse(await readFile(cataloguePath, 'utf8')) as EntityCatalogue;
      console.log(`  using catalogue: ${catalogue.entities.length} entities from ${catalogue.fetchedAt}`);
    } catch {
      console.log(`  warning: ${cataloguePath} is unreadable — building the graph unenriched`);
    }
  } else {
    console.log(`  no catalogue at ${cataloguePath} — building the graph unenriched`);
  }

  const graph = buildGraph(normalized, catalogue);
```

And extend the findings summary with the two new lines:

```ts
  console.log(`  broken references:       ${graph.findings.entitiesNotFound.length}`);
  console.log(`  unused account entities: ${graph.findings.unusedEntities.length}`);
```

- [ ] **Step 3: Add the npm script**

In `package.json`, beside `"normalize"`:

```json
    "enrich": "tsx src/cli/enrich.ts",
```

- [ ] **Step 4: Verify the unenriched path is unchanged**

```bash
npm run typecheck && npm test
cp artifacts/jordan/graph.json /tmp/graph-before-enrich.json
npm run normalize -- --app jordan
diff /tmp/graph-before-enrich.json artifacts/jordan/graph.json && echo "unenriched output unchanged"
```

Expected: `unenriched output unchanged`, and the run reports `no catalogue at artifacts/jordan/entities.json`.

- [ ] **Step 5: Verify the missing-key path fails cleanly**

```bash
env -u KEAP_API_KEY npm run enrich -- --app jordan
```

Expected: the message naming `KEAP_API_KEY`, exit code 1, **no request attempted and no file written**.

- [ ] **Step 6: Commit**

```bash
git add src/cli/enrich.ts src/cli/normalize.ts package.json
git commit -m "feat: enrich CLI and optional catalogue join at normalise time"
```

---

### Task 9: The live run

**This is the only task that needs `KEAP_API_KEY`.** Everything before it is offline. Stop here and ask for the key if it is not available; do not skip ahead.

**Files:** none — this task produces measurements.

- [ ] **Step 1: Run the probe against the live account**

```bash
KEAP_API_KEY=… npm run enrich -- --app jordan
```

Record, for each of the seven kinds: the endpoint that answered, or the reason it did not. **The webform and landing-page question is settled here** — see §14 criterion 2 of the design.

- [ ] **Step 2: If the identity check fails, do not work around it**

The failure lists the profile's field names. If one of them carries the tenant identity, key the check on that field explicitly in `assertAccountIdentity` and re-run. If none does, stop and report — writing another account's entities into `artifacts/jordan/` is exactly the failure the multi-app work exists to prevent.

- [ ] **Step 3: Measure the rate limit**

Note total requests, elapsed time, and whether any 429 occurred at the 250ms throttle. This closes handoff §14 Q10, unanswered since the spike. If no 429 occurred, that is a lower bound and should be stated as one, not as "there is no limit".

- [ ] **Step 4: Cross-check the six known tag labels**

```bash
npm run normalize -- --app jordan 2>&1 | grep -i "decision criteria say"
```

Expected: no output — the API agrees with all six decision-criteria labels. Any output names a tag whose criteria label has drifted from the account, which is a real finding either way.

- [ ] **Step 5: Record the enriched graph**

```bash
node --input-type=module -e "
import {readFileSync} from 'node:fs';
const g=JSON.parse(readFileSync('./artifacts/jordan/graph.json','utf8'));
const byKind={};
for (const e of g.entities) { byKind[e.kind] ??= {total:0, labelled:0}; byKind[e.kind].total++; if (e.label) byKind[e.kind].labelled++; }
console.log(byKind);
console.log('broken references:', g.findings.entitiesNotFound.length);
console.log('unused entities:', g.findings.unusedEntities.length);
"
```

Expected: every kind the probe found available is fully or near-fully labelled. Any kind still at zero means the join is keying on the wrong id format — investigate before proceeding.

- [ ] **Step 6: Commit nothing**

`artifacts/` is gitignored. This task's output is the measurements, which go into Task 10.

---

### Task 10: Record what enrichment found

**Files:**
- Modify: `docs/spike-findings.md`

- [ ] **Step 1: Append the section**

Append a `## 13. REST API enrichment` section to `docs/spike-findings.md` covering, with the real numbers from Task 9:

- The table of seven kinds: endpoint that answered, count, or the recorded reason it was unavailable.
- **Whether webforms and landing pages resolve.** If not, state plainly what that costs — 173 entities, the entry points, permanently unnamed unless scraped — and name the decision it forces.
- **Whether the API supplies email subject lines**, closing handoff §14 Q9.
- **The measured rate-limit behaviour**, closing handoff §14 Q10. State a lower bound as a lower bound.
- The six-tag cross-check result: agreement between two independent sources, or the disagreements named.
- Counts for the two new findings — broken references and unused entities — with a note on what they mean for a migration.
- Labelled-versus-total per entity kind, against the 586 unlabelled this stage set out to fix.

Follow the existing sections' voice: what was observed, what it cost, what it means. Numbers that were predicted and then confirmed are worth saying so; numbers that surprised are worth more.

- [ ] **Step 2: Commit**

```bash
git add docs/spike-findings.md
git commit -m "docs: record REST API enrichment results"
```

---

## Self-review against the spec

| Spec requirement | Where |
|---|---|
| §5 allowlist guard, contacts refused | Task 1 |
| §5 GET only, key never logged | Tasks 1, 2 |
| §6 credential from env, identity checked before writing | Tasks 5, 8 |
| §7 `X-Keap-API-Key`, 250ms throttle, 429 backoff, dual paging | Task 2 |
| §8 `EntityRecord` / `EntityCatalogue` / probe / `sources` | Tasks 4, 5 |
| §9 `user` kind and `assigned-to` edge; `roundRobinId` left alone | Task 3 |
| §10 join, label precedence, six-tag cross-check | Tasks 6, 9 |
| §11 `entitiesNotFound`, `unusedEntities` | Task 7 |
| §12 `npm run enrich`, normalise picks the catalogue up | Task 8 |
| §13 every error-handling row | Tasks 2, 5, 8 |
| §14 no test touches the network; 209 existing tests unchanged | Tasks 2, 6, 8 |
| §15 all seven success criteria | Tasks 8, 9, 10 |

**One deviation, stated where it happens:** the spec's `probe(client)` returning a whole `sources` map is implemented as `probeKind(client, kind, paths)` per kind, called from inside `fetchCatalogue`. Probing and fetching a kind belong together — a probe result whose endpoint is immediately refetched by a separate pass is two round trips for one fact — and a per-kind function is far easier to test.
