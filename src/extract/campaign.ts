import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { assertAuthenticated } from '../auth/session.js';

export interface CampaignRaw {
  funnelId: string;
  draftXml: string;
  publishXml: string;
  funnelName: string | null;
  maxCellId: string | null;
  timezoneId: string | null;
  timezoneLabel: string | null;
  appBuild: string | null;
  extractedAt: string;
  draftXmlSha256: string;
}

export const EDITOR_TIMEOUT_MS = 30_000;

/**
 * A longer budget for a campaign that already timed out once.
 *
 * The editor's load time scales with the campaign: se232's 673-cell "Africa
 * Region Abandon Cart" sits right on the 30s edge, passing one week and
 * failing the next. Raising the limit for everything would make a genuinely
 * stuck page cost 90s times 415.
 */
export const EDITOR_RETRY_TIMEOUT_MS = 90_000;

export async function extractCampaign(
  page: Page,
  baseUrl: string,
  funnelId: string,
  timeoutMs: number = EDITOR_TIMEOUT_MS,
): Promise<CampaignRaw> {
  const url = `${baseUrl}/app/funnel/funnelEditor?funnelId=${encodeURIComponent(funnelId)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  assertAuthenticated(page);

  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('campaign-editor') as { draftXml?: unknown } | null;
        return typeof el?.draftXml === 'string' && el.draftXml.length > 0;
      },
      undefined,
      { timeout: timeoutMs },
    );
  } catch {
    const title = await page.title();
    throw new Error(
      `campaign-editor never produced draftXml for funnelId=${funnelId} ` +
        `after ${timeoutMs}ms. Final URL: ${page.url()} — page title: "${title}"`,
    );
  }

  // Reads DOM properties only. Inline script text is never touched: session
  // tokens are embedded near the campaign data in those scripts.
  const raw = await page.evaluate(() => {
    const editorEl = document.querySelector('campaign-editor') as {
      draftXml?: unknown;
      publishXml?: unknown;
    } | null;
    const shell = document.querySelector('#editor') as HTMLElement | null;

    // Best-effort: the handoff records the build string but not its source.
    const buildScript = Array.from(document.scripts)
      .map((s) => s.src)
      .find((src) => src.includes('sysarch'));
    const buildMatch = buildScript ? /(\d+\.\d+\.\d+\.\d+-sysarch-\d+)/.exec(buildScript) : null;

    return {
      draftXml: typeof editorEl?.draftXml === 'string' ? editorEl.draftXml : '',
      publishXml: typeof editorEl?.publishXml === 'string' ? editorEl.publishXml : '',
      funnelName: shell?.dataset.funnelname ?? null,
      maxCellId: shell?.dataset.maxcellid ?? null,
      timezoneId: shell?.dataset.newtimezoneid ?? null,
      timezoneLabel: shell?.dataset.timezonelabel ?? null,
      appBuild: buildMatch?.[1] ?? null,
    };
  });

  if (raw.draftXml.length === 0) {
    throw new Error(`draftXml was empty for funnelId=${funnelId}`);
  }

  return {
    funnelId,
    ...raw,
    extractedAt: new Date().toISOString(),
    draftXmlSha256: createHash('sha256').update(raw.draftXml, 'utf8').digest('hex'),
  };
}
