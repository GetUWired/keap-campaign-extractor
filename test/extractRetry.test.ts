import { describe, expect, it, vi } from 'vitest';
import { EDITOR_RETRY_TIMEOUT_MS, EDITOR_TIMEOUT_MS, extractCampaign } from '../src/extract/campaign.js';

/**
 * A page whose editor only produces draftXml once the caller waits long enough.
 * This is 11261's failure mode: a big campaign sitting just past the default.
 */
function slowEditorPage(readyAfterMs: number) {
  return {
    goto: vi.fn(async () => undefined),
    url: () => 'https://se232.infusionsoft.com/app/funnel/funnelEditor?funnelId=11261',
    title: async () => 'Africa Region Abandon Cart NEW',
    waitForFunction: vi.fn(async (_fn: unknown, _arg: unknown, opts: { timeout: number }) => {
      if (opts.timeout < readyAfterMs) throw new Error('Timeout exceeded');
      return undefined;
    }),
    evaluate: vi.fn(async () => ({
      draftXml: '<mxGraphModel></mxGraphModel>',
      publishXml: '',
      funnelName: 'Africa Region Abandon Cart NEW',
      maxCellId: '9',
      timezoneId: null,
      timezoneLabel: null,
      appBuild: null,
    })),
    content: async () => '<html></html>',
  } as never;
}

describe('editor timeout and retry', () => {
  it('fails at the default timeout for a campaign that loads too slowly', async () => {
    const page = slowEditorPage(60_000);
    await expect(extractCampaign(page, 'https://se232.infusionsoft.com', '11261')).rejects.toThrow(
      /never produced draftXml/,
    );
  });

  it('succeeds for the same campaign on the longer retry budget', async () => {
    // 673 cells, 17 decisions — it passed one week and failed the next.
    const page = slowEditorPage(60_000);
    const raw = await extractCampaign(
      page,
      'https://se232.infusionsoft.com',
      '11261',
      EDITOR_RETRY_TIMEOUT_MS,
    );
    expect(raw.funnelId).toBe('11261');
    expect(raw.draftXml.length).toBeGreaterThan(0);
  });

  it('names the budget it actually waited for, not the default', async () => {
    // The error said "after 30000ms" even when a different budget was used.
    const page = slowEditorPage(120_000);
    await expect(
      extractCampaign(page, 'https://se232.infusionsoft.com', '11261', EDITOR_RETRY_TIMEOUT_MS),
    ).rejects.toThrow(new RegExp(`after ${EDITOR_RETRY_TIMEOUT_MS}ms`));
  });

  it('keeps the default for an ordinary campaign', () => {
    expect(EDITOR_TIMEOUT_MS).toBe(30_000);
    expect(EDITOR_RETRY_TIMEOUT_MS).toBeGreaterThan(EDITOR_TIMEOUT_MS);
  });
});
