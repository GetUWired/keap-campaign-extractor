import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { campaignDirFor, verifyIdentity } from '../app.js';
import type { Session } from '../auth/session.js';
import { type CellInventory, parseCells, parseIdentity } from '../parse/cells.js';
import { extractCampaign } from './campaign.js';
import { fetchDecision } from './decision.js';

export interface DecisionOutcome {
  cellId: string;
  hit: boolean;
  branches: number;
  attempts: number;
  warnings: string[];
}

export interface CampaignRunResult {
  funnelId: string;
  appName: string | null;
  funnelName: string | null;
  outDir: string;
  draftXmlLength: number;
  publishXmlLength: number;
  inventory: CellInventory;
  decisions: DecisionOutcome[];
}

/** The disk predicate `reconcile` consumes: both core artifacts present. */
export function isCampaignComplete(app: string, funnelId: string): boolean {
  const dir = campaignDirFor(app, funnelId);
  return existsSync(join(dir, 'draft.xml')) && existsSync(join(dir, 'meta.json'));
}

/**
 * Extracts one campaign and writes its artifacts.
 *
 * Identity is verified before any directory is created, so a refused campaign
 * leaves nothing behind. SessionExpiredError propagates untouched: only the
 * caller knows whether that should abort a whole run.
 *
 * Deliberately does not write requests.log.json and does not print. The guard
 * log is session-wide — in a bulk run it accumulates across every campaign, so
 * writing it per campaign would store the same growing log once per campaign.
 * Callers format their own output.
 */
export async function extractOne(
  session: Session,
  page: Page,
  app: string,
  funnelId: string,
): Promise<CampaignRunResult> {
  const campaign = await extractCampaign(page, session.baseUrl, funnelId);

  const identity = parseIdentity(campaign.draftXml);
  const check = verifyIdentity({ app, funnelId }, identity);
  if (!check.ok) {
    throw new Error(`identity check failed — ${check.errors.join('; ')}`);
  }

  const inventory = parseCells(campaign.draftXml);
  const outDir = campaignDirFor(app, funnelId);
  const decisionsDir = join(outDir, 'decisions');
  // Clear prior decision output first. A stale .attempt-N.html from a failed
  // run sitting beside a successful .html reads as though both happened.
  await rm(decisionsDir, { recursive: true, force: true });
  await mkdir(decisionsDir, { recursive: true });

  await writeFile(join(outDir, 'draft.xml'), campaign.draftXml, 'utf8');
  await writeFile(join(outDir, 'publish.xml'), campaign.publishXml, 'utf8');

  const { draftXml, publishXml, ...meta } = campaign;
  await writeFile(
    join(outDir, 'meta.json'),
    JSON.stringify(
      {
        appName: identity.appName ?? app,
        ...meta,
        publishXmlLength: publishXml.length,
        neverPublished: publishXml.length === 0,
        inventory,
      },
      null,
      2,
    ),
    'utf8',
  );

  const decisions: DecisionOutcome[] = [];
  for (const cell of inventory.decisions) {
    const result = await fetchDecision(session.context, session.baseUrl, cell);

    if (result.html && result.criteria) {
      await writeFile(join(decisionsDir, `${cell.cellId}.html`), result.html, 'utf8');
      await writeFile(
        join(decisionsDir, `${cell.cellId}.json`),
        JSON.stringify(result.criteria, null, 2),
        'utf8',
      );
      decisions.push({
        cellId: cell.cellId,
        hit: true,
        branches: result.criteria.wrappers.length,
        attempts: result.attempts.length,
        warnings: result.criteria.warnings,
      });
    } else {
      for (const [index, body] of result.missBodies.entries()) {
        await writeFile(
          join(decisionsDir, `${cell.cellId}.attempt-${index + 1}.html`),
          body,
          'utf8',
        );
      }
      decisions.push({
        cellId: cell.cellId,
        hit: false,
        branches: 0,
        attempts: result.attempts.length,
        warnings: [],
      });
    }
  }

  return {
    funnelId,
    appName: identity.appName,
    funnelName: campaign.funnelName,
    outDir,
    draftXmlLength: draftXml.length,
    publishXmlLength: publishXml.length,
    inventory,
    decisions,
  };
}
