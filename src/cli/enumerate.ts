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
    throw new Error(
      `Invalid --per-page ${JSON.stringify(rawPerPage)}. Expected a positive integer.`,
    );
  }

  return { app: normalizeAppName(rawApp), perPage, headed: argv.includes('--headed') };
}

/** Prints `message` without a stack trace and marks the run as failed. */
function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  // Bad arguments and a missing session are ordinary, user-fixable conditions,
  // handled before the fetch so they surface as messages rather than traces.
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

    // Any disagreement with the page's own count is a failure, in both
    // directions. Too few means a truncated list, which looks exactly like a
    // smaller account. Too many means rows are being double-counted — which
    // happened, and the extra row had every column shifted by one.
    if (list.total !== null && list.campaigns.length !== list.total) {
      const short = list.campaigns.length < list.total;
      fail(
        `count mismatch: parsed ${list.campaigns.length} campaigns but the page reports ` +
          `${list.total}. ${
            short
              ? 'Retry with a larger page size, e.g. --per-page 1000.'
              : 'Rows are being counted more than once — this is a parser bug, not a page-size problem.'
          }`,
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
    for (const campaign of list.campaigns) {
      for (const category of campaign.categories) {
        categories.set(category, (categories.get(category) ?? 0) + 1);
      }
    }

    console.log(`\n[${args.app}] ${list.campaigns.length} campaigns (page reports ${list.total})`);
    console.log(
      `  published: ${published}   never published: ${list.campaigns.length - published}`,
    );
    console.log(
      `  categories: ${
        categories.size === 0
          ? '(none)'
          : [...categories.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([name, count]) => `${name} ${count}`)
              .join(', ')
      }`,
    );

    const nonGet = session.guard.blocked.filter((b) => b.reason === 'non-get');
    console.log(
      `  requests: ${session.guard.allowed.length} allowed, ` +
        `${session.guard.blocked.length} blocked (${nonGet.length} non-GET)`,
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
