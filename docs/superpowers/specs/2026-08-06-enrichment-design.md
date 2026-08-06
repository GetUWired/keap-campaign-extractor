# REST API Enrichment — Design

Date: 2026-08-06
Status: approved, ready for implementation planning
Builds on: `2026-08-06-normaliser-design.md`
Evidence: `docs/spike-findings.md` §12, and `artifacts/jordan/graph.json`

## 1. Context

The account relationship graph is built: 762 entities, 780 edges. **586 of those entities have no
name.** Every email, webform, landing page, product and form is a bare id, and so are 136 of the 142
tags — the six exceptions are labelled only because decision criteria happen to carry a `_text`
companion, the sole place a display name appears anywhere in the extracted data.

| Entity kind | Count | Unlabelled |
|---|---|---|
| campaign | 170 | 0 |
| email | 250 | 250 |
| tag | 142 | 136 |
| webform | 113 | 113 |
| landingPage | 60 | 60 |
| form | 16 | 16 |
| product | 11 | 11 |
| **user** | **0 — not yet an entity kind** | **10 references** |

`user` is the one kind in scope that the graph does not model yet. `userId` appears on 10 nodes —
task and assignment steps — and sits among the 14 lifted foreign keys with no entity kind. §9 adds
it.

A graph of numbered tags is analysable but not readable, and every downstream artifact — Mermaid
rendering, per-campaign prose, the live-versus-dead classification — inherits that. This is step 7
of the handoff's build order, and its standing rule: use the API for anything it can answer, and
scrape only for the depth it cannot.

## 2. Goal

Fetch the account's shared entities once, cache them as a flat catalogue, and join them onto the
graph by id.

## 3. Non-goals

- **Contact data of any kind.** The handoff's rule is that campaign structure contains zero contact
  data and it stays that way deliberately. §5 makes this structural rather than intentional.
- Rewriting the normalised campaign files. Ids stay ids there.
- Renderers, prose, live-versus-dead classification. Those consume this; they are not this.
- Resolving `formSubmissionOption3780`-style ids inside decision criteria. Those are form-scoped
  rather than account-level, and belong with whatever settles the `secondaryKey` question.

## 4. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where enrichment lands | A separate `entities.json`, joined at read time | Keeps the property that has been load-bearing since the spike: everything after extraction is a pure function over files on disk. Rewriting the normalised files would mean a re-run of `npm run normalize` silently strips every name. |
| Credential | `KEAP_API_KEY` from the environment, per run | Never written to disk by us, never logged. Same rule as the browser session, applied to a credential that is strictly more dangerous. |
| Guard shape | **Allowlist**, not denylist | `readonly.ts` learned this twice — `/Reports/` was uncovered, and `_publish.svg` was blocked for its filename. Over an admin-scoped key the risk is not a URL we thought of; it is the one we did not. |
| Endpoint discovery | Probe, do not assume | Every endpoint in this project was settled by running it. The docs pages are JS-rendered and neither API's published resource list mentions webforms or landing pages. |
| A kind the API cannot serve | Record and continue | One missing kind must not cost the other six. |
| Unresolvable ids | A finding, not a failure | A referenced id with no entity behind it is a broken campaign, and finding those is the point. |

## 5. Safety: the guard

A Service Account Key is **admin-created and grants access to all stored data**, including every
contact in the account. That is far broader than this work needs.

Today, "we never touch contact records" is guaranteed by `guard/readonly.ts` at the driver level.
The moment the process holds an admin API key, it is guaranteed by nothing but intention. So:

- **GET only.** No other method is constructible through the client.
- **Path must match an explicit allowlist.** Not a denylist. `/contacts` is not on it, and adding it
  means editing a file whose only purpose is to declare what may be read.
- **The key is never logged, never echoed, never written to an artifact.** Response bodies are
  mapped to `EntityRecord`s; raw responses are not stored.

```ts
// src/api/guard.ts
export function assertAllowed(method: string, path: string): void;
export const ALLOWED_PATHS: RegExp[];
```

An explicit test asserts that a contacts path is refused.

## 6. Credential and identity

The key is read from `KEAP_API_KEY`; the account is named with `--app`, as everywhere else.

**Identity is checked before anything is written.** The multi-app work defends against a session for
one tenant pointed at another tenant's artifacts directory; an admin API key has the same failure
mode and no `appName` in the payload to catch it. The enricher's first call resolves the account
profile and refuses to write `artifacts/<app>/entities.json` unless the key belongs to `<app>`.

On mismatch: a readable message, and **nothing written** — the same guarantee the session guard
already provides.

## 7. `src/api/client.ts`

```ts
export interface ApiClient {
  get(path: string, query?: Record<string, string>): Promise<unknown>;
  /** Follows the API's own paging until exhausted. */
  getAll(path: string, query?: Record<string, string>): Promise<unknown[]>;
}

export function createClient(apiKey: string, baseUrl?: string): ApiClient;
```

Header `X-Keap-API-Key` against `https://api.infusionsoft.com`, confirmed from Keap's developer
portal. Every call passes through `assertAllowed` first. Requests are throttled at 250ms, matching
the extractor, which moved 170 campaigns in 6.5 minutes without complaint.

Rate limits are unmeasured — handoff §14 Q10 has never been answered. On HTTP 429 the client backs
off and retries to a cap, then fails naming the kind and how far it got. **The first real run is the
measurement**, and its numbers go into `spike-findings.md`.

## 8. `src/api/catalogue.ts`

```ts
export interface EntityRecord {
  id: string;                     // "tag:646" — the graph's own id format
  kind: EntityKind;
  name: string | null;
  extra: Record<string, string>;  // subject line, category, status — whatever the kind offers
}

export interface KindSource {
  endpoint: string;
  count: number;
}

export interface EntityCatalogue {
  appName: string;
  fetchedAt: string;              // network data, so staleness is meaningful
  sources: Record<string, KindSource | { unavailable: string }>;
  entities: EntityRecord[];
  warnings: string[];
}

export function probe(client: ApiClient): Promise<Record<string, KindSource | { unavailable: string }>>;
export function fetchCatalogue(client: ApiClient, appName: string): Promise<EntityCatalogue>;
```

A capability probe runs first — one minimal call per kind — and records what this account can
actually answer. `sources` is where the webform and landing-page question gets answered in writing:
if the API cannot serve them, that is recorded as `unavailable` with the reason, rather than
silently producing 173 unlabelled entities and leaving a reader to wonder.

Response mapping is a pure function per kind, tested against recorded fixtures. `fetchedAt` makes
`entities.json` deliberately non-deterministic, unlike `graph.json` — it is a network snapshot and
its age matters.

## 9. One new entity kind: `user`

Naming users means the graph must first have somewhere to put them. `userId` is currently one of the
14 lifted foreign keys with no entity kind, so its 10 references are tallied as unmodelled and
dropped.

Three small additions in `graphEdges.ts`:

```ts
export type EntityKind = … | 'user';
export type EdgeKind   = … | 'assigned-to';

export const REFERENCE_EDGES = {
  …,
  userId: { kind: 'user', edge: 'assigned-to' },
};
```

Expected effect on the corpus: **10 `assigned-to` edges, and the `userId` warning disappears** from
the 14 unmodelled-attribute lines. This is the smallest possible widening of the vocabulary — it is
in scope only because a user entity is one of the four kinds enrichment was asked to name, and
naming an entity the graph does not have would be meaningless.

The other 13 unmodelled attributes stay unmodelled. `roundRobinId` (10 references) is
assignment-adjacent and tempting; it is deliberately left alone, because a round-robin is a rule for
picking a user rather than a user, and modelling it as one would be wrong.

## 10. The join

```ts
export function buildGraph(
  campaigns: NormalizedCampaign[],
  catalogue?: EntityCatalogue,
): AccountGraph;
```

Label precedence: **catalogue name, then the decision-criteria label, then null.** Enrichment is
additive — `buildGraph` with no catalogue behaves exactly as it does today, and the full test suite
must continue to pass unchanged.

**A free cross-validation.** Six tags are already labelled from decision criteria, an entirely
independent source. If the API agrees on all six, that is two code paths agreeing — the same class
of check that validated the 131-tag count against the raw XML survey. Where they disagree, the API
wins and the disagreement is warned, naming both values.

## 11. Two new findings

Added to `GraphFindings`:

- **`entitiesNotFound`** — a referenced id the catalogue does not contain. A campaign pointing at a
  deleted email, tag or form is a broken campaign, found for free by the join.
- **`unusedEntities`** — a catalogue entity no campaign references. If the account defines 400 tags
  and 142 are in use, that is 258 pieces of dead weight not to migrate.

Both are only computed when a catalogue is supplied; without one they are empty, because "not found"
and "not looked up" are different claims.

## 12. `src/cli/enrich.ts`

```bash
KEAP_API_KEY=… npm run enrich -- --app jordan
```

Writes `artifacts/<app>/entities.json`. Prints the probe result per kind, the count fetched, request
volume and elapsed time, and any warnings.

`npm run normalize -- --app jordan` then picks the catalogue up if it exists and passes it to
`buildGraph`; if it does not exist, it builds the graph exactly as today and says so.

## 13. Error handling

| Condition | Behaviour |
|---|---|
| `KEAP_API_KEY` unset | Fail before any request, naming the variable. |
| Key belongs to another account | Fail, nothing written. |
| A path outside the allowlist | Throw. This is a programming error, not a runtime condition. |
| An entity kind unavailable | Record in `sources`, continue. |
| HTTP 429 | Back off, retry to a cap, then fail naming the kind and progress. |
| HTTP 401/403 | Fail naming the likely cause — key revoked, or lacking admin scope. |
| Zero entities fetched across all kinds | Fail. A silent empty catalogue is worse than an error. |
| `entities.json` absent at normalise time | Build the graph unenriched and say so. Never fail. |
| `entities.json` present but unparseable | Warn, build unenriched. One bad file must not cost the graph. |

## 14. Testing

Everything except the client is pure and tests offline:

- The guard refuses a contacts path, refuses a non-GET method, and permits each allowlisted path.
- Response mapping per kind, against recorded fixtures — no live call in any test.
- The client against a mocked fetch: paging exhausts, 429 retries then fails, 401 reports clearly.
- `buildGraph` with no catalogue produces byte-identical output to today. **The existing 209 tests
  must pass unchanged** — enrichment that alters unenriched behaviour is a bug.
- `buildGraph` with a catalogue labels a tag, an email and a webform, and leaves an entity absent
  from the catalogue in `entitiesNotFound`.
- A catalogue entity nothing references appears in `unusedEntities`.
- A tag whose catalogue name disagrees with its decision-criteria label warns, naming both.

## 15. Success criteria

1. `npm run enrich -- --app jordan` writes `entities.json` and reports, per kind, either an endpoint
   and a count or an explicit reason it is unavailable.
2. **The webform and landing-page question is settled in writing** — either they resolve, or
   `sources` records why not.
3. The six tags labelled from decision criteria are cross-checked against the API; agreement is
   reported, disagreement is warned with both values.
4. `npm run normalize -- --app jordan` produces a graph in which the previously unlabelled entity
   kinds carry names, for every kind the probe found available.
5. No request is made to any path outside the allowlist, and no contact record is fetched.
6. Rate-limit behaviour is measured and recorded in `spike-findings.md`, closing handoff §14 Q10.
7. The full suite passes offline, including the 209 existing tests unchanged.
