import { existsSync } from 'node:fs';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { LOGIN_URL_PATTERN, STATE_PATH } from '../config.js';
import { type Guard, installReadOnlyGuard } from '../guard/readonly.js';

export interface Session {
  browser: Browser;
  context: BrowserContext;
  guard: Guard;
}

/**
 * Opens a browser context restored from the human-established session, with
 * the read-only guard always installed. This is the only entry point
 * extraction code may use.
 */
export async function openSession(options?: { headless?: boolean }): Promise<Session> {
  if (!existsSync(STATE_PATH)) {
    throw new Error(`No session file at ${STATE_PATH}. Run:  npm run login`);
  }

  const browser = await chromium.launch({ headless: options?.headless ?? true });
  const context = await browser.newContext({ storageState: STATE_PATH });
  const guard = installReadOnlyGuard(context);

  return { browser, context, guard };
}

export async function closeSession(session: Session): Promise<void> {
  await session.context.close();
  await session.browser.close();
}

/** Throws if the page has been bounced to a sign-in screen. */
export function assertAuthenticated(page: Page): void {
  const url = page.url();
  if (LOGIN_URL_PATTERN.test(url)) {
    throw new Error(`Session expired — landed on ${url}. Run:  npm run login`);
  }
}
