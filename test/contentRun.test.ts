import { describe, expect, it } from 'vitest';
import type { AssetLedger } from '../src/content/assets/assetStore.js';
import type { AssetFetcher, AssetRecord } from '../src/content/assets/download.js';
import { type RunDeps, fetchItem } from '../src/content/run.js';
import {
  ContentNotFoundError,
  type ContentItemKey,
  type ContentSource,
  type FetchedContent,
} from '../src/content/types.js';
import { SessionExpiredError } from '../src/errors.js';

const KEY: ContentItemKey = { kind: 'email', attribute: 'marketingEmailId', id: '2048' };

const EMAIL: FetchedContent = {
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
    attachments: [{ name: 'guide.pdf', url: 'https://se232.infusionsoft.com/Download?Id=9' }],
  },
  files: [
    {
      name: 'body.html',
      body: '<link rel="stylesheet" href="https://cdn.example.com/s.css"><img src="https://cdn.example.com/logo.png">',
    },
  ],
  evidence: [],
  assetUrls: [],
};

function source(results: (FetchedContent | Error)[], validate?: ContentSource['validate']) {
  let calls = 0;
  const src: ContentSource = {
    kind: 'email',
    attributes: ['marketingEmailId'],
    needsApiKey: false,
    needsBrowser: true,
    async fetch() {
      const next = results[Math.min(calls, results.length - 1)];
      calls++;
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error('no result');
      return next;
    },
    validate: validate ?? (() => null),
  };
  return { src, calls: () => calls };
}

function memoryLedger(): AssetLedger & { records: Record<string, AssetRecord> } {
  const records: Record<string, AssetRecord> = {};
  const bytes: Record<string, Buffer> = {};
  return {
    records,
    get: (url) => records[url],
    async put(record, data) {
      records[record.url] = record;
      if (data) bytes[record.url] = data;
    },
    async read(record) {
      return bytes[record.url] ?? null;
    },
  };
}

const serve =
  (bodies: Record<string, { body: string; type: string } | number>): AssetFetcher =>
  async (url) => {
    const entry = bodies[url];
    if (entry === undefined || typeof entry === 'number') {
      return {
        status: typeof entry === 'number' ? entry : 404,
        contentType: null,
        contentLength: 0,
        location: null,
        body: async () => Buffer.alloc(0),
      };
    }
    const data = Buffer.from(entry.body);
    return {
      status: 200,
      contentType: entry.type,
      contentLength: data.length,
      location: null,
      body: async () => data,
    };
  };

function deps(src: ContentSource, ledger = memoryLedger()) {
  const saved: { key: ContentItemKey; assetUrls: string[] }[] = [];
  const d: RunDeps = {
    sources: { email: src },
    ctx: { app: 'se232', baseUrl: 'https://se232.infusionsoft.com', browser: null, api: null },
    fetchers: {
      keap: serve({ 'https://se232.infusionsoft.com/Download?Id=9': { body: 'pdf', type: 'application/pdf' } }),
      anonymous: serve({
        'https://cdn.example.com/s.css': { body: 'body{background:url(bg.png)}', type: 'text/css' },
        'https://cdn.example.com/logo.png': { body: 'png', type: 'image/png' },
        'https://cdn.example.com/bg.png': 500,
      }),
    },
    assets: ledger,
    saveItem: async (key, _fetched, assetUrls) => {
      saved.push({ key, assetUrls });
    },
  };
  return { d, saved, ledger };
}

describe('fetchItem', () => {
  it('stores the item with every asset, following stylesheets one level', async () => {
    const { d, saved, ledger } = deps(source([EMAIL]).src);
    const outcome = await fetchItem(KEY, d);

    expect(outcome).toEqual({
      status: 'done',
      assets: { downloaded: 3, failed: 1, tooLarge: 0, skipped: 0 },
    });
    // Traversal order: HTML (img before link), then attachments, then stylesheet dependencies.
    expect(saved[0]?.assetUrls).toEqual([
      'https://cdn.example.com/logo.png',
      'https://cdn.example.com/s.css',
      'https://se232.infusionsoft.com/Download?Id=9',
      'https://cdn.example.com/bg.png',
    ]);
    expect(ledger.records['https://cdn.example.com/bg.png']?.status).toBe('failed');
  });

  it('retries an invalid response once and succeeds', async () => {
    let seen = 0;
    const { src, calls } = source([EMAIL], () => (seen++ === 0 ? 'empty shell' : null));
    const { d } = deps(src);
    expect((await fetchItem(KEY, d)).status).toBe('done');
    expect(calls()).toBe(2);
  });

  it('fails an item that stays invalid, and stores nothing', async () => {
    const { d, saved } = deps(source([EMAIL], () => 'empty shell').src);
    expect(await fetchItem(KEY, d)).toEqual({ status: 'failed', error: 'empty shell' });
    expect(saved).toEqual([]);
  });

  it('rejects a record of the wrong kind', async () => {
    const sms: FetchedContent = {
      ...EMAIL,
      record: { kind: 'sms', name: null, text: 'x', sender: null },
    };
    const { d } = deps(source([sms]).src);
    expect((await fetchItem(KEY, d)).error).toMatch(/sms record for a email/);
  });

  it('records a deleted template as notFound without retrying', async () => {
    const { src, calls } = source([new ContentNotFoundError('404')]);
    const { d } = deps(src);
    expect(await fetchItem(KEY, d)).toEqual({ status: 'notFound', error: '404' });
    expect(calls()).toBe(1);
  });

  it('lets session expiry stop the run', async () => {
    const { d } = deps(source([new SessionExpiredError('expired')]).src);
    await expect(fetchItem(KEY, d)).rejects.toThrow(/expired/);
  });

  it('reuses assets already in the ledger', async () => {
    const ledger = memoryLedger();
    await ledger.put({ url: 'https://cdn.example.com/logo.png', status: 'downloaded', file: 'x.png' }, null);
    const { d } = deps(source([EMAIL]).src, ledger);
    let anonymousCalls = 0;
    const inner = d.fetchers.anonymous;
    d.fetchers.anonymous = async (url) => {
      anonymousCalls++;
      return inner(url);
    };
    await fetchItem(KEY, d);
    expect(anonymousCalls).toBe(2); // s.css and bg.png, not logo.png
  });

  it('fails one item, rather than the run, when saving it throws', async () => {
    const { d } = deps(source([EMAIL]).src);
    d.saveItem = async () => {
      throw new Error('Unsafe content file name: ../evil.html');
    };
    expect(await fetchItem(KEY, d)).toEqual({
      status: 'failed',
      error: 'Unsafe content file name: ../evil.html',
    });
  });

  it('fails one item when recording its assets throws', async () => {
    const ledger = memoryLedger();
    ledger.put = async () => {
      throw new Error('disk full');
    };
    const { d, saved } = deps(source([EMAIL]).src, ledger);
    expect(await fetchItem(KEY, d)).toEqual({ status: 'failed', error: 'disk full' });
    expect(saved).toEqual([]);
  });

  it('still lets session expiry from an asset download stop the run', async () => {
    const { d } = deps(source([EMAIL]).src);
    d.fetchers.keap = async () => {
      throw new SessionExpiredError('expired while downloading');
    };
    await expect(fetchItem(KEY, d)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('fails clearly when no source serves the id space', async () => {
    const { d } = deps(source([EMAIL]).src);
    const outcome = await fetchItem({ kind: 'form', attribute: 'webformId', id: '1' }, d);
    expect(outcome).toEqual({ status: 'failed', error: 'no source reads form webformId yet' });
  });
});
