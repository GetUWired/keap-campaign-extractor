import { assertAuthenticated, closeSession, openSession } from './session.js';
import { isSessionExpired } from '../errors.js';

/**
 * Whether the saved session can still open a campaign.
 *
 * A session file on disk proves nothing: the one that failed on 12 October was
 * four days old, present, and bounced to the login screen on the first
 * campaign. Worse, `enumerate` had just succeeded against the same cookies —
 * the campaign list tolerated them and the funnel editor did not — so the only
 * honest check is the surface the extract actually uses.
 *
 * Costs one browser launch and one page load, against twenty wasted minutes.
 */
export async function probeSession(
  app: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let session: Awaited<ReturnType<typeof openSession>>;
  try {
    session = await openSession({ app, headless: true });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  try {
    const page = await session.context.newPage();
    // The campaign list page: authenticated, and cheaper than an editor.
    await page.goto(`${session.baseUrl}/Reports/searchTemplate.jsp?reportType=Funnel`, {
      waitUntil: 'domcontentloaded',
    });
    assertAuthenticated(page);
    return { ok: true };
  } catch (error) {
    if (isSessionExpired(error)) return { ok: false, reason: error.message };
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await closeSession(session);
  }
}
