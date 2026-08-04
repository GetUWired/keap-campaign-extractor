import { chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { BASE_URL, STATE_PATH } from '../config.js';

/**
 * One-time interactive login.
 *
 * No read-only guard is installed here: submitting the sign-in form requires a
 * POST, and a human is driving. This is the only place in the codebase that
 * touches a non-GET request. Every non-interactive entry point goes through
 * openSession(), which always installs the guard.
 */
async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(BASE_URL);

  console.log(`\nA browser window is open at ${BASE_URL}.`);
  console.log('Log in to Keap there, wait until you can see the dashboard, then return here.');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter once you are logged in... ');
  rl.close();

  await context.storageState({ path: STATE_PATH });
  await chmod(STATE_PATH, 0o600);
  await browser.close();

  console.log(`\nSaved session to ${STATE_PATH} (mode 600).`);
  console.log('This file contains live session cookies. It is gitignored — keep it that way.');
}

await main();
