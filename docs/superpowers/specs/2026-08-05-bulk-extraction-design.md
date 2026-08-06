# Bulk Extraction with Resumable Progress — Design

Date: 2026-08-05
Status: approved, ready for implementation planning
Builds on: `2026-08-04-campaign-enumeration-design.md`, `2026-08-04-multi-app-support-design.md`
Evidence: `docs/spike-findings.md`

## 1. Context

Enumeration produces `artifacts/<app>/campaigns.json` — 170 campaigns for `jordan`. The extractor
handles one campaign per invocation. Nothing walks the list.

Two measured facts shape this design:

- **Extraction costs about 1.75s per campaign once warm.** Measured across three campaigns through a
  reused session: browser launch 0.48s one-time, then 1.64s and 1.84s. The first campaign of a run
  cost 6.12s paying for TLS and cache warming. Parsing is sub-millisecond; the cost is entirely
  network.
- **Sessions have been observed lapsing in roughly 30 minutes**, three times, despite the app
  declaring `sessionTimeoutLength = 7200`.

At 1.75s plus throttling, 170 campaigns is around six minutes and 398 around fifteen — both
comfortably inside a session. **Resumability is therefore insurance against a mid-run death, not
something the run depends on.** That framing matters: it argues against building keepAlive
machinery, and for making a resumed run cheap.

## 2. Goal

Walk the enumerated list for an app, extract every campaign, and survive process death or session
expiry without losing completed work or requiring a full re-run.

## 3. Non-goals

- **Session keepAlive.** A full account fits inside one session; resuming is cheaper than fighting
  whatever expires at 30 minutes.
- Parallelism. Sequential extraction is fast enough, and concurrency against a live marketing system
  is a risk with no measured benefit.
- Re-enumeration. The bulk runner consumes `campaigns.json`; it does not refresh it.
- Age-based refresh. Deferred until there is evidence about how often client campaigns change.
- Normalising, enriching or rendering. This produces raw artifacts only.

## 4. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Progress record | A separate `artifacts/<app>/progress.json` | Chosen for readability: one place shows what is done, failed and pending. |
| Drift mitigation | Verify against disk on load | The known cost of a second source of truth is that it can disagree with reality. Entries claiming `done` whose artifacts are absent are demoted to pending, so the file cannot silently lie. |
| Per-campaign failure | Record and continue | One malformed campaign must not cost the other 169. |
| Session expiry | Abort the run immediately | Every subsequent campaign would fail identically, turning one real problem into 150 lines of noise. |
| Expiry detection | A typed `SessionExpiredError` | String-matching an error message breaks silently the first time the message is reworded. |
| Re-runs | Skip completed; `--force` re-extracts | Repeated runs stay fast; a full refresh is one flag. |
| Shared extraction | Extract `spike.ts`'s per-campaign logic into a module | The bulk runner needs exactly that logic. Two copies would drift. |

## 5. Architecture

### 5.1 `src/errors.ts`

```ts
export class SessionExpiredError extends Error {
  constructor(message: string);
}
export function isSessionExpired(error: unknown): error is SessionExpiredError;
```

`assertAuthenticated` and `assertResponseAuthenticated` in `src/auth/session.ts` throw this instead
of a bare `Error`. Existing callers that only print `error.message` are unaffected.

### 5.2 `src/progress.ts` — pure, plus two small I/O helpers

```ts
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

export function emptyProgress(app: string, total: number, enumeratedAt: string | null, now: string): Progress;
export function pendingFunnelIds(progress: Progress, allIds: string[], force: boolean): string[];
export function recordOutcome(progress: Progress, funnelId: string, entry: ProgressEntry): Progress;
export function reconcile(progress: Progress, completed: (funnelId: string) => boolean): {
  progress: Progress;
  demoted: string[];
};

export function progressPathFor(app: string): string;
export function loadProgress(app: string): Promise<Progress | null>;
export function saveProgress(app: string, progress: Progress): Promise<void>;
```

`reconcile` takes a predicate rather than touching the filesystem, so the drift logic is testable
offline. The caller supplies a predicate that checks for `draft.xml` and `meta.json`.

`saveProgress` writes to a temporary file and renames, so a kill mid-write cannot corrupt the record.

### 5.3 `src/extract/campaignRun.ts`

```ts
export interface CampaignRunResult {
  funnelId: string;
  cells: number;
  decisions: number;
  decisionMisses: string[];
  warnings: string[];
  outDir: string;
}

export function isCampaignComplete(app: string, funnelId: string): boolean;
export function extractOne(
  session: Session,
  page: Page,
  app: string,
  funnelId: string,
): Promise<CampaignRunResult>;
```

This is `spike.ts`'s body, moved: extract, verify identity before writing anything, clear the
decisions directory, write artifacts, fetch and write each decision. It throws on identity mismatch
and propagates `SessionExpiredError` untouched.

`isCampaignComplete` is the disk predicate `reconcile` consumes — `draft.xml` and `meta.json` both
present.

**`spike.ts` is rewritten to call `extractOne`**, keeping its existing output and flags.

### 5.4 `src/cli/extractAll.ts`

```bash
npm run extract-all -- --app jordan [--force] [--limit <n>] [--delay <ms>] [--headed]
```

Flow:

1. Load `artifacts/<app>/campaigns.json`. Absent → fail pointing at `npm run enumerate`.
2. Load or create `progress.json`.
3. Reconcile against disk; report demotions.
4. Warn if `progress.enumeratedAt` differs from `campaigns.json`'s — the queue has changed underneath.
5. Compute the queue: everything not `done`, or everything if `--force`. Apply `--limit`.
6. For each: extract, record the outcome, save progress, then wait `--delay`.
7. Print a final report: completed, failed, remaining, elapsed.

`--delay` defaults to 250ms. `--limit` exists so a change can be tried against five campaigns rather
than 170.

Progress is saved after **every** campaign. At ~1.75s each the write cost is irrelevant next to
losing the record.

## 6. Failure handling

| Condition | Behaviour |
|---|---|
| `campaigns.json` missing | Fail, naming `npm run enumerate -- --app <app>`. |
| `progress.json` corrupt | Warn and start fresh rather than crash. Artifacts on disk are unaffected, and reconciliation restores the completed set on the next run. |
| Entry says `done`, artifacts absent | Demote to pending, warn naming the funnelId. |
| `enumeratedAt` mismatch | Warn. The run proceeds — a re-enumeration adding campaigns is normal — but silence would hide a queue swapped underneath a resume. |
| Per-campaign error | Record `status: 'failed'` with the message, continue. |
| Identity mismatch | Treated as a per-campaign failure. It cannot be systemic: the app was verified when the session opened. |
| `SessionExpiredError` | **Abort.** The in-flight campaign is left *pending*, not recorded as failed — it did not fail on its merits and must be retried on resume. Every prior campaign is already saved, so resuming costs only that one. Report how far it got and name the login command. |
| Zero pending campaigns | Report "nothing to do" and exit 0. Not an error. |

Exit code is 1 if any campaign failed or the run aborted; 0 otherwise.

## 7. Testing

Offline, no browser:

- `pendingFunnelIds` skips `done`, includes `failed` and unknown ids, and returns everything under
  `--force`.
- `recordOutcome` is immutable and updates `updatedAt`.
- `reconcile` demotes a `done` entry whose predicate returns false, names it, and leaves `failed`
  and pending entries alone.
- `emptyProgress` carries `enumeratedAt` through.
- `isSessionExpired` recognises the typed error and rejects a plain `Error` with similar text —
  the specific reason for making it typed.
- Round-tripping `Progress` through JSON preserves every field.

Live: a `--limit 5` run, then a deliberate resume (delete one campaign's directory, re-run, confirm
only that one re-extracts), then the full 170.

## 8. Success criteria

1. `npm run extract-all -- --app jordan --limit 5` extracts five campaigns and writes `progress.json`.
2. Re-running immediately reports nothing to do and makes no requests.
3. Deleting one campaign's directory and re-running re-extracts exactly that campaign.
4. A full run completes all 170, and the progress totals match the artifact directories on disk.
5. Session expiry aborts rather than failing every remaining campaign.
6. Zero non-GET requests reach the network.
7. The full suite passes offline.
