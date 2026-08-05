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
 * touches a non-GET request. Every non-interactive entry point goes through
 * openSession(), which always installs the guard.
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
