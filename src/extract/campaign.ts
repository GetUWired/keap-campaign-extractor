import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { assertAuthenticated } from '../auth/session.js';
import { BASE_URL } from '../config.js';

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

const EDITOR_TIMEOUT_MS = 30_000;

export async function extractCampaign(page: Page, funnelId: string): Promise<CampaignRaw> {
  const url = `${BASE_URL}/app/funnel/funnelEditor?funnelId=${encodeURIComponent(funnelId)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  assertAuthenticated(page);

  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('campaign-editor') as { draftXml?: unknown } | null;
        return typeof el?.draftXml === 'string' && el.draftXml.length > 0;
      },
      undefined,
      { timeout: EDITOR_TIMEOUT_MS },
    );
  } catch {
    const title = await page.title();
    throw new Error(
      `campaign-editor never produced draftXml for funnelId=${funnelId} ` +
        `after ${EDITOR_TIMEOUT_MS}ms. Final URL: ${page.url()} — page title: "${title}"`,
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
