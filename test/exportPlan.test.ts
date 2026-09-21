import { describe, expect, it } from 'vitest';
import type { AssetRecord } from '../src/content/assets/download.js';
import type { ItemStatus } from '../src/content/progress.js';
import type { StoredItem } from '../src/content/store.js';
import { itemKey } from '../src/content/types.js';
import { type ExportInput, type PlannedFile, planExport } from '../src/export/plan.js';
import { makeCampaign, makeNode, makeSequence } from './fixtures/graphFixtures.js';

const emailNode = (cellId: string, id: string) =>
  makeNode({
    cellId,
    style: 'email',
    parent: '5',
    name: `Email ${id}`,
    references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
  });
const httpNode = makeNode({
  cellId: '9',
  style: 'http',
  parent: '5',
  references: { tagIds: [], tagCategoryIds: [], httpRequestConfigId: '77' },
});

const campaign = (funnelId: string, name: string, nodes: ReturnType<typeof makeNode>[]) => ({
  funnelId,
  summary: null,
  publishNodes: [],
  normalized: makeCampaign({
    funnelId,
    name,
    sequences: [
      makeSequence({ cellId: '5', steps: nodes.map((n, position) => ({ ...n, position })) }),
    ],
  }),
});

const EMAIL_KEY = { kind: 'email' as const, attribute: 'marketingEmailId', id: '2048' };
const HTTP_KEY = { kind: 'http' as const, attribute: 'httpRequestConfigId', id: '77' };
const LOGO = 'https://cdn.example.com/logo.png';
const PDF = 'https://se232.infusionsoft.com/Download?Id=9';

const items = new Map<string, StoredItem>([
  [
    itemKey(EMAIL_KEY),
    {
      key: EMAIL_KEY,
      fetchedAt: 't',
      dir: '/raw/email/2048',
      files: ['body.html'],
      assetUrls: [LOGO, PDF],
      record: {
        kind: 'email',
        name: 'Welcome',
        from: 'team@example.com',
        replyTo: null,
        to: '~Contact.Email~',
        cc: null,
        bcc: null,
        subject: 'Hi ~Contact.FirstName~',
        previewText: null,
        attachments: [{ name: 'Price List.pdf', url: PDF }],
      },
    },
  ],
  [
    itemKey(HTTP_KEY),
    {
      key: HTTP_KEY,
      fetchedAt: 't',
      dir: '/raw/http/77',
      files: [],
      assetUrls: [],
      record: {
        kind: 'http',
        name: 'Hook',
        method: 'POST',
        url: 'https://hooks.example.com/x?token=abc',
        headers: [],
        fields: [],
        body: null,
      },
    },
  ],
]);

const assets: Record<string, AssetRecord> = {
  [LOGO]: { url: LOGO, status: 'downloaded', file: `${'a'.repeat(64)}.png`, size: 3 },
  [PDF]: { url: PDF, status: 'downloaded', file: `${'b'.repeat(64)}.pdf`, size: 9 },
};

function input(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    app: 'se232',
    exportedAt: '2026-09-21T00:00:00.000Z',
    includeSecrets: false,
    campaigns: [
      campaign('1', 'Welcome Series', [emailNode('7', '2048'), httpNode]),
      campaign('2', 'Re-engagement', [emailNode('3', '2048'), emailNode('4', '999')]),
    ],
    items,
    statuses: new Map<string, ItemStatus>([['email:marketingEmailId:999', 'notFound']]),
    assets,
    assetSource: (file) => `/assets/${file}`,
    readText: (path) => (path === '/raw/email/2048/files/body.html' ? '<p>Hi ~Contact.FirstName~</p>' : ''),
    ...overrides,
  };
}

const byPath = (files: PlannedFile[]) => new Map(files.map((f) => [f.path, f]));
const json = (file: PlannedFile | undefined) =>
  JSON.parse(file && 'data' in file ? file.data.toString() : 'null');

describe('planExport', () => {
  const plan = planExport(input());
  const files = byPath(plan.files);

  it('gives every campaign its own folder with a campaign.json', () => {
    expect(files.has('campaigns/1-welcome-series/campaign.json')).toBe(true);
    expect(files.has('campaigns/2-re-engagement/campaign.json')).toBe(true);
  });

  it('copies shared content into each campaign and says who else uses it', () => {
    const first = json(files.get('campaigns/1-welcome-series/emails/2048/email.json'));
    const second = json(files.get('campaigns/2-re-engagement/emails/2048/email.json'));
    expect(first.sharedWith).toEqual([{ funnelId: '2', name: 'Re-engagement' }]);
    expect(second.sharedWith).toEqual([{ funnelId: '1', name: 'Welcome Series' }]);
    expect(first).toMatchObject({ id: '2048', idAttribute: 'marketingEmailId', subject: 'Hi ~Contact.FirstName~' });
    expect(first.mergeFields).toEqual(['~Contact.Email~', '~Contact.FirstName~']);
  });

  it('copies body files and derives body.txt when Keap gave none', () => {
    expect(files.get('campaigns/1-welcome-series/emails/2048/body.html')).toEqual({
      path: 'campaigns/1-welcome-series/emails/2048/body.html',
      copyFrom: '/raw/email/2048/files/body.html',
    });
    const text = files.get('campaigns/1-welcome-series/emails/2048/body.txt');
    expect(text && 'data' in text ? text.data : null).toBe('Hi ~Contact.FirstName~');
    expect(json(files.get('campaigns/1-welcome-series/emails/2048/email.json')).textDerivedFromHtml).toBe(true);
  });

  it('copies attachments under a safe name and assets per campaign', () => {
    expect(files.get('campaigns/1-welcome-series/emails/2048/attachments/Price_List.pdf')).toMatchObject({
      copyFrom: `/assets/${'b'.repeat(64)}.pdf`,
    });
    expect(files.has(`campaigns/2-re-engagement/assets/${'a'.repeat(64)}.png`)).toBe(true);
    const assetsJson = json(files.get('campaigns/1-welcome-series/assets/assets.json'));
    expect(assetsJson[0]).toMatchObject({ url: LOGO, status: 'downloaded', file: `assets/${'a'.repeat(64)}.png` });
  });

  it('redacts HTTP secrets by default and lists them', () => {
    const http = json(files.get('campaigns/1-welcome-series/http/77.json'));
    expect(http.url).toBe('https://hooks.example.com/x?token=«redacted»');
    expect(http.redacted).toEqual([{ location: 'query', name: 'token' }]);
    expect(plan.manifest.secretsIncluded).toBe(false);
  });

  it('keeps secrets only when asked, and says so', () => {
    const withSecrets = planExport(input({ includeSecrets: true }));
    const http = json(byPath(withSecrets.files).get('campaigns/1-welcome-series/http/77.json'));
    expect(http.url).toBe('https://hooks.example.com/x?token=abc');
    expect(http.secretsIncluded).toBe(true);
    expect(withSecrets.manifest.secretsIncluded).toBe(true);
  });

  it('shows missing content as a gap rather than dropping the step', () => {
    const doc = json(files.get('campaigns/2-re-engagement/campaign.json'));
    expect(doc.sequences[0].steps.map((s: { content: unknown[] }) => s.content[0])).toEqual([
      { kind: 'email', id: '2048', ref: 'emails/2048', version: 'draft' },
      { kind: 'email', id: '999', status: 'notFound', version: 'draft' },
    ]);
    expect(plan.manifest.content.email).toEqual({ exported: 2, failed: 0, notFound: 1, notFetched: 0 });
  });

  it('writes the manifest and an account-wide merge-field list', () => {
    expect(json(files.get('manifest.json'))).toMatchObject({
      formatVersion: 1,
      app: 'se232',
      campaignCount: 2,
      assets: { downloaded: 2, failed: 0, tooLarge: 0, skipped: 0 },
    });
    expect(json(files.get('merge-fields.json'))).toEqual([
      { field: '~Contact.Email~', campaignCount: 2, campaigns: ['1', '2'] },
      { field: '~Contact.FirstName~', campaignCount: 2, campaigns: ['1', '2'] },
    ]);
  });

  it('marks a stored item as stale when its latest fetch did not finish', () => {
    const stale = planExport(
      input({
        statuses: new Map<string, ItemStatus>([
          ['email:marketingEmailId:999', 'notFound'],
          [itemKey(EMAIL_KEY), 'failed'],
        ]),
      }),
    );
    const email = json(byPath(stale.files).get('campaigns/1-welcome-series/emails/2048/email.json'));
    expect(email).toMatchObject({ stale: true, fetchStatus: 'failed' });
    // No progress entry at all: still stale, status unknown.
    const http = json(byPath(stale.files).get('campaigns/1-welcome-series/http/77.json'));
    expect(http).toMatchObject({ stale: true, fetchStatus: 'unknown' });
  });

  it('does not mark an item stale when its fetch is done', () => {
    const fresh = planExport(
      input({
        statuses: new Map<string, ItemStatus>([
          [itemKey(EMAIL_KEY), 'done'],
          [itemKey(HTTP_KEY), 'done'],
        ]),
      }),
    );
    const email = json(byPath(fresh.files).get('campaigns/1-welcome-series/emails/2048/email.json'));
    expect(email.stale).toBeUndefined();
    expect(email.fetchStatus).toBeUndefined();
  });

  it('never plans a path outside the export', () => {
    for (const file of plan.files) expect(file.path).not.toMatch(/(^\/|\.\.)/);
  });
});
