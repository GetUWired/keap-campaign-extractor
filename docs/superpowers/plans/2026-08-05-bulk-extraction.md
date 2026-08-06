# Bulk Extraction with Resumable Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Walk the enumerated campaign list for an app, extract every campaign, and survive process death or session expiry without losing completed work.

**Architecture:** A typed `SessionExpiredError` makes expiry detectable without string-matching. A pure `progress.ts` owns the resume record, verified against disk on load so it cannot claim a campaign is done when its artifacts are gone. `spike.ts`'s per-campaign body moves into `campaignRun.ts` so the bulk runner and the single-campaign CLI share one implementation.

**Tech Stack:** Node 20+, TypeScript (ESM, strict), Playwright, vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-08-05-bulk-extraction-design.md`

## Global Constraints

- **Node 20 or newer.** ESM only. All relative imports carry a `.js` extension.
- **TypeScript `strict: true`** with `noUncheckedIndexedAccess`.
- **GET only.** `src/auth/login.ts` remains the single exception.
- **App names and funnel ids are validated** before reaching a URL or a filesystem path.
- **Progress is saved after every campaign**, written to a temp file and renamed so a kill mid-write cannot corrupt it.
- **Session expiry aborts the run**; the in-flight campaign is left *pending*, never recorded as failed.
- **Per-campaign failures are recorded and the run continues.**
- **All timestamps ISO 8601 UTC.**

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/errors.ts` | create | `SessionExpiredError`, `isSessionExpired` |
| `src/auth/session.ts` | modify | Throw the typed error |
| `src/progress.ts` | create | Resume record: pure logic plus load/save |
| `src/extract/campaignRun.ts` | create | One campaign: extract, verify, write |
| `src/cli/spike.ts` | modify | Call `extractOne` instead of inlining it |
| `src/cli/extractAll.ts` | create | The bulk runner |
| `package.json` | modify | Add `extract-all` |
| `test/errors.test.ts` | create | Typed-error detection |
| `test/progress.test.ts` | create | Queue, record, reconcile |

---

### Task 1: Typed session-expiry error

**Files:**
- Create: `src/errors.ts`
- Modify: `src/auth/session.ts`
- Test: `test/errors.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `SessionExpiredError`, `isSessionExpired(error: unknown): error is SessionExpiredError`

**Why typed.** The bulk runner must distinguish "this campaign failed" from "the session died, stop now". Matching `/Session expired/` against `error.message` works until someone rewords the message, and then the run quietly degrades to 150 identical failures instead of aborting. A class survives rewording.

`instanceof` alone is unreliable across module realms, so the class also carries a marker property and `isSessionExpired` checks both.

- [ ] **Step 1: Write the failing test**

Create `test/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SessionExpiredError, isSessionExpired } from '../src/errors.js';

describe('SessionExpiredError', () => {
  it('is an Error with the given message', () => {
    const error = new SessionExpiredError('Session expired — landed on /login');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Session expired');
    expect(error.name).toBe('SessionExpiredError');
  });
});

describe('isSessionExpired', () => {
  it('recognises the typed error', () => {
    expect(isSessionExpired(new SessionExpiredError('x'))).toBe(true);
  });

  it('rejects a plain Error even when its text looks identical', () => {
    // The whole reason this is typed: message text is not a contract.
    expect(isSessionExpired(new Error('Session expired — landed on /login'))).toBe(false);
  });

  it('rejects non-errors', () => {
    expect(isSessionExpired(null)).toBe(false);
    expect(isSessionExpired(undefined)).toBe(false);
    expect(isSessionExpired('Session expired')).toBe(false);
    expect(isSessionExpired({ message: 'Session expired' })).toBe(false);
  });

  it('recognises an error carrying the marker without prototype identity', () => {
    // Guards against instanceof failing across module realms.
    const impostor = Object.assign(new Error('x'), { isSessionExpired: true as const });
    expect(isSessionExpired(impostor)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/errors.test.ts`
Expected: FAIL — cannot resolve `../src/errors.js`.

- [ ] **Step 3: Write the implementation**

Create `src/errors.ts`:

```ts
/**
 * The session is no longer valid.
 *
 * Typed rather than message-matched: a bulk run must tell "this campaign
 * failed" from "stop, everything after this will fail too", and that decision
 * cannot depend on the wording of a string.
 */
export class SessionExpiredError extends Error {
  /** Marker so detection survives instanceof failing across module realms. */
  readonly isSessionExpired = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export function isSessionExpired(error: unknown): error is SessionExpiredError {
  if (error instanceof SessionExpiredError) return true;
  return (
    error instanceof Error &&
    (error as { isSessionExpired?: unknown }).isSessionExpired === true
  );
}
```

- [ ] **Step 4: Throw it from `src/auth/session.ts`**

Add the import at the top, after the existing imports:

```ts
import { SessionExpiredError } from '../errors.js';
```

Then change both throw sites from `new Error(` to `new SessionExpiredError(` — one in
`assertAuthenticated`, one in `assertResponseAuthenticated`. The messages are unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/errors.test.ts test/session.test.ts`
Expected: PASS, 10 tests. `session.test.ts` still passes because `SessionExpiredError` is an `Error`
and its `toThrow(/Session expired/)` assertions match on message.

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts src/auth/session.ts test/errors.test.ts && git commit -m "feat: add typed SessionExpiredError so expiry is detectable without string matching"
```

---

### Task 2: The progress record

**Files:**
- Create: `src/progress.ts`
- Test: `test/progress.test.ts`

**Interfaces:**
- Consumes: `normalizeAppName` from `src/app.js`
- Produces: `CampaignStatus`, `ProgressEntry`, `Progress`, `emptyProgress`, `pendingFunnelIds`, `recordOutcome`, `reconcile`, `progressPathFor`, `loadProgress`, `saveProgress`

**Design note — `reconcile` takes a predicate.** The drift check is the reason this file exists, so it
must be testable without touching a filesystem. The caller supplies a function that says whether a
campaign's artifacts are present; the logic here stays pure.

- [ ] **Step 1: Write the failing test**

Create `test/progress.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  type Progress,
  emptyProgress,
  pendingFunnelIds,
  progressPathFor,
  recordOutcome,
  reconcile,
} from '../src/progress.js';

const NOW = '2026-08-05T06:00:00.000Z';
const LATER = '2026-08-05T06:05:00.000Z';

function fixture(): Progress {
  return {
    app: 'jordan',
    enumeratedAt: '2026-08-05T05:00:00.000Z',
    startedAt: NOW,
    updatedAt: NOW,
    total: 4,
    entries: {
      '584': { status: 'done', at: NOW, cells: 43, decisions: 1 },
      '987': { status: 'done', at: NOW, cells: 33, decisions: 1 },
      '953': { status: 'failed', at: NOW, error: 'editor timeout' },
    },
  };
}

describe('emptyProgress', () => {
  it('carries the enumeration timestamp through', () => {
    const p = emptyProgress('jordan', 170, '2026-08-05T05:00:00.000Z', NOW);
    expect(p).toMatchObject({
      app: 'jordan',
      total: 170,
      enumeratedAt: '2026-08-05T05:00:00.000Z',
      startedAt: NOW,
      updatedAt: NOW,
    });
    expect(p.entries).toEqual({});
  });

  it('tolerates an unknown enumeration timestamp', () => {
    expect(emptyProgress('jordan', 1, null, NOW).enumeratedAt).toBeNull();
  });
});

describe('pendingFunnelIds', () => {
  const all = ['584', '987', '953', '745'];

  it('skips completed campaigns', () => {
    expect(pendingFunnelIds(fixture(), all, false)).toEqual(['953', '745']);
  });

  it('retries failures — a failure is not a final state', () => {
    expect(pendingFunnelIds(fixture(), all, false)).toContain('953');
  });

  it('returns everything under force', () => {
    expect(pendingFunnelIds(fixture(), all, true)).toEqual(all);
  });

  it('preserves the order of the supplied list', () => {
    expect(pendingFunnelIds(fixture(), ['745', '953'], false)).toEqual(['745', '953']);
  });

  it('returns nothing when all are done', () => {
    expect(pendingFunnelIds(fixture(), ['584', '987'], false)).toEqual([]);
  });
});

describe('recordOutcome', () => {
  it('adds an entry and advances updatedAt', () => {
    const next = recordOutcome(fixture(), '745', { status: 'done', at: LATER, cells: 10 }, LATER);
    expect(next.entries['745']).toEqual({ status: 'done', at: LATER, cells: 10 });
    expect(next.updatedAt).toBe(LATER);
  });

  it('does not mutate the input', () => {
    const before = fixture();
    recordOutcome(before, '745', { status: 'done', at: LATER }, LATER);
    expect(before.entries['745']).toBeUndefined();
    expect(before.updatedAt).toBe(NOW);
  });

  it('overwrites a previous failure when the retry succeeds', () => {
    const next = recordOutcome(fixture(), '953', { status: 'done', at: LATER, cells: 5 }, LATER);
    expect(next.entries['953']).toMatchObject({ status: 'done' });
    expect(next.entries['953']?.error).toBeUndefined();
  });
});

describe('reconcile', () => {
  it('demotes a done entry whose artifacts are gone, and names it', () => {
    const result = reconcile(fixture(), (id) => id !== '987', LATER);
    expect(result.demoted).toEqual(['987']);
    expect(result.progress.entries['987']).toBeUndefined();
    expect(result.progress.entries['584']).toMatchObject({ status: 'done' });
  });

  it('leaves failures alone — they have no artifacts to verify', () => {
    const result = reconcile(fixture(), () => false, LATER);
    expect(result.demoted).toEqual(['584', '987']);
    expect(result.progress.entries['953']).toMatchObject({ status: 'failed' });
  });

  it('reports nothing when disk agrees', () => {
    const result = reconcile(fixture(), () => true, LATER);
    expect(result.demoted).toEqual([]);
    expect(result.progress).toEqual(fixture());
  });

  it('does not mutate the input', () => {
    const before = fixture();
    reconcile(before, () => false, LATER);
    expect(before.entries['584']).toMatchObject({ status: 'done' });
  });
});

describe('progressPathFor', () => {
  it('nests under the app directory', () => {
    expect(progressPathFor('jordan')).toBe('artifacts/jordan/progress.json');
  });

  it('validates the app name', () => {
    expect(() => progressPathFor('../../etc')).toThrow(/Invalid app name/);
  });
});

describe('Progress round-trips through JSON', () => {
  it('preserves every field', () => {
    const before = fixture();
    expect(JSON.parse(JSON.stringify(before))).toEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/progress.test.ts`
Expected: FAIL — cannot resolve `../src/progress.js`.

- [ ] **Step 3: Write the implementation**

Create `src/progress.ts`:

```ts
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName } from './app.js';

export type CampaignStatus = 'done' | 'failed';

export interface ProgressEntry {
  status: CampaignStatus;
  at: string;
  cells?: number;
  decisions?: number;
  error?: string;
}

export interface Progress {
  app: string;
  enumeratedAt: string | null;
  startedAt: string;
  updatedAt: string;
  total: number;
  entries: Record<string, ProgressEntry>;
}

export function emptyProgress(
  app: string,
  total: number,
  enumeratedAt: string | null,
  now: string,
): Progress {
  return { app, enumeratedAt, startedAt: now, updatedAt: now, total, entries: {} };
}

/**
 * The work queue, in the order the caller supplied.
 *
 * A `failed` entry is pending again: failures are usually transient (a timeout,
 * a slow editor), and a retry costs under two seconds.
 */
export function pendingFunnelIds(
  progress: Progress,
  allFunnelIds: string[],
  force: boolean,
): string[] {
  if (force) return [...allFunnelIds];
  return allFunnelIds.filter((id) => progress.entries[id]?.status !== 'done');
}

export function recordOutcome(
  progress: Progress,
  funnelId: string,
  entry: ProgressEntry,
  now: string,
): Progress {
  return {
    ...progress,
    updatedAt: now,
    entries: { ...progress.entries, [funnelId]: entry },
  };
}

/**
 * Drops `done` entries whose artifacts are not actually on disk.
 *
 * This is the mitigation for keeping progress in a file separate from the
 * artifacts it describes: the file is the record, but disk gets the final say,
 * so a deleted directory re-extracts instead of being skipped forever.
 *
 * Takes a predicate rather than reading the filesystem, so the logic is
 * testable offline.
 */
export function reconcile(
  progress: Progress,
  isComplete: (funnelId: string) => boolean,
  now: string,
): { progress: Progress; demoted: string[] } {
  const demoted: string[] = [];
  const entries: Record<string, ProgressEntry> = {};

  for (const [funnelId, entry] of Object.entries(progress.entries)) {
    if (entry.status === 'done' && !isComplete(funnelId)) {
      demoted.push(funnelId);
      continue;
    }
    entries[funnelId] = entry;
  }

  if (demoted.length === 0) return { progress, demoted };
  return { progress: { ...progress, updatedAt: now, entries }, demoted };
}

export function progressPathFor(app: string): string {
  return join('artifacts', normalizeAppName(app), 'progress.json');
}

/** Returns null when absent or unreadable; a corrupt record must not stop a run. */
export async function loadProgress(app: string): Promise<Progress | null> {
  try {
    return JSON.parse(await readFile(progressPathFor(app), 'utf8')) as Progress;
  } catch {
    return null;
  }
}

/** Written to a temp file and renamed, so a kill mid-write cannot corrupt it. */
export async function saveProgress(app: string, progress: Progress): Promise<void> {
  const path = progressPathFor(app);
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(temp, path);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/progress.test.ts`
Expected: PASS, 17 tests (2 `emptyProgress`, 5 `pendingFunnelIds`, 3 `recordOutcome`,
4 `reconcile`, 2 `progressPathFor`, 1 round-trip).

- [ ] **Step 5: Commit**

```bash
git add src/progress.ts test/progress.test.ts && git commit -m "feat: add resumable progress record verified against disk"
```

---

### Task 3: Share the per-campaign extraction

**Files:**
- Create: `src/extract/campaignRun.ts`
- Modify: `src/cli/spike.ts`

**Interfaces:**
- Consumes: `campaignDirFor`, `verifyIdentity` from `src/app.js`; `extractCampaign` from `src/extract/campaign.js`; `fetchDecision` from `src/extract/decision.js`; `parseCells`, `parseIdentity` from `src/parse/cells.js`; `Session` from `src/auth/session.js`
- Produces: `CampaignRunResult`, `DecisionOutcome`, `isCampaignComplete(app, funnelId): boolean`, `extractOne(session, page, app, funnelId): Promise<CampaignRunResult>`

**Why now.** The bulk runner needs exactly what `spike.ts` does per campaign. Copying it would give
two implementations of the identity check and the write ordering, and they would drift.

**What stays out.** `extractOne` does not write `requests.log.json` and does not print. The guard log
is session-wide: in a bulk run it accumulates across every campaign, so writing it per campaign would
store the same growing log 170 times. `spike.ts` writes it into the campaign directory; the bulk
runner writes one at the app level at the end. Printing stays with the callers, which format
differently.

- [ ] **Step 1: Create `src/extract/campaignRun.ts`**

```ts
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { campaignDirFor, verifyIdentity } from '../app.js';
import type { Session } from '../auth/session.js';
import { extractCampaign } from './campaign.js';
import { fetchDecision } from './decision.js';
import { type CellInventory, parseCells, parseIdentity } from '../parse/cells.js';

export interface DecisionOutcome {
  cellId: string;
  hit: boolean;
  branches: number;
  attempts: number;
  warnings: string[];
}

export interface CampaignRunResult {
  funnelId: string;
  appName: string | null;
  funnelName: string | null;
  outDir: string;
  draftXmlLength: number;
  publishXmlLength: number;
  inventory: CellInventory;
  decisions: DecisionOutcome[];
}

/** The disk predicate `reconcile` consumes: both core artifacts present. */
export function isCampaignComplete(app: string, funnelId: string): boolean {
  const dir = campaignDirFor(app, funnelId);
  return existsSync(join(dir, 'draft.xml')) && existsSync(join(dir, 'meta.json'));
}

/**
 * Extracts one campaign and writes its artifacts.
 *
 * Identity is verified before any directory is created, so a refused campaign
 * leaves nothing behind. SessionExpiredError propagates untouched — the caller
 * decides whether that aborts a whole run.
 */
export async function extractOne(
  session: Session,
  page: Page,
  app: string,
  funnelId: string,
): Promise<CampaignRunResult> {
  const campaign = await extractCampaign(page, session.baseUrl, funnelId);

  const identity = parseIdentity(campaign.draftXml);
  const check = verifyIdentity({ app, funnelId }, identity);
  if (!check.ok) {
    throw new Error(`identity check failed — ${check.errors.join('; ')}`);
  }

  const inventory = parseCells(campaign.draftXml);
  const outDir = campaignDirFor(app, funnelId);
  const decisionsDir = join(outDir, 'decisions');
  await rm(decisionsDir, { recursive: true, force: true });
  await mkdir(decisionsDir, { recursive: true });

  await writeFile(join(outDir, 'draft.xml'), campaign.draftXml, 'utf8');
  await writeFile(join(outDir, 'publish.xml'), campaign.publishXml, 'utf8');

  const { draftXml, publishXml, ...meta } = campaign;
  await writeFile(
    join(outDir, 'meta.json'),
    JSON.stringify(
      {
        appName: identity.appName ?? app,
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

  const decisions: DecisionOutcome[] = [];
  for (const cell of inventory.decisions) {
    const result = await fetchDecision(session.context, session.baseUrl, cell);

    if (result.html && result.criteria) {
      await writeFile(join(decisionsDir, `${cell.cellId}.html`), result.html, 'utf8');
      await writeFile(
        join(decisionsDir, `${cell.cellId}.json`),
        JSON.stringify(result.criteria, null, 2),
        'utf8',
      );
      decisions.push({
        cellId: cell.cellId,
        hit: true,
        branches: result.criteria.wrappers.length,
        attempts: result.attempts.length,
        warnings: result.criteria.warnings,
      });
    } else {
      for (const [i, body] of result.missBodies.entries()) {
        await writeFile(join(decisionsDir, `${cell.cellId}.attempt-${i + 1}.html`), body, 'utf8');
      }
      decisions.push({
        cellId: cell.cellId,
        hit: false,
        branches: 0,
        attempts: result.attempts.length,
        warnings: [],
      });
    }
  }

  return {
    funnelId,
    appName: identity.appName,
    funnelName: campaign.funnelName,
    outDir,
    draftXmlLength: draftXml.length,
    publishXmlLength: publishXml.length,
    inventory,
    decisions,
  };
}
```

- [ ] **Step 2: Rewrite the body of `main()` in `src/cli/spike.ts`**

Replace the imports of `extractCampaign`, `fetchDecision`, `parseCells`, `parseIdentity`,
`campaignDirFor`, `verifyIdentity`, `mkdir`, `rm`, and `join` usage for the write block with:

```ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName, normalizeFunnelId } from '../app.js';
import { closeSession, openSession } from '../auth/session.js';
import { extractOne } from '../extract/campaignRun.js';
```

Then replace everything inside the `try { ... }` block from `const page = ...` down to the
`artifacts:` log line with:

```ts
    const page = await session.context.newPage();
    const result = await extractOne(session, page, args.app, args.funnelId);

    console.log(`\n[${args.app}] campaign ${args.funnelId} — "${result.funnelName ?? '(no name)'}"`);

    const baseline = BASELINES[args.funnelId];
    const cellCount = result.inventory.cellCount;
    if (baseline) {
      console.log(
        `  draftXml: ${result.draftXmlLength} chars / ${cellCount} mxCell ` +
          `(handoff baseline ${baseline.chars} / ${baseline.cells}; ` +
          `delta ${result.draftXmlLength - baseline.chars} chars, ${cellCount - baseline.cells} cells)`,
      );
    } else {
      console.log(`  draftXml: ${result.draftXmlLength} chars / ${cellCount} mxCell (no baseline)`);
    }

    console.log(
      `  published: ${result.publishXmlLength === 0 ? 'never' : `${result.publishXmlLength} chars`}`,
    );
    console.log(`  styles: ${JSON.stringify(result.inventory.styleCounts)}`);
    for (const warning of result.inventory.warnings) console.log(`  warning: ${warning}`);

    for (const decision of result.decisions) {
      if (decision.hit) {
        console.log(`  decision ${decision.cellId}: HIT — ${decision.branches} branch(es)`);
        for (const warning of decision.warnings) console.log(`    warning: ${warning}`);
      } else {
        failed = true;
        console.log(`  decision ${decision.cellId}: MISS on all ${decision.attempts} candidates`);
      }
    }

    await writeFile(
      join(result.outDir, 'requests.log.json'),
      JSON.stringify(session.guard, null, 2),
      'utf8',
    );

    const nonGet = session.guard.blocked.filter((b) => b.reason === 'non-get');
    console.log(
      `\n  requests: ${session.guard.allowed.length} allowed, ` +
        `${session.guard.blocked.length} blocked (${nonGet.length} non-GET)`,
    );
    console.log(`  artifacts: ${result.outDir}\n`);
```

The `BASELINES` constant, `parseArgs`, and `fail` are unchanged.

- [ ] **Step 3: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: PASS, 129 tests — 107 existing, plus 5 from Task 1 and 17 from Task 2.

- [ ] **Step 4: Verify the single-campaign CLI still behaves**

```bash
npm run spike -- --app jordan --funnel 987
```

Expected: unchanged output — the `[jordan] campaign 987` header, a decision HIT, `0 non-GET`, and
artifacts under `artifacts/jordan/campaigns/987`. If the session has lapsed, re-run
`npm run login -- --app jordan` first.

- [ ] **Step 5: Commit**

```bash
git add src/extract/campaignRun.ts src/cli/spike.ts && git commit -m "refactor: share per-campaign extraction between the single and bulk runners"
```

---

### Task 4: The bulk runner

**Files:**
- Create: `src/cli/extractAll.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `normalizeAppName` from `src/app.js`; `closeSession`/`openSession` from `src/auth/session.js`; `isSessionExpired` from `src/errors.js`; `extractOne`, `isCampaignComplete` from `src/extract/campaignRun.js`; `emptyProgress`, `loadProgress`, `pendingFunnelIds`, `recordOutcome`, `reconcile`, `saveProgress` from `src/progress.js`
- Produces: `npm run extract-all -- --app <app> [--force] [--limit <n>] [--delay <ms>] [--headed]`

- [ ] **Step 1: Create `src/cli/extractAll.ts`**

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName } from '../app.js';
import { closeSession, openSession } from '../auth/session.js';
import { isSessionExpired } from '../errors.js';
import { extractOne, isCampaignComplete } from '../extract/campaignRun.js';
import {
  emptyProgress,
  loadProgress,
  pendingFunnelIds,
  recordOutcome,
  reconcile,
  saveProgress,
} from '../progress.js';

interface Args {
  app: string;
  force: boolean;
  limit: number | null;
  delayMs: number;
  headed: boolean;
}

const USAGE =
  'Usage: npm run extract-all -- --app <appName> [--force] [--limit <n>] [--delay <ms>] [--headed]';

function numericFlag(argv: string[], flag: string, fallback: number | null): number | null {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  const raw = argv[index + 1];
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${flag} ${JSON.stringify(raw)}. Expected a non-negative integer.`);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  const appIndex = argv.indexOf('--app');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  if (!rawApp) throw new Error(USAGE);

  const limit = numericFlag(argv, '--limit', null);
  if (limit !== null && limit < 1) {
    throw new Error('Invalid --limit "0". Expected a positive integer.');
  }

  return {
    app: normalizeAppName(rawApp),
    force: argv.includes('--force'),
    limit,
    delayMs: numericFlag(argv, '--delay', 250) ?? 250,
    headed: argv.includes('--headed'),
  };
}

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CampaignQueueFile {
  enumeratedAt?: string;
  campaigns?: { funnelId: string; name: string }[];
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const queuePath = join('artifacts', args.app, 'campaigns.json');
  let queue: CampaignQueueFile;
  try {
    queue = JSON.parse(await readFile(queuePath, 'utf8')) as CampaignQueueFile;
  } catch {
    fail(`No campaign list at ${queuePath}. Run:  npm run enumerate -- --app ${args.app}`);
    return;
  }

  const allCampaigns = queue.campaigns ?? [];
  const names = new Map(allCampaigns.map((c) => [c.funnelId, c.name]));
  const allIds = allCampaigns.map((c) => c.funnelId);
  if (allIds.length === 0) {
    fail(`${queuePath} lists no campaigns. Re-run:  npm run enumerate -- --app ${args.app}`);
    return;
  }

  const now = () => new Date().toISOString();
  let progress =
    (await loadProgress(args.app)) ??
    emptyProgress(args.app, allIds.length, queue.enumeratedAt ?? null, now());

  // Disk gets the final say over the progress file — see src/progress.ts.
  const reconciled = reconcile(progress, (id) => isCampaignComplete(args.app, id), now());
  progress = reconciled.progress;
  if (reconciled.demoted.length > 0) {
    console.log(
      `  warning: ${reconciled.demoted.length} campaign(s) marked done have no artifacts on disk ` +
        `and will be re-extracted: ${reconciled.demoted.join(', ')}`,
    );
  }

  if (
    progress.enumeratedAt !== null &&
    queue.enumeratedAt !== undefined &&
    progress.enumeratedAt !== queue.enumeratedAt
  ) {
    console.log(
      `  warning: the campaign list was re-enumerated since this progress record started ` +
        `(${progress.enumeratedAt} vs ${queue.enumeratedAt}). Resuming against the newer list.`,
    );
  }

  let pending = pendingFunnelIds(progress, allIds, args.force);
  if (args.limit !== null) pending = pending.slice(0, args.limit);

  console.log(
    `\n[${args.app}] ${allIds.length} campaigns total, ${pending.length} to extract` +
      `${args.force ? ' (forced)' : ''}${args.limit !== null ? ` (limited to ${args.limit})` : ''}`,
  );

  if (pending.length === 0) {
    console.log('  nothing to do\n');
    return;
  }

  let session: Awaited<ReturnType<typeof openSession>>;
  try {
    session = await openSession({ app: args.app, headless: !args.headed });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const started = Date.now();
  let completed = 0;
  let failedCount = 0;
  let aborted = false;

  try {
    const page = await session.context.newPage();

    for (const [index, funnelId] of pending.entries()) {
      const label = `[${index + 1}/${pending.length}] ${funnelId}`;
      try {
        const result = await extractOne(session, page, args.app, funnelId);
        const misses = result.decisions.filter((d) => !d.hit).length;
        progress = recordOutcome(
          progress,
          funnelId,
          {
            status: 'done',
            at: now(),
            cells: result.inventory.cellCount,
            decisions: result.decisions.length,
          },
          now(),
        );
        completed++;
        console.log(
          `  ${label} ok — ${result.inventory.cellCount} cells, ` +
            `${result.decisions.length} decision(s)${misses > 0 ? `, ${misses} MISS` : ''}` +
            ` — ${names.get(funnelId) ?? ''}`,
        );
      } catch (error) {
        // The session dying is not this campaign's fault. Leave it pending so a
        // resume retries it, and stop — everything after would fail identically.
        if (isSessionExpired(error)) {
          aborted = true;
          console.error(`  ${label} ABORT — ${error.message}`);
          break;
        }
        failedCount++;
        const message = error instanceof Error ? error.message : String(error);
        progress = recordOutcome(progress, funnelId, { status: 'failed', at: now(), error: message }, now());
        console.error(`  ${label} FAILED — ${message}`);
      }

      await saveProgress(args.app, progress);
      if (args.delayMs > 0) await sleep(args.delayMs);
    }

    await writeFile(
      join('artifacts', args.app, 'requests.log.json'),
      JSON.stringify(session.guard, null, 2),
      'utf8',
    );
  } finally {
    await saveProgress(args.app, progress);
    await closeSession(session);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const done = Object.values(progress.entries).filter((e) => e.status === 'done').length;
  const nonGet = session.guard.blocked.filter((b) => b.reason === 'non-get');

  console.log(`\n  extracted ${completed}, failed ${failedCount}, ${elapsed}s elapsed`);
  console.log(`  ${done}/${allIds.length} campaigns complete overall`);
  console.log(
    `  requests: ${session.guard.allowed.length} allowed, ${session.guard.blocked.length} blocked ` +
      `(${nonGet.length} non-GET)`,
  );
  if (aborted) {
    console.log(`  run aborted — re-run:  npm run login -- --app ${args.app}`);
  }
  console.log('');

  if (aborted || failedCount > 0) process.exitCode = 1;
}

await main();
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add after `"enumerate"`:

```json
    "extract-all": "tsx src/cli/extractAll.ts",
```

- [ ] **Step 3: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: PASS, no type errors.

- [ ] **Step 4: Verify argument handling without launching a browser**

```bash
npx tsx src/cli/extractAll.ts
npx tsx src/cli/extractAll.ts --app "../../../etc"
npx tsx src/cli/extractAll.ts --app jordan --limit 0
npx tsx src/cli/extractAll.ts --app nosuchapp
```

Expected, in order: the usage line; `Invalid app name "../../../etc"`; `Invalid --limit "0"`; and
`No campaign list at artifacts/nosuchapp/campaigns.json. Run: npm run enumerate -- --app nosuchapp`.
No Chromium window in any case.

- [ ] **Step 5: Commit**

```bash
git add src/cli/extractAll.ts package.json && git commit -m "feat: add resumable bulk extraction across an app's campaign list"
```

---

### Task 5: Live verification and findings

**Files:**
- Modify: `docs/spike-findings.md`

**Interfaces:**
- Consumes: everything from Tasks 1–4
- Produces: `artifacts/jordan/campaigns/*` for the whole account, `artifacts/jordan/progress.json`

Needs a valid session. Sessions have been observed lapsing in roughly 30 minutes; if anything below
reports expiry, re-run `npm run login -- --app jordan`.

- [ ] **Step 1: Extract five campaigns**

```bash
npm run extract-all -- --app jordan --limit 5
```

Expected: five `ok` lines, `extracted 5, failed 0`, and `artifacts/jordan/progress.json` written.

- [ ] **Step 2: Confirm a re-run does nothing**

```bash
npm run extract-all -- --app jordan --limit 5
```

Expected: `nothing to do` — the five already-complete campaigns are skipped, and **no browser is
launched**, because the queue is computed before the session opens.

- [ ] **Step 3: Prove resume actually resumes**

Delete one completed campaign's artifacts, then re-run:

```bash
ls artifacts/jordan/campaigns | head -1
```

Take that funnelId, remove its directory, and re-run with the same limit. Expected: exactly that one
campaign re-extracts, and the reconciliation warning names it. This is the property the whole task
exists for — verify it rather than assuming.

- [ ] **Step 4: Run the full account**

```bash
npm run extract-all -- --app jordan
```

Expected: the remaining ~165 campaigns, roughly six minutes at 1.75s plus a 250ms delay each.
Record the real elapsed time, the failure count, and any campaign that failed with its reason.

- [ ] **Step 5: Cross-check progress against disk**

```bash
node --input-type=module -e "import{readFileSync,readdirSync}from'node:fs';const p=JSON.parse(readFileSync('artifacts/jordan/progress.json','utf8'));const done=Object.entries(p.entries).filter(([,e])=>e.status==='done').map(([id])=>id);const dirs=readdirSync('artifacts/jordan/campaigns');console.log('progress done:',done.length,' directories:',dirs.length);console.log('done but no dir:',done.filter(id=>!dirs.includes(id)));console.log('dir but not done:',dirs.filter(id=>!done.includes(id)));"
```

Expected: the two counts match, and both mismatch lists are empty. A non-empty list means the
progress record and the artifacts disagree — exactly the drift this design set out to prevent.

- [ ] **Step 6: Survey the corpus for unknown node styles**

```bash
node --input-type=module -e "import{readFileSync,readdirSync}from'node:fs';const known=new Set(['newsletterRequest','purchaseSuccess','decision','flow','start','timerDelay','email','bardEmail','task','notes','edge','tag','tagApplied','(none)']);const seen=new Map();for(const id of readdirSync('artifacts/jordan/campaigns')){try{const m=JSON.parse(readFileSync('artifacts/jordan/campaigns/'+id+'/meta.json','utf8'));for(const[s,n]of Object.entries(m.inventory.styleCounts))seen.set(s,(seen.get(s)??0)+n);}catch{}}const unknown=[...seen].filter(([s])=>!known.has(s)).sort((a,b)=>b[1]-a[1]);console.log('distinct styles:',seen.size);console.log('NOT yet documented:',unknown);"
```

This is the first look at the full style vocabulary. The handoff documented 10 and the first two
campaigns added 4 more, so a long tail is expected — and the stage-2 normaliser's step taxonomy
depends on knowing it.

- [ ] **Step 7: Record the findings**

Append a `Bulk extraction` section to `docs/spike-findings.md` covering: real elapsed time for the
full account versus the 1.75s-per-campaign estimate; the failure count and any recurring cause;
whether the session survived the whole run; the progress-versus-disk cross-check result; and the
full style vocabulary from Step 6, calling out every style not previously documented.

- [ ] **Step 8: Commit**

```bash
git add docs/spike-findings.md && git commit -m "docs: record bulk extraction results and the full style vocabulary"
```

---

## Definition of Done

1. `npm run extract-all -- --app jordan --limit 5` extracts five campaigns and writes `progress.json`.
2. An immediate re-run reports `nothing to do` and launches no browser.
3. Deleting one campaign's directory and re-running re-extracts exactly that campaign, with a warning naming it.
4. A full run completes the account; progress `done` count equals the number of campaign directories.
5. Session expiry aborts the run and leaves the in-flight campaign pending, not failed.
6. Zero non-GET requests reach the network.
7. The full suite passes offline.
8. The complete style vocabulary is recorded in `docs/spike-findings.md`.
