# Multi-App Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract campaigns from any Keap app, keeping sessions and artifacts separated by app, and make writing one app's data into another's directory impossible.

**Architecture:** A new pure module `src/app.ts` owns app identity — validation, URL derivation, path derivation, and identity verification. `parseIdentity` reads the `appName` marker embedded in every `draftXml`. The orchestrator verifies before creating any directory, so a refused run leaves nothing behind. The module-level `BASE_URL` constant is replaced by a per-run value threaded as a parameter.

**Tech Stack:** Node 20+, TypeScript (ESM, strict), Playwright, fast-xml-parser, cheerio, vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-08-04-multi-app-support-design.md`

## Global Constraints

- **Node 20 or newer.** ESM only. All relative imports carry a `.js` extension.
- **TypeScript `strict: true`** with `noUncheckedIndexedAccess`.
- **Strictly read-only against Keap.** `src/auth/login.ts` remains the only place touching a non-GET request.
- **App names and funnel ids become both URL segments and filesystem paths.** Both must be validated before use. This is a security boundary, not input tidying.
- **App names are lowercased** before any use, so `Jordan` and `jordan` cannot become two directories.
- **`.sessions/` is gitignored** and every session file is written at mode `0600`.
- **Verification distinguishes contradiction from absence:** a marker that is present and different aborts; a marker that is absent warns and proceeds.
- **All timestamps ISO 8601 UTC.**
- **Committed fixtures are never modified.** They are raw captures and carry no layout assumptions.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/app.ts` | create | App identity: validation, URL, paths, verification. Pure. |
| `src/parse/cells.ts` | modify | Add `parseIdentity`. Pure. |
| `src/config.ts` | modify | Drop `BASE_URL`/`STATE_PATH`; keep `LOGIN_URL_PATTERN` |
| `src/extract/campaign.ts` | modify | Take `baseUrl` as a parameter |
| `src/extract/decision.ts` | modify | Take `baseUrl` as a parameter |
| `src/auth/login.ts` | modify | Require `--app`; write `.sessions/<app>.json` |
| `src/auth/session.ts` | modify | `openSession({ app, headless })` |
| `src/cli/spike.ts` | modify | Require `--app`; verify before writing; new layout |
| `.gitignore` | modify | Add `.sessions/` |
| `test/app.test.ts` | create | Validation, derivation, verification |
| `test/cells.test.ts` | modify | `parseIdentity` against real fixtures |
| `test/decisionUrls.test.ts` | modify | Pass `baseUrl` explicitly |

Tasks 1–2 are pure and fully TDD'd. Task 3 is a mechanical refactor driven by the typechecker. Tasks 4–5 wire it together. Task 6 migrates and verifies against the live app.

---

### Task 1: App identity module

**Files:**
- Create: `src/app.ts`
- Test: `test/app.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `normalizeAppName(raw: string): string`
  - `normalizeFunnelId(raw: string): string`
  - `baseUrlFor(app: string): string`
  - `sessionPathFor(app: string): string`
  - `campaignDirFor(app: string, funnelId: string): string`
  - `verifyIdentity(expected, actual): IdentityCheck`
  - types `IdentityCheck`

**Design note — funnel ids need validating too.** The spec calls out `--app` as a path-traversal vector; `--funnel` is the same class of bug through the same mechanism, since it is also interpolated into a directory path. Keap funnel ids are integers, so the check is cheap.

- [ ] **Step 1: Write the failing test**

Create `test/app.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  baseUrlFor,
  campaignDirFor,
  normalizeAppName,
  normalizeFunnelId,
  sessionPathFor,
  verifyIdentity,
} from '../src/app.js';

afterEach(() => {
  delete process.env.KEAP_BASE_URL;
});

describe('normalizeAppName', () => {
  it('accepts real Keap subdomain shapes', () => {
    expect(normalizeAppName('jordan')).toBe('jordan');
    expect(normalizeAppName('ab123')).toBe('ab123');
    expect(normalizeAppName('abc12345')).toBe('abc12345');
  });

  it('lowercases so one app cannot become two directories', () => {
    expect(normalizeAppName('Jordan')).toBe('jordan');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeAppName('  jordan  ')).toBe('jordan');
  });

  it('rejects path traversal', () => {
    expect(() => normalizeAppName('../../../etc')).toThrow(/Invalid app name/);
  });

  it('rejects anything that would redirect us to another host', () => {
    expect(() => normalizeAppName('evil.com/x')).toThrow(/Invalid app name/);
    expect(() => normalizeAppName('evil.com')).toThrow(/Invalid app name/);
  });

  it('rejects empty, over-long and malformed names', () => {
    expect(() => normalizeAppName('')).toThrow(/Invalid app name/);
    expect(() => normalizeAppName('-lead')).toThrow(/Invalid app name/);
    expect(() => normalizeAppName('has space')).toThrow(/Invalid app name/);
    expect(() => normalizeAppName('a'.repeat(64))).toThrow(/Invalid app name/);
  });

  it('accepts a name at exactly the 63 character limit', () => {
    expect(normalizeAppName('a'.repeat(63))).toBe('a'.repeat(63));
  });
});

describe('normalizeFunnelId', () => {
  it('accepts an integer id', () => {
    expect(normalizeFunnelId('584')).toBe('584');
  });

  it('rejects path traversal through the funnel argument', () => {
    expect(() => normalizeFunnelId('../584')).toThrow(/Invalid funnel id/);
    expect(() => normalizeFunnelId('../../etc')).toThrow(/Invalid funnel id/);
  });

  it('rejects non-numeric ids', () => {
    expect(() => normalizeFunnelId('abc')).toThrow(/Invalid funnel id/);
    expect(() => normalizeFunnelId('')).toThrow(/Invalid funnel id/);
  });
});

describe('baseUrlFor', () => {
  it('derives the tenant URL from the app name', () => {
    expect(baseUrlFor('abc12345')).toBe('https://abc12345.infusionsoft.com');
  });

  it('lets KEAP_BASE_URL override the derived host', () => {
    process.env.KEAP_BASE_URL = 'https://staging.example.com/';
    expect(baseUrlFor('jordan')).toBe('https://staging.example.com');
  });

  it('validates the app name even when overridden', () => {
    process.env.KEAP_BASE_URL = 'https://staging.example.com';
    expect(() => baseUrlFor('../evil')).toThrow(/Invalid app name/);
  });
});

describe('path derivation', () => {
  it('puts sessions in a per-app file', () => {
    expect(sessionPathFor('jordan')).toBe('.sessions/jordan.json');
  });

  it('nests campaigns under the app', () => {
    expect(campaignDirFor('jordan', '584')).toBe('artifacts/jordan/campaigns/584');
  });

  it('refuses to build a path from an invalid funnel id', () => {
    expect(() => campaignDirFor('jordan', '../../etc')).toThrow(/Invalid funnel id/);
  });
});

describe('verifyIdentity', () => {
  const expected = { app: 'jordan', funnelId: '584' };

  it('accepts a matching identity', () => {
    const result = verifyIdentity(expected, { appName: 'jordan', funnelId: '584' });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts an identity differing only in case', () => {
    expect(verifyIdentity(expected, { appName: 'Jordan', funnelId: '584' }).ok).toBe(true);
  });

  it('rejects a contradictory app name and names both values', () => {
    const result = verifyIdentity(expected, { appName: 'abc12345', funnelId: '584' });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('jordan');
    expect(result.errors[0]).toContain('abc12345');
  });

  it('rejects a contradictory funnel id', () => {
    const result = verifyIdentity(expected, { appName: 'jordan', funnelId: '999' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /funnel/i.test(e))).toBe(true);
  });

  it('warns but passes when a marker is absent rather than contradictory', () => {
    const result = verifyIdentity(expected, { appName: null, funnelId: null });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/app.test.ts`
Expected: FAIL — cannot resolve `../src/app.js`.

- [ ] **Step 3: Write the implementation**

Create `src/app.ts`:

```ts
import { join } from 'node:path';

/**
 * DNS label rules. App names become both a URL subdomain and a filesystem path
 * segment, so this is a security boundary: "../../../etc" is path traversal and
 * "evil.com/x" redirects the extractor at a host the operator never named.
 */
const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Keap funnel ids are integers. Same traversal risk through the same mechanism. */
const FUNNEL_ID_PATTERN = /^\d+$/;

export interface IdentityCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function normalizeAppName(raw: string): string {
  const app = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!APP_NAME_PATTERN.test(app)) {
    throw new Error(
      `Invalid app name ${JSON.stringify(raw)}. Expected a Keap subdomain: lowercase ` +
        `letters, digits and hyphens, starting with a letter or digit, at most 63 characters.`,
    );
  }
  return app;
}

export function normalizeFunnelId(raw: string): string {
  const id = String(raw ?? '').trim();
  if (!FUNNEL_ID_PATTERN.test(id)) {
    throw new Error(`Invalid funnel id ${JSON.stringify(raw)}. Expected digits only.`);
  }
  return id;
}

/**
 * KEAP_BASE_URL overrides the derived host, but the app name is still validated
 * and still governs where artifacts are filed. The override changes where we
 * look, never what we are willing to file it as.
 */
export function baseUrlFor(app: string): string {
  const validated = normalizeAppName(app);
  const override = process.env.KEAP_BASE_URL;
  if (override) return override.replace(/\/+$/, '');
  return `https://${validated}.infusionsoft.com`;
}

export function sessionPathFor(app: string): string {
  return join('.sessions', `${normalizeAppName(app)}.json`);
}

export function campaignDirFor(app: string, funnelId: string): string {
  return join('artifacts', normalizeAppName(app), 'campaigns', normalizeFunnelId(funnelId));
}

/**
 * Compares what we asked for against what the extracted document says it is.
 *
 * A marker that is present and different is a contradiction and aborts the run.
 * A marker that is absent is merely weaker evidence: both were present on every
 * campaign observed, but a schema change that drops one must not halt
 * extraction across an entire account.
 */
export function verifyIdentity(
  expected: { app: string; funnelId: string },
  actual: { appName: string | null; funnelId: string | null },
): IdentityCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (actual.appName === null) {
    warnings.push('draftXml carries no appName marker — cannot confirm which app this came from');
  } else if (actual.appName.toLowerCase() !== expected.app.toLowerCase()) {
    errors.push(
      `app mismatch: asked for "${expected.app}" but draftXml says "${actual.appName}"`,
    );
  }

  if (actual.funnelId === null) {
    warnings.push('draftXml carries no funnelId marker');
  } else if (actual.funnelId !== expected.funnelId) {
    errors.push(
      `funnel mismatch: asked for "${expected.funnelId}" but draftXml says "${actual.funnelId}"`,
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/app.test.ts`
Expected: PASS, 21 tests (7 `normalizeAppName`, 3 `normalizeFunnelId`, 3 `baseUrlFor`,
3 path derivation, 5 `verifyIdentity`).

- [ ] **Step 5: Commit**

```bash
git add src/app.ts test/app.test.ts && git commit -m "feat: add app identity module with validation and verification"
```

---

### Task 2: Read the app marker out of draftXml

**Files:**
- Modify: `src/parse/cells.ts`
- Test: `test/cells.test.ts`

**Interfaces:**
- Consumes: `stripLongSuffix` (already in `src/parse/cells.ts`)
- Produces: `parseIdentity(draftXml: string): CampaignIdentity`, type `CampaignIdentity`

**Design note — where the marker lives.** Verified against the committed fixtures: the marker sits on the `<Object as="value">` child of `mxCell id="0"`, the graph root cell:

```xml
<mxCell id="0">
  <Object initialized="1" funnelId="987L" appName="jordan"
          buildNumber="1.70.0.989251-sysarch-202608031100" as="value">
```

The implementation searches every cell for the first `<Object>` carrying an `appName` attribute rather than hardcoding cell `0`, so the marker moving does not break it.

- [ ] **Step 1: Write the failing test**

Append to `test/cells.test.ts`:

```ts
describe('parseIdentity', () => {
  const c584 = readFileSync(new URL('./fixtures/campaign-584-draft.xml', import.meta.url), 'utf8');
  const c987 = readFileSync(new URL('./fixtures/campaign-987-draft.xml', import.meta.url), 'utf8');

  it('reads the app marker from campaign 584', () => {
    expect(parseIdentity(c584)).toEqual({
      appName: 'jordan',
      funnelId: '584',
      buildNumber: '1.70.0.989251-sysarch-202608031100',
    });
  });

  it('reads the app marker from campaign 987', () => {
    expect(parseIdentity(c987)).toMatchObject({ appName: 'jordan', funnelId: '987' });
  });

  it('strips the Java Long suffix from funnelId', () => {
    // The raw attribute is funnelId="987L".
    expect(parseIdentity(c987).funnelId).toBe('987');
  });

  it('returns nulls rather than throwing when the marker is absent', () => {
    const bare = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
    expect(parseIdentity(bare)).toEqual({ appName: null, funnelId: null, buildNumber: null });
  });

  it('finds the marker even if it moves to another cell', () => {
    const moved = c987.replace('<mxCell id="0">', '<mxCell id="0"/><mxCell id="99">');
    expect(parseIdentity(moved).appName).toBe('jordan');
  });
});
```

Add `parseIdentity` to the existing import at the top of the file:

```ts
import { cleanName, parseCells, parseIdentity, stripLongSuffix } from '../src/parse/cells.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cells.test.ts`
Expected: FAIL — `parseIdentity is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/parse/cells.ts`, after `parseCells`:

```ts
export interface CampaignIdentity {
  appName: string | null;
  funnelId: string | null;
  buildNumber: string | null;
}

/**
 * Reads the self-identifying markers Keap embeds in every campaign.
 *
 * Observed on the <Object as="value"> child of mxCell id="0", the graph root:
 *   <Object initialized="1" funnelId="987L" appName="jordan" buildNumber="..." as="value">
 *
 * Searches all cells for the first Object carrying appName rather than
 * hardcoding cell 0, so the marker moving does not break identification.
 */
export function parseIdentity(draftXml: string): CampaignIdentity {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR,
    parseAttributeValue: false,
    isArray: (name) => ['mxCell', 'Object', 'Array'].includes(name),
  });

  const doc = parser.parse(draftXml) as XmlNode;
  const model = doc.mxGraphModel as XmlNode | undefined;
  const root = model?.root as XmlNode | undefined;
  const empty: CampaignIdentity = { appName: null, funnelId: null, buildNumber: null };
  if (!root) return empty;

  for (const cell of asArray(root.mxCell)) {
    for (const value of asArray(cell.Object)) {
      const appName = attr(value, 'appName');
      if (appName === undefined) continue;
      return {
        appName,
        funnelId: stripLongSuffix(attr(value, 'funnelId')),
        buildNumber: attr(value, 'buildNumber') ?? null,
      };
    }
  }

  return empty;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cells.test.ts`
Expected: PASS, 23 tests.

- [ ] **Step 5: Commit**

```bash
git add src/parse/cells.ts test/cells.test.ts && git commit -m "feat: read appName and funnelId markers from draftXml"
```

---

### Task 3: Thread the base URL as a parameter

**Files:**
- Modify: `src/config.ts`
- Modify: `src/extract/campaign.ts`
- Modify: `src/extract/decision.ts`
- Test: `test/decisionUrls.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `extractCampaign(page: Page, baseUrl: string, funnelId: string): Promise<CampaignRaw>`
  - `decisionCandidateUrls(baseUrl: string, cell: DecisionCell, context?: GoalContext): string[]`
  - `fetchDecision(context: BrowserContext, baseUrl: string, cell: DecisionCell, goal?: GoalContext): Promise<DecisionFetchResult>`
  - `src/config.ts` exports only `LOGIN_URL_PATTERN`

`baseUrl` goes immediately after the connection argument in every signature, so the ordering is uniform.

- [ ] **Step 1: Reduce `src/config.ts` to the login pattern**

Replace the entire contents of `src/config.ts`:

```ts
/**
 * URL fragments that indicate we have been bounced to a sign-in screen.
 *
 * Base URL and session path are per-app and live in src/app.ts. There is no
 * module-level BASE_URL: a single constant cannot describe a run that may
 * target any tenant.
 */
export const LOGIN_URL_PATTERN = /(\/login|\/signin|signin\.|accounts\.infusionsoft\.com)/i;
```

- [ ] **Step 2: Take `baseUrl` as a parameter in `src/extract/campaign.ts`**

Remove the `BASE_URL` import:

```ts
import { assertAuthenticated } from '../auth/session.js';
```

Change the signature and the first line of the body:

```ts
export async function extractCampaign(
  page: Page,
  baseUrl: string,
  funnelId: string,
): Promise<CampaignRaw> {
  const url = `${baseUrl}/app/funnel/funnelEditor?funnelId=${encodeURIComponent(funnelId)}`;
```

Everything else in the function is unchanged.

- [ ] **Step 3: Take `baseUrl` as a parameter in `src/extract/decision.ts`**

Remove the `BASE_URL` import so only these remain:

```ts
import type { BrowserContext } from 'playwright';
import { safeGet } from '../guard/readonly.js';
import type { DecisionCell } from '../parse/cells.js';
import { type DecisionCriteria, parseDecisionHtml } from '../parse/decisionHtml.js';
```

Change both signatures:

```ts
export function decisionCandidateUrls(
  baseUrl: string,
  cell: DecisionCell,
  context?: GoalContext,
): string[] {
  const base = `${baseUrl}/app/decisionFunnel/decisionEditor`;
```

```ts
export async function fetchDecision(
  context: BrowserContext,
  baseUrl: string,
  cell: DecisionCell,
  goal?: GoalContext,
): Promise<DecisionFetchResult> {
```

and inside `fetchDecision`, the loop header becomes:

```ts
  for (const url of decisionCandidateUrls(baseUrl, cell, goal)) {
```

- [ ] **Step 4: Update `test/decisionUrls.test.ts` to pass the base URL**

Add the constant below the existing `cell` declaration:

```ts
const BASE = 'https://jordan.infusionsoft.com';
```

Then replace every `decisionCandidateUrls(cell` with `decisionCandidateUrls(BASE, cell`. There are six call sites, one in each of these tests:

- `targets the confirmed decisionEditor endpoint`
- `reproduces the observed URL when given the goal context`
- `restores the Java Long suffix on decisionIds but not flowIds`
- `tries the bare form first, so a hit avoids tracing the upstream goal`
- `produces only the bare form when no goal context is known`
- `adds the L suffix to a secondaryKeyId supplied without one`

The expected URL string in `reproduces the observed URL when given the goal context` is unchanged, because `BASE` is the same host the old default produced.

- [ ] **Step 5: Typecheck to find every remaining call site**

Run: `npm run typecheck`
Expected: errors only in `src/auth/login.ts`, `src/auth/session.ts` and `src/cli/spike.ts`, which Tasks 4 and 5 fix. Those three files still import the removed `BASE_URL`/`STATE_PATH`.

- [ ] **Step 6: Confirm the pure tests still pass**

Run: `npx vitest run test/decisionUrls.test.ts test/cells.test.ts test/readonly.test.ts test/decisionHtml.test.ts test/app.test.ts`
Expected: PASS. `vitest` does not typecheck, so these run despite the errors above.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/extract/ test/decisionUrls.test.ts && git commit -m "refactor: thread base URL as a parameter instead of a module constant"
```

---

### Task 4: Per-app sessions

**Files:**
- Modify: `src/auth/login.ts`
- Modify: `src/auth/session.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `normalizeAppName`, `baseUrlFor`, `sessionPathFor` from `src/app.js`; `LOGIN_URL_PATTERN` from `src/config.js`
- Produces:
  - `openSession(options: { app: string; headless?: boolean }): Promise<Session>`
  - `closeSession(session: Session): Promise<void>` — unchanged
  - `assertAuthenticated(page: Page): void` — unchanged
  - `Session` gains `app: string` and `baseUrl: string`

- [ ] **Step 1: Add `.sessions/` to `.gitignore`**

Insert after the `artifacts/` line, before the existing `.claude` comment block:

```
.sessions/
```

- [ ] **Step 2: Rewrite `src/auth/login.ts`**

```ts
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { baseUrlFor, normalizeAppName, sessionPathFor } from '../app.js';

/**
 * One-time interactive login for a single app.
 *
 * No read-only guard is installed here: submitting the sign-in form requires a
 * POST, and a human is driving. This is the only place in the codebase that
 * touches a non-GET request.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const appIndex = argv.indexOf('--app');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  if (!rawApp) {
    console.error('\nUsage: npm run login -- --app <appName>\n');
    process.exitCode = 1;
    return;
  }

  let app: string;
  let baseUrl: string;
  try {
    app = normalizeAppName(rawApp);
    baseUrl = baseUrlFor(app);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const statePath = sessionPathFor(app);
  await mkdir(dirname(statePath), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(baseUrl);

  console.log(`\nA browser window is open at ${baseUrl} (app "${app}").`);
  console.log('Log in to Keap there, wait until you can see the dashboard, then return here.');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter once you are logged in... ');
  rl.close();

  await context.storageState({ path: statePath });
  await chmod(statePath, 0o600);
  await browser.close();

  console.log(`\nSaved session for "${app}" to ${statePath} (mode 600).`);
  console.log('This file contains live session cookies. It is gitignored — keep it that way.');
}

await main();
```

- [ ] **Step 3: Rewrite `src/auth/session.ts`**

```ts
import { existsSync } from 'node:fs';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { baseUrlFor, normalizeAppName, sessionPathFor } from '../app.js';
import { LOGIN_URL_PATTERN } from '../config.js';
import { type Guard, installReadOnlyGuard } from '../guard/readonly.js';

export interface Session {
  app: string;
  baseUrl: string;
  browser: Browser;
  context: BrowserContext;
  guard: Guard;
}

/**
 * Opens a browser context restored from the human-established session for one
 * app, with the read-only guard always installed. This is the only entry point
 * extraction code may use.
 */
export async function openSession(options: {
  app: string;
  headless?: boolean;
}): Promise<Session> {
  const app = normalizeAppName(options.app);
  const baseUrl = baseUrlFor(app);
  const statePath = sessionPathFor(app);

  if (!existsSync(statePath)) {
    throw new Error(`No session for "${app}" at ${statePath}. Run:  npm run login -- --app ${app}`);
  }

  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ storageState: statePath });
  const guard = installReadOnlyGuard(context);

  return { app, baseUrl, browser, context, guard };
}

export async function closeSession(session: Session): Promise<void> {
  await session.context.close();
  await session.browser.close();
}

/** Throws if the page has been bounced to a sign-in screen. */
export function assertAuthenticated(page: Page): void {
  const url = page.url();
  if (LOGIN_URL_PATTERN.test(url)) {
    throw new Error(`Session expired — landed on ${url}. Re-run:  npm run login -- --app <appName>`);
  }
}
```

- [ ] **Step 4: Verify the ignore rule works before any session file exists**

```bash
mkdir -p .sessions && touch .sessions/probe.json && git check-ignore -v .sessions/probe.json && rm .sessions/probe.json
```

Expected: prints the matching `.gitignore` line. If it prints nothing, **stop** — a session file could reach git.

- [ ] **Step 5: Commit**

```bash
git add .gitignore src/auth/ && git commit -m "feat: per-app session storage under .sessions/"
```

---

### Task 5: Orchestrator with verification before write

**Files:**
- Modify: `src/cli/spike.ts`

**Interfaces:**
- Consumes: `campaignDirFor`, `normalizeAppName`, `normalizeFunnelId`, `verifyIdentity` from `src/app.js`; `openSession`/`closeSession` from `src/auth/session.js`; `extractCampaign` from `src/extract/campaign.js`; `fetchDecision` from `src/extract/decision.js`; `parseCells`, `parseIdentity` from `src/parse/cells.js`
- Produces: the `npm run spike -- --app <app> --funnel <id>` entry point

**Critical ordering change:** today the output directory is created before extraction. It must move after verification, or a refused run still leaves an empty client directory behind — exactly the confusing artifact this feature exists to prevent.

- [ ] **Step 1: Replace `src/cli/spike.ts`**

```ts
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { campaignDirFor, normalizeAppName, normalizeFunnelId, verifyIdentity } from '../app.js';
import { closeSession, openSession } from '../auth/session.js';
import { extractCampaign } from '../extract/campaign.js';
import { fetchDecision } from '../extract/decision.js';
import { parseCells, parseIdentity } from '../parse/cells.js';

/** Recorded in keap-campaign-extractor-handoff.md sections 2 and 8. Informational only. */
const BASELINES: Record<string, { chars: number; cells: number }> = {
  '584': { chars: 11_185, cells: 43 },
  '987': { chars: 7_252, cells: 32 },
};

interface Args {
  app: string;
  funnelId: string;
  headed: boolean;
}

function parseArgs(argv: string[]): Args {
  const usage = 'Usage: npm run spike -- --app <appName> --funnel <funnelId> [--headed]';
  const appIndex = argv.indexOf('--app');
  const funnelIndex = argv.indexOf('--funnel');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  const rawFunnel = funnelIndex >= 0 ? argv[funnelIndex + 1] : undefined;
  if (!rawApp || !rawFunnel) throw new Error(usage);

  return {
    app: normalizeAppName(rawApp),
    funnelId: normalizeFunnelId(rawFunnel),
    headed: argv.includes('--headed'),
  };
}

/** Prints `message` without a stack trace and marks the run as failed. */
function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  // Bad arguments and a missing session are ordinary, user-fixable conditions.
  // They are handled before the extraction try block so they surface as
  // messages rather than stack traces.
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

  if (process.env.KEAP_BASE_URL) {
    console.log(
      `\nKEAP_BASE_URL is set — using ${session.baseUrl} instead of the URL derived ` +
        `from app "${args.app}". Artifacts are still filed under "${args.app}".`,
    );
  }

  let failed = false;

  try {
    const page = await session.context.newPage();
    const campaign = await extractCampaign(page, session.baseUrl, args.funnelId);

    // Verify BEFORE creating any directory: a refused run must leave nothing.
    const identity = parseIdentity(campaign.draftXml);
    const check = verifyIdentity({ app: args.app, funnelId: args.funnelId }, identity);
    for (const warning of check.warnings) console.log(`  warning: ${warning}`);
    if (!check.ok) {
      for (const error of check.errors) console.error(`  ${error}`);
      fail('identity check failed — nothing was written');
      return;
    }

    const inventory = parseCells(campaign.draftXml);
    const outDir = campaignDirFor(args.app, args.funnelId);
    const decisionsDir = join(outDir, 'decisions');
    // Clear prior decision output first. A stale .attempt-N.html from a failed
    // run sitting beside a successful .html reads as though both happened.
    await rm(decisionsDir, { recursive: true, force: true });
    await mkdir(decisionsDir, { recursive: true });

    await writeFile(join(outDir, 'draft.xml'), campaign.draftXml, 'utf8');
    await writeFile(join(outDir, 'publish.xml'), campaign.publishXml, 'utf8');

    const { draftXml, publishXml, ...meta } = campaign;
    await writeFile(
      join(outDir, 'meta.json'),
      JSON.stringify(
        {
          appName: identity.appName ?? args.app,
          ...meta,
          publishXmlLength: publishXml.length,
          neverPublished: publishXml.length === 0,
          inventory,
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log(
      `\n[${args.app}] campaign ${args.funnelId} — "${campaign.funnelName ?? '(no name)'}"`,
    );

    const baseline = BASELINES[args.funnelId];
    const cellCount = inventory.cellCount;
    if (baseline) {
      console.log(
        `  draftXml: ${draftXml.length} chars / ${cellCount} mxCell ` +
          `(handoff baseline ${baseline.chars} / ${baseline.cells}; ` +
          `delta ${draftXml.length - baseline.chars} chars, ${cellCount - baseline.cells} cells)`,
      );
    } else {
      console.log(`  draftXml: ${draftXml.length} chars / ${cellCount} mxCell (no baseline)`);
    }

    console.log(`  published: ${publishXml.length === 0 ? 'never' : `${publishXml.length} chars`}`);
    console.log(`  styles: ${JSON.stringify(inventory.styleCounts)}`);
    for (const warning of inventory.warnings) console.log(`  warning: ${warning}`);

    for (const cell of inventory.decisions) {
      const result = await fetchDecision(session.context, session.baseUrl, cell);

      if (result.html && result.criteria) {
        await writeFile(join(decisionsDir, `${cell.cellId}.html`), result.html, 'utf8');
        await writeFile(
          join(decisionsDir, `${cell.cellId}.json`),
          JSON.stringify(result.criteria, null, 2),
          'utf8',
        );
        const hitIndex = result.attempts.findIndex((a) => a.hit);
        console.log(
          `  decision ${cell.cellId}: HIT on candidate ${hitIndex + 1} — ` +
            `${result.criteria.wrappers.length} branch(es)`,
        );
        for (const warning of result.criteria.warnings) console.log(`    warning: ${warning}`);
      } else {
        failed = true;
        console.log(`  decision ${cell.cellId}: MISS on all ${result.attempts.length} candidates`);
        for (const [i, attempt] of result.attempts.entries()) {
          console.log(`    [${i + 1}] ${attempt.status} ${attempt.bytes}B ${attempt.url}`);
          await writeFile(
            join(decisionsDir, `${cell.cellId}.attempt-${i + 1}.html`),
            result.missBodies[i] ?? '',
            'utf8',
          );
        }
      }
    }

    await writeFile(
      join(outDir, 'requests.log.json'),
      JSON.stringify(session.guard, null, 2),
      'utf8',
    );

    const nonGet = session.guard.blocked.filter((b) => b.reason === 'non-get');
    console.log(
      `\n  requests: ${session.guard.allowed.length} allowed, ` +
        `${session.guard.blocked.length} blocked (${nonGet.length} non-GET)`,
    );
    console.log(`  artifacts: ${outDir}\n`);
  } catch (error) {
    failed = true;
    console.error(`\nspike failed: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    await closeSession(session);
  }

  if (failed) process.exitCode = 1;
}

await main();
```

- [ ] **Step 2: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS, no type errors, 84 tests — 7 `readonly` + 23 `cells` + 10 `decisionUrls`
+ 23 `decisionHtml` + 21 `app`.

- [ ] **Step 3: Verify argument handling without launching a browser**

```bash
npm run spike
npm run spike -- --app jordan
npm run spike -- --app "../../../etc" --funnel 584
npm run spike -- --app jordan --funnel "../etc"
```

Expected, in order: the usage line; the usage line; `Invalid app name "../../../etc"`; `Invalid funnel id "../etc"`. No Chromium window in any case, and no directory created under `artifacts/`.

- [ ] **Step 4: Commit**

```bash
git add src/cli/spike.ts && git commit -m "feat: require --app and verify identity before writing anything"
```

---

### Task 6: Migration and live verification

**Files:**
- Move: `storageState.json` → `.sessions/jordan.json`
- Delete: `artifacts/584`, `artifacts/987`

**Interfaces:**
- Consumes: everything built in Tasks 1–5
- Produces: a verified working extraction under the new layout

- [ ] **Step 1: Move the existing session rather than logging in again**

```bash
mkdir -p .sessions && mv storageState.json .sessions/jordan.json && chmod 600 .sessions/jordan.json && ls -l .sessions/
```

Expected: `-rw-------` on `.sessions/jordan.json`. It is a valid `jordan` session, so no re-login is needed.

- [ ] **Step 2: Remove the old flat artifacts**

```bash
rm -rf artifacts/584 artifacts/987 && ls artifacts/ 2>/dev/null || echo "(artifacts/ now empty or absent)"
```

Both are gitignored and regenerable, and leaving them beside `artifacts/jordan/campaigns/584` invites confusion about which is current.

- [ ] **Step 3: Extract both campaigns under the new layout**

```bash
npm run spike -- --app jordan --funnel 987
npm run spike -- --app jordan --funnel 584
```

Expected for each: a `[jordan] campaign <id>` header, `decision <cellId>: HIT on candidate 1`, `0 non-GET`, and artifacts written to `artifacts/jordan/campaigns/<id>`.

- [ ] **Step 4: Confirm the identity guard actually refuses**

```bash
npm run spike -- --app abc12345 --funnel 987
```

Two outcomes are both acceptable, and which one occurs is itself a finding worth recording:

- The session does not authenticate against `abc12345.infusionsoft.com`, and the run fails at `assertAuthenticated`.
- The wildcard `.infusionsoft.com` cookie authenticates, `jordan` data comes back, and the run aborts with `app mismatch: asked for "abc12345" but draftXml says "jordan"`.

In **both** cases verify nothing was written:

```bash
ls artifacts/abc12345 2>/dev/null && echo "FAIL — directory created" || echo "correct: no directory created"
```

- [ ] **Step 5: Confirm the layout and that no session leaked into git**

```bash
find artifacts -type f -not -name '.DS_Store' | sort
git status --short
git check-ignore -v .sessions/jordan.json
```

Expected: every file under `artifacts/jordan/campaigns/`; a clean or docs-only `git status`; and `check-ignore` naming the `.sessions/` rule.

- [ ] **Step 6: Record the outcome in the findings document**

Append a short section to `docs/spike-findings.md` titled `Multi-app support`, recording which of the two Step 4 outcomes occurred. That answers whether the `.infusionsoft.com` wildcard cookie grants cross-app access — currently unknown, and directly relevant to how carefully sessions must be handled for client accounts.

- [ ] **Step 7: Commit**

```bash
git add docs/spike-findings.md && git commit -m "docs: record multi-app verification and cross-app cookie behaviour"
```

---

## Definition of Done

1. `npm run login -- --app jordan` writes `.sessions/jordan.json` at mode 600.
2. `npm run spike -- --app jordan --funnel 987` writes `artifacts/jordan/campaigns/987/draft.xml` and reports `appName jordan`.
3. A deliberately wrong `--app` aborts and creates no directory (Task 6, Step 4).
4. An invalid app name or funnel id is rejected without launching a browser (Task 5, Step 3).
5. `git check-ignore` confirms `.sessions/` is ignored.
6. The full suite passes offline.
7. `docs/spike-findings.md` records whether the wildcard cookie grants cross-app access.
