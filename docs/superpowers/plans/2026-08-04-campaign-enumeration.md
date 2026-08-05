# Campaign Enumeration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List every campaign in an app — id, name, category, published state — using only GET requests, so the bulk extractor has a work queue.

**Architecture:** Widen the read-only guard to cover the whole app rather than just `/app/`, then add a pure `parseCampaignList` that reads the legacy JSP report table by column *name*, a thin GET fetch layer, and an `enumerate` CLI. `perPage=500` as a query parameter returns all records in one request, so no pagination and no POST.

**Tech Stack:** Node 20+, TypeScript (ESM, strict), Playwright, cheerio, vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-08-04-campaign-enumeration-design.md`

## Global Constraints

- **Node 20 or newer.** ESM only. All relative imports carry a `.js` extension.
- **TypeScript `strict: true`** with `noUncheckedIndexedAccess`.
- **GET only.** `src/auth/login.ts` remains the single exception in the codebase.
- **App names and funnel ids are validated** before reaching a URL or a filesystem path.
- **Dates are stored exactly as rendered.** No parsing, no timezone conversion — the account
  timezone is Phoenix and the handoff has an unresolved timezone discrepancy on timer fields.
- **A short read is a failure, not a warning.** If parsed rows are fewer than the page's own
  `numberOfRecords`, the run fails. A truncated list looks exactly like a smaller account.
- **Committed fixtures carry no PII.** The list page embeds the operator's email, analytics keys and
  a list of other client accounts in its head and nav; only the report region is captured.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/guard/readonly.ts` | modify | Denylist applies to all paths, static prefixes exempt |
| `src/parse/campaignList.ts` | create | Report HTML → campaign summaries. Pure. |
| `src/extract/campaigns.ts` | create | Build the list URL, GET it, parse it |
| `src/cli/enumerate.ts` | create | `npm run enumerate -- --app <app>` |
| `package.json` | modify | Add the `enumerate` script |
| `test/readonly.test.ts` | modify | Cover the widened policy |
| `test/campaignList.test.ts` | create | Parser tests against the real capture |
| `test/fixtures/campaign-list-jordan.html` | create | Real report region, trimmed rows |

---

### Task 1: Widen the read-only guard

**Files:**
- Modify: `src/guard/readonly.ts`
- Test: `test/readonly.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `classifyRequest` unchanged in signature; `STATIC_PATH_PREFIXES` added;
  `GUARDED_PATH_PREFIX` removed

**Why this changes.** The denylist applied only under `/app/`, so this was allowed:

```
GET /Reports/reportActions.jsp?actionName=Unpublish+and+Delete+Automations
```

That URL is in the Actions menu of the page this feature scrapes.

**The trap in the obvious fix.** Applying the existing pattern to all paths blocks
`/Reports/searchTemplate.jsp` — the enumeration endpoint — because it contains "template". The
observed dangerous URL was `PUT /app/authoring/<a>/<b>/template`, a path *ending* in `/template`,
and it is a PUT so the method rule already blocks it. Anchoring as `/template$` keeps the
belt-and-braces without breaking enumeration.

- [ ] **Step 1: Write the failing test**

Replace the body of `test/readonly.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { classifyRequest } from '../src/guard/readonly.js';

const B = 'https://x.infusionsoft.com';

describe('classifyRequest — allowed reads', () => {
  it('allows the campaign editor', () => {
    expect(classifyRequest('GET', `${B}/app/funnel/funnelEditor?funnelId=584`)).toBeNull();
  });

  it('allows the decision editor', () => {
    expect(
      classifyRequest('GET', `${B}/app/decisionFunnel/decisionEditor?flowIds=3,32`),
    ).toBeNull();
  });

  it('allows the automations report, whose path contains "Template"', () => {
    expect(
      classifyRequest('GET', `${B}/Reports/searchTemplate.jsp?reportClass=SetupFunnel&perPage=500`),
    ).toBeNull();
  });

  it('allows session keepAlive', () => {
    expect(classifyRequest('GET', `${B}/app/session/keepAlive`)).toBeNull();
  });

  it('allows static assets whose filename contains a denylisted word', () => {
    expect(
      classifyRequest('GET', `${B}/resources/funnel/images/template-icon.svg`),
    ).toBeNull();
  });

  it('allows a decision-editor GET whose title parameter contains "save"', () => {
    expect(
      classifyRequest('GET', `${B}/app/funnel/configureCell?title=Save%20for%20later`),
    ).toBeNull();
  });
});

describe('classifyRequest — blocked writes', () => {
  it('blocks every non-GET regardless of path', () => {
    expect(classifyRequest('POST', `${B}/anything`)).toBe('non-get');
    expect(classifyRequest('PUT', `${B}/app/authoring/a/b/template`)).toBe('non-get');
    expect(classifyRequest('DELETE', `${B}/app/funnel/x`)).toBe('non-get');
  });

  it('blocks the destructive report action found in the Automations Actions menu', () => {
    expect(
      classifyRequest(
        'GET',
        `${B}/Reports/reportActions.jsp?actionName=Unpublish+and+Delete+Automations`,
      ),
    ).toBe('denylist');
  });

  it('blocks write-shaped paths outside /app/, which the old rule ignored', () => {
    expect(classifyRequest('GET', `${B}/Reports/deleteReport.jsp`)).toBe('denylist');
    expect(classifyRequest('GET', `${B}/Admin/saveSettings.jsp`)).toBe('denylist');
  });

  it('blocks write-shaped paths under /app/', () => {
    expect(classifyRequest('GET', `${B}/app/funnel/saveDraft?id=1`)).toBe('denylist');
    expect(classifyRequest('GET', `${B}/app/funnel/publishFunnel?id=1`)).toBe('denylist');
    expect(classifyRequest('GET', `${B}/app/funnel/deleteFunnel?id=1`)).toBe('denylist');
  });

  it('blocks a path ending in /template but not one merely containing it', () => {
    expect(classifyRequest('GET', `${B}/app/authoring/a/b/template`)).toBe('denylist');
    expect(classifyRequest('GET', `${B}/Reports/searchTemplate.jsp`)).toBeNull();
  });

  it('blocks a malformed URL rather than letting it through', () => {
    expect(classifyRequest('GET', 'not-a-url')).toBe('denylist');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/readonly.test.ts`
Expected: FAIL — the `reportActions`, `deleteReport.jsp` and `saveSettings.jsp` cases return `null`.

- [ ] **Step 3: Write the implementation**

In `src/guard/readonly.ts`, replace the two constants and `classifyRequest`:

```ts
/**
 * Matched against the URL pathname only.
 *
 * `/template$` is anchored deliberately. The observed dangerous URL was
 * PUT /app/authoring/<a>/<b>/template, a path ending in /template — while
 * /Reports/searchTemplate.jsp, the automations report we depend on, merely
 * contains the word. An unanchored match blocks our own enumeration endpoint.
 */
export const WRITE_URL_PATTERN = /(save|publish|delete|hotSwap|reportActions|\/template$)/i;

/**
 * Prefixes exempt from the denylist: static assets, which cannot change state
 * and legitimately carry words like "template" in their filenames.
 */
export const STATIC_PATH_PREFIXES = [
  '/resources/',
  '/css/',
  '/js/',
  '/images/',
  '/slices/',
  '/files/',
];

/**
 * Returns the reason a request must be blocked, or null if it is allowed.
 * Pure — this is the entire read-only policy.
 *
 * The denylist applies to every path, not just /app/. It previously did not,
 * which left /Reports/reportActions.jsp?actionName=Unpublish+and+Delete...
 * allowed — a destructive URL sitting in the Actions menu of the automations
 * report this extractor reads.
 *
 * The query string stays out of scope: campaign names reach the URL as a
 * `title` parameter, and an author is free to name a node "Save for later".
 */
export function classifyRequest(method: string, url: string): BlockReason | null {
  if (method.toUpperCase() !== 'GET') return 'non-get';

  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // A URL we cannot parse is a URL we cannot vet.
    return 'denylist';
  }

  if (STATIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;
  if (WRITE_URL_PATTERN.test(pathname)) return 'denylist';

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/readonly.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Confirm nothing else regressed**

Run: `npm test && npm run typecheck`
Expected: PASS. The removal of `GUARDED_PATH_PREFIX` must not break a typecheck — nothing imports it.

- [ ] **Step 6: Commit**

```bash
git add src/guard/readonly.ts test/readonly.test.ts && git commit -m "fix: apply the read-only denylist to all paths, not just /app/

A destructive reportActions.jsp URL sits in the Actions menu of the automations
report this extractor now reads, and the old /app/-scoped rule allowed it.

/template is anchored to the end of the path: the observed dangerous URL was
PUT /app/authoring/<a>/<b>/template, while /Reports/searchTemplate.jsp — the
enumeration endpoint — merely contains the word."
```

---

### Task 2: Capture the list page as a fixture

**Files:**
- Create: `test/fixtures/campaign-list-jordan.html`

**Interfaces:**
- Consumes: nothing
- Produces: the fixture `test/campaignList.test.ts` reads

**What to keep.** Only the report region: the `numberOfRecords` hidden input, the `reportStateId`
hidden input, the `perPage` hidden input, the header row, and a sample of real data rows.

**What to strip, and why.** The full page embeds the operator's email address in Pendo, FullStory
and Intercom configuration blocks, two analytics API keys, and a menu listing every other client
account the operator can reach. None of it is needed to parse a table, and committing it would put
third-party account names in the repository.

**Rows to keep** — chosen to cover the real variation, copied verbatim from the capture:

| funnelId | Why |
|---|---|
| 999 | No category, no published date, no publisher — the never-published case |
| 987 | Category, date `11/10/2020 8:31 AM`, publisher `Amy Anton` — the fully-populated case |
| 953 | No category but has a date and publisher |
| 745 | Category, date, publisher `N/A` — a literal string, not an empty cell |
| 676 | Name contains an HTML entity (`&ndash;`) |
| 592 | Category, no date |

`numberOfRecords` stays at its real value of **170** even though the fixture holds six rows. That is
deliberate: it makes the fixture exercise the short-read failure path, which is the way this feature
fails silently in production.

- [ ] **Step 1: Create the fixture**

Copy the report region from the captured page, preserving markup exactly. The structure is:

```html
<input type="hidden" id="reportStateId" value="6df5eb9a-3e7f-4bc3-8aa8-1fec92114637"/>
<input type=hidden id="numberOfRecords" value="170"/>
<table width="100%" cellpadding="0px" cellspacing="0px" border="0px" class="zebra-striped tabular data-table">
  <tr class="tr-noborder">
    <th class="thead-noborder-check" nowrap="nowrap">…</th>
    <th nowrap="nowrap" align="" class="thead-noborder-id "><a class="header-sort" href="…"><span class="header-sort-name">Id</span>…</a></th>
    <th nowrap="nowrap" align="" class="thead-noborder "><a class="header-sort" href="…"><span class="header-sort-name">Name</span></a></th>
    <th …><span class="header-sort-name">Categories</span></th>
    <th …><span class="header-sort-name">Active Contacts</span></th>
    <th …><span class="header-sort-name">Published Date</span></th>
    <th …><span class="header-sort-name">Published By</span></th>
  </tr>
  <tr class="data-td">
    <td class="col-chk"><input type="checkbox" name="rowchk" value="{Id=999, FunnelId=999}"/></td>
    <td class='dt' align="" >999</td>
    <td class='dt-wrap' align="" ><span style='min-width: 250px; display: inline-block'><a target="_top" href="/app/funnel/funnelEditor?funnelId=999">Untitled automation</a></span></td>
    <td class='dt-wrap' align="" ></td>
    <td class='dt' align="" ><a href="…Funnel_DATA=999">0</a></td>
    <td class='dt' align="" ></td>
    <td class='dt' align="" ></td>
  </tr>
  …
</table>
<input name="perPage" value="50" type="hidden" id="perPage" />
```

- [ ] **Step 2: Verify no PII made it in**

```bash
grep -icE "jordan@|pendo|intercom|fullstory|apiKey|app_id=|infusionsoft.com\"" test/fixtures/campaign-list-jordan.html
```

Expected: `0`. Any hit means head or nav content leaked in — remove it before committing.

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/campaign-list-jordan.html && git commit -m "test: add real automations list fixture, report region only"
```

---

### Task 3: Parse the campaign list

**Files:**
- Create: `src/parse/campaignList.ts`
- Test: `test/campaignList.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `parseCampaignList(html: string): CampaignList`, types `CampaignSummary`, `CampaignList`

**Design note — columns by name, not position.** The header row exposes each column's label in
`span.header-sort-name`. The parser builds a label→index map and reads through it. Positional
reading would silently shift every field if Keap adds or reorders a column, which is precisely how
the decision parser came to return confident, empty results.

- [ ] **Step 1: Write the failing test**

Create `test/campaignList.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCampaignList } from '../src/parse/campaignList.js';

const html = readFileSync(
  new URL('./fixtures/campaign-list-jordan.html', import.meta.url),
  'utf8',
);

describe('parseCampaignList', () => {
  it('reads the account-wide total from the page, not from the rows', () => {
    expect(parseCampaignList(html).total).toBe(170);
  });

  it('reads the report state id and page size', () => {
    const result = parseCampaignList(html);
    expect(result.reportStateId).toBe('6df5eb9a-3e7f-4bc3-8aa8-1fec92114637');
    expect(result.perPage).toBe(50);
  });

  it('extracts every row anchored on the editor link', () => {
    expect(parseCampaignList(html).campaigns.map((c) => c.funnelId)).toEqual([
      '999',
      '987',
      '953',
      '745',
      '676',
      '592',
    ]);
  });

  it('reads a fully populated row', () => {
    const c = parseCampaignList(html).campaigns.find((x) => x.funnelId === '987');
    expect(c).toMatchObject({
      name: 'WooConnection Beta Tester Application',
      categories: ['WooConnection'],
      activeContacts: 0,
      publishedDate: '11/10/2020 8:31 AM',
      publishedBy: 'Amy Anton',
      published: true,
    });
  });

  it('treats a missing published date as never published', () => {
    const c = parseCampaignList(html).campaigns.find((x) => x.funnelId === '999');
    expect(c).toMatchObject({
      name: 'Untitled automation',
      categories: [],
      publishedDate: null,
      publishedBy: null,
      published: false,
    });
  });

  it('keeps a literal N/A publisher rather than turning it into null', () => {
    const c = parseCampaignList(html).campaigns.find((x) => x.funnelId === '745');
    expect(c?.publishedBy).toBe('N/A');
    expect(c?.published).toBe(true);
  });

  it('decodes HTML entities in campaign names', () => {
    const c = parseCampaignList(html).campaigns.find((x) => x.funnelId === '676');
    expect(c?.name).toContain('–');
    expect(c?.name).not.toContain('&ndash;');
  });

  it('stores the published date verbatim, with no timezone interpretation', () => {
    const dates = parseCampaignList(html)
      .campaigns.map((c) => c.publishedDate)
      .filter((d): d is string => d !== null);
    for (const d of dates) expect(d).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2} [AP]M$/);
  });
});

describe('parseCampaignList resilience', () => {
  it('reads columns by name, so reordering them does not shift fields', () => {
    // Swap the Name and Categories headers, and the matching cells in row 987.
    const swapped = html
      .replace('>Name</span>', '>__TMP__</span>')
      .replace('>Categories</span>', '>Name</span>')
      .replace('>__TMP__</span>', '>Categories</span>');
    const c = parseCampaignList(swapped).campaigns.find((x) => x.funnelId === '987');
    // The name still comes from the editor link, and the category column is now
    // where Name used to be — proving lookup is by label, not position.
    expect(c?.name).toBe('WooConnection Beta Tester Application');
    expect(c?.categories).toEqual([]);
  });

  it('warns naming a column that has disappeared rather than throwing', () => {
    const gutted = html.replace('>Published Date</span>', '>Something Else</span>');
    const result = parseCampaignList(gutted);
    expect(result.warnings.some((w) => /Published Date/.test(w))).toBe(true);
    expect(result.campaigns.every((c) => c.publishedDate === null)).toBe(true);
  });

  it('returns no campaigns and a warning for unrelated HTML', () => {
    const result = parseCampaignList('<html><body>Session expired</body></html>');
    expect(result.campaigns).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/campaignList.test.ts`
Expected: FAIL — cannot resolve `../src/parse/campaignList.js`.

- [ ] **Step 3: Write the implementation**

Create `src/parse/campaignList.ts`:

```ts
import { type CheerioAPI, load } from 'cheerio';

type Q = CheerioAPI;
type Selection = ReturnType<Q>;

export interface CampaignSummary {
  funnelId: string;
  name: string;
  categories: string[];
  activeContacts: number | null;
  publishedDate: string | null;
  publishedBy: string | null;
  published: boolean;
}

export interface CampaignList {
  total: number | null;
  perPage: number | null;
  reportStateId: string | null;
  campaigns: CampaignSummary[];
  warnings: string[];
}

const COLUMNS = ['Id', 'Name', 'Categories', 'Active Contacts', 'Published Date', 'Published By'];

function intOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const digits = raw.replace(/[^\d-]/g, '');
  if (digits === '') return null;
  const n = Number.parseInt(digits, 10);
  return Number.isNaN(n) ? null : n;
}

function textOrNull(cell: Selection | undefined): string | null {
  if (!cell || cell.length === 0) return null;
  const text = cell.text().replace(/ /g, ' ').trim();
  return text === '' ? null : text;
}

/**
 * Builds a column-label → index map from the header row.
 *
 * The report renders each label inside span.header-sort-name. Reading cells by
 * label rather than by fixed position means an added or reordered column
 * cannot silently shift every field.
 */
function headerIndex($: Q): Map<string, number> {
  const index = new Map<string, number>();
  $('tr.tr-noborder')
    .first()
    .find('th')
    .each((i, th) => {
      const label = $(th).find('span.header-sort-name').first().text().trim();
      if (label !== '') index.set(label, i);
    });
  return index;
}

export function parseCampaignList(html: string): CampaignList {
  const $ = load(html);
  const warnings: string[] = [];

  const total = intOrNull($('#numberOfRecords').first().attr('value'));
  const perPage = intOrNull($('#perPage').first().attr('value'));
  const reportStateId = $('#reportStateId').first().attr('value') ?? null;

  const columns = headerIndex($);
  if (columns.size === 0) {
    warnings.push('no report header row found — this may not be the automations list page');
  }
  for (const expected of COLUMNS) {
    if (!columns.has(expected)) {
      warnings.push(`column "${expected}" is missing from the report header`);
    }
  }

  const cellAt = (cells: Selection, label: string): Selection | undefined => {
    const i = columns.get(label);
    return i === undefined ? undefined : cells.eq(i);
  };

  const campaigns: CampaignSummary[] = [];

  $('tr').each((_, row) => {
    const $row = $(row);
    const link = $row.find('a[href*="funnelEditor?funnelId="]').first();
    if (link.length === 0) return;

    const funnelId = /funnelId=(\d+)/.exec(link.attr('href') ?? '')?.[1];
    if (funnelId === undefined) return;

    const cells = $row.find('td');
    const publishedDate = textOrNull(cellAt(cells, 'Published Date'));

    campaigns.push({
      funnelId,
      // The link text is the name; taking it from the cell would pick up the
      // wrapping span's whitespace.
      name: link.text().trim(),
      categories: (() => {
        const text = textOrNull(cellAt(cells, 'Categories'));
        return text === null ? [] : text.split(',').map((s) => s.trim()).filter(Boolean);
      })(),
      activeContacts: intOrNull(textOrNull(cellAt(cells, 'Active Contacts')) ?? undefined),
      publishedDate,
      publishedBy: textOrNull(cellAt(cells, 'Published By')),
      // Presence of a date is the signal. It needs no parsing, and the account
      // renders dates in its own timezone with a known unresolved discrepancy.
      published: publishedDate !== null,
    });
  });

  if (campaigns.length === 0) {
    warnings.push('no campaign rows found — no link matched funnelEditor?funnelId=');
  }

  return { total, perPage, reportStateId, campaigns, warnings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/campaignList.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/parse/campaignList.ts test/campaignList.test.ts && git commit -m "feat: parse the automations list, reading columns by name"
```

---

### Task 4: Fetch the list and expose it as a CLI

**Files:**
- Create: `src/extract/campaigns.ts`
- Create: `src/cli/enumerate.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `safeGet` from `src/guard/readonly.js`; `parseCampaignList` from
  `src/parse/campaignList.js`; `openSession`/`closeSession` from `src/auth/session.js`;
  `normalizeAppName` from `src/app.js`
- Produces:
  - `campaignListUrl(baseUrl: string, perPage?: number): string`
  - `fetchCampaignList(context: BrowserContext, baseUrl: string, perPage?: number): Promise<CampaignList>`
  - `npm run enumerate -- --app <app>` writing `artifacts/<app>/campaigns.json`

- [ ] **Step 1: Write `src/extract/campaigns.ts`**

```ts
import type { BrowserContext } from 'playwright';
import { safeGet } from '../guard/readonly.js';
import { type CampaignList, parseCampaignList } from '../parse/campaignList.js';

/** The report's own page-size selector tops out here; its tooltip mentions a 1000 mode. */
export const DEFAULT_PER_PAGE = 500;

/**
 * The Automations report.
 *
 * The UI changes page size by POSTing form data to ?view=gridGuts, which the
 * read-only guard blocks. perPage is also honoured as a GET parameter —
 * verified against the live app: perPage=500 returned all 170 records where the
 * default returned 50.
 */
export function campaignListUrl(baseUrl: string, perPage: number = DEFAULT_PER_PAGE): string {
  return (
    `${baseUrl}/Reports/searchTemplate.jsp` +
    `?reportClass=SetupFunnel&view=resultsPage&perPage=${encodeURIComponent(String(perPage))}`
  );
}

export async function fetchCampaignList(
  context: BrowserContext,
  baseUrl: string,
  perPage: number = DEFAULT_PER_PAGE,
): Promise<CampaignList> {
  const response = await safeGet(context, campaignListUrl(baseUrl, perPage));
  return parseCampaignList(await response.text());
}
```

- [ ] **Step 2: Write `src/cli/enumerate.ts`**

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName } from '../app.js';
import { closeSession, openSession } from '../auth/session.js';
import { DEFAULT_PER_PAGE, fetchCampaignList } from '../extract/campaigns.js';

interface Args {
  app: string;
  perPage: number;
  headed: boolean;
}

function parseArgs(argv: string[]): Args {
  const usage = 'Usage: npm run enumerate -- --app <appName> [--per-page <n>] [--headed]';
  const appIndex = argv.indexOf('--app');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  if (!rawApp) throw new Error(usage);

  const perPageIndex = argv.indexOf('--per-page');
  const rawPerPage = perPageIndex >= 0 ? argv[perPageIndex + 1] : undefined;
  const perPage = rawPerPage === undefined ? DEFAULT_PER_PAGE : Number.parseInt(rawPerPage, 10);
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new Error(`Invalid --per-page ${JSON.stringify(rawPerPage)}. Expected a positive integer.`);
  }

  return { app: normalizeAppName(rawApp), perPage, headed: argv.includes('--headed') };
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

  let session: Awaited<ReturnType<typeof openSession>>;
  try {
    session = await openSession({ app: args.app, headless: !args.headed });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  let failed = false;

  try {
    const list = await fetchCampaignList(session.context, session.baseUrl, args.perPage);
    for (const warning of list.warnings) console.log(`  warning: ${warning}`);

    if (list.campaigns.length === 0) {
      fail('no campaigns parsed — the response did not look like the automations list');
      return;
    }

    // A truncated list looks exactly like a smaller account. Never write one.
    if (list.total !== null && list.campaigns.length < list.total) {
      fail(
        `short read: parsed ${list.campaigns.length} of ${list.total} campaigns. ` +
          `Retry with a larger page size, e.g. --per-page 1000.`,
      );
      return;
    }

    const outDir = join('artifacts', args.app);
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, 'campaigns.json'),
      JSON.stringify(
        {
          app: args.app,
          enumeratedAt: new Date().toISOString(),
          total: list.total,
          perPage: list.perPage,
          count: list.campaigns.length,
          campaigns: list.campaigns,
        },
        null,
        2,
      ),
      'utf8',
    );

    const published = list.campaigns.filter((c) => c.published).length;
    const categories = new Map<string, number>();
    for (const c of list.campaigns) {
      for (const cat of c.categories) categories.set(cat, (categories.get(cat) ?? 0) + 1);
    }

    console.log(`\n[${args.app}] ${list.campaigns.length} campaigns (page reports ${list.total})`);
    console.log(`  published: ${published}   never published: ${list.campaigns.length - published}`);
    console.log(
      `  categories: ${
        categories.size === 0
          ? '(none)'
          : [...categories.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')
      }`,
    );
    const nonGet = session.guard.blocked.filter((b) => b.reason === 'non-get');
    console.log(
      `  requests: ${session.guard.allowed.length} allowed, ${session.guard.blocked.length} blocked ` +
        `(${nonGet.length} non-GET)`,
    );
    console.log(`  artifacts: ${join(outDir, 'campaigns.json')}\n`);
  } catch (error) {
    failed = true;
    console.error(`\nenumerate failed: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    await closeSession(session);
  }

  if (failed) process.exitCode = 1;
}

await main();
```

- [ ] **Step 3: Add the npm script**

In `package.json`, add to `scripts`, after `"spike"`:

```json
    "enumerate": "tsx src/cli/enumerate.ts",
```

- [ ] **Step 4: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: PASS, no type errors.

- [ ] **Step 5: Verify argument handling without launching a browser**

```bash
npx tsx src/cli/enumerate.ts
npx tsx src/cli/enumerate.ts --app "../../../etc"
npx tsx src/cli/enumerate.ts --app jordan --per-page 0
```

Expected, in order: the usage line; `Invalid app name "../../../etc"`; `Invalid --per-page "0"`.
No Chromium window, no directory created.

- [ ] **Step 6: Commit**

```bash
git add src/extract/campaigns.ts src/cli/enumerate.ts package.json && git commit -m "feat: enumerate campaigns for an app via a single read-only request"
```

---

### Task 5: Live run and findings

**Files:**
- Modify: `docs/spike-findings.md`

**Interfaces:**
- Consumes: everything from Tasks 1–4
- Produces: `artifacts/jordan/campaigns.json`, and the recorded result

This task needs a valid session. If it has expired, re-run `npm run login -- --app jordan` first —
sessions have been observed lapsing in roughly 30 minutes.

- [ ] **Step 1: Enumerate**

```bash
npm run enumerate -- --app jordan
```

Expected: `170 campaigns (page reports 170)`, a published/never-published split, category tallies,
`0 non-GET`, and `artifacts/jordan/campaigns.json` written.

- [ ] **Step 2: Sanity-check the output against known campaigns**

```bash
node --input-type=module -e "import{readFileSync}from'node:fs';const j=JSON.parse(readFileSync('artifacts/jordan/campaigns.json','utf8'));console.log('count',j.count,'total',j.total);for(const id of ['584','987'])console.log(JSON.stringify(j.campaigns.find(c=>c.funnelId===id)));"
```

Expected: `count 170 total 170`; campaign 987 named "WooConnection Beta Tester Application" with
`published: true`; campaign 584 named "[MP-76] Satisfaction Survey".

- [ ] **Step 3: Confirm the guard held**

```bash
node --input-type=module -e "import{readFileSync}from'node:fs';const j=JSON.parse(readFileSync('artifacts/jordan/campaigns.json','utf8'));console.log('campaigns with no name:',j.campaigns.filter(c=>!c.name).length);console.log('duplicate ids:',j.campaigns.length-new Set(j.campaigns.map(c=>c.funnelId)).size);"
```

Expected: `0` and `0`. A duplicate id would mean rows are being double-counted.

- [ ] **Step 4: Record the findings**

Append a `Campaign enumeration` section to `docs/spike-findings.md` recording: the endpoint and the
GET-vs-POST discovery; the real campaign count; the published/never-published split; the category
taxonomy observed; the guard defect this work fixed; and the three distinct app URL shapes observed
in the account menu (`sp218.infusionsoft.com`, `app.infusionsoft.com?app_id=ro474`,
`keap.app?app_id=qw806`), which `baseUrlFor` does not yet handle.

The published split is the first real evidence for the live-versus-dead question the handoff calls
the most useful thing this system can eventually tell a client — worth stating plainly, with the
caveat that "never published" is a weaker signal than "published but inactive", which needs the
reporting data we have not touched.

- [ ] **Step 5: Commit**

```bash
git add docs/spike-findings.md && git commit -m "docs: record campaign enumeration results"
```

---

## Definition of Done

1. `npm run enumerate -- --app jordan` writes `artifacts/jordan/campaigns.json` with 170 campaigns.
2. Parsed count equals the page's own `numberOfRecords`; a short read fails rather than writing.
3. Published and never-published campaigns are distinguished.
4. `/Reports/reportActions.jsp?actionName=Unpublish+and+Delete+Automations` is denied, with a test.
5. `/Reports/searchTemplate.jsp` is still allowed — the guard fix does not block enumeration.
6. Zero non-GET requests reach the network.
7. The full suite passes offline, and no PII sits in the committed fixture.
