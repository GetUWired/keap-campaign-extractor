import type { BrowserContext } from 'playwright';
import { assertResponseAuthenticated } from '../auth/session.js';
import { safeGet } from '../guard/readonly.js';
import { type CampaignList, parseCampaignList } from '../parse/campaignList.js';

/** The report's own page-size selector tops out here; its tooltip mentions a 1000 mode. */
export const DEFAULT_PER_PAGE = 500;

/**
 * The Automations report.
 *
 * The UI changes page size by POSTing form data to ?view=gridGuts, which the
 * read-only guard blocks unconditionally. perPage is also honoured as a GET
 * parameter — verified against the live app, where perPage=500 returned all
 * 170 records against the default's 50. That keeps enumeration inside the
 * GET-only policy with no exception carved out for it.
 */
export function campaignListUrl(baseUrl: string, perPage: number = DEFAULT_PER_PAGE): string {
  return (
    `${baseUrl}/Reports/searchTemplate.jsp` +
    `?reportClass=SetupFunnel&view=resultsPage&perPage=${encodeURIComponent(String(perPage))}`
  );
}

export async function fetchCampaignList(
  context: BrowserContext,
  baseUrl: string,
  perPage: number = DEFAULT_PER_PAGE,
): Promise<CampaignList> {
  const response = await safeGet(context, campaignListUrl(baseUrl, perPage));
  // An expired session returns 200 with login markup, which would otherwise
  // surface as "this doesn't look like the automations list".
  assertResponseAuthenticated(response);
  return parseCampaignList(await response.text());
}
