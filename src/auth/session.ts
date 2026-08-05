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
 *
 * The app name is validated here as well as at the CLI boundary, so no caller
 * can reach the filesystem or the network with an unchecked value.
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
    throw new Error(
      `Session expired — landed on ${url}. Re-run:  npm run login -- --app <appName>`,
    );
  }
}

/**
 * Throws if an API response was redirected to a sign-in screen.
 *
 * safeGet has no Page, so assertAuthenticated cannot cover it. An expired
 * session there returns HTTP 200 with login markup, which every parser then
 * reports as unrecognised content — sending the reader after a parser bug when
 * the actual fix is to log in again.
 */
export function assertResponseAuthenticated(response: { url(): string }): void {
  const url = response.url();
  if (LOGIN_URL_PATTERN.test(url)) {
    throw new Error(
      `Session expired — request was redirected to ${url}. ` +
        'Re-run:  npm run login -- --app <appName>',
    );
  }
}
