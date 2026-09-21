import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetFilePathFor, createAssetLedger } from '../src/content/assets/assetStore.js';
import {
  type AssetFetcher,
  type AssetResponse,
  anonymousFetcher,
  downloadAsset,
  extensionFor,
} from '../src/content/assets/download.js';
import { SessionExpiredError } from '../src/errors.js';

function respond(body: string, overrides: Partial<AssetResponse> = {}): AssetResponse {
  const bytes = Buffer.from(body);
  return {
    status: 200,
    contentType: 'image/png',
    contentLength: bytes.length,
    location: null,
    body: async () => bytes,
    ...overrides,
  };
}

function redirect(location: string, overrides: Partial<AssetResponse> = {}): AssetResponse {
  return {
    status: 302,
    contentType: null,
    contentLength: null,
    location,
    body: async () => Buffer.alloc(0),
    ...overrides,
  };
}

function recording(response: AssetResponse | Error) {
  const calls: string[] = [];
  const fetcher: AssetFetcher = async (url) => {
    calls.push(url);
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, fetcher };
}

describe('downloadAsset', () => {
  it('sends Keap-hosted URLs through the session and everything else anonymously', async () => {
    const keap = recording(respond('k'));
    const anonymous = recording(respond('a'));
    const fetchers = { keap: keap.fetcher, anonymous: anonymous.fetcher };

    await downloadAsset('https://se232.infusionsoft.com/a.png', fetchers);
    await downloadAsset('https://cdn.example.com/b.png', fetchers);

    expect(keap.calls).toEqual(['https://se232.infusionsoft.com/a.png']);
    expect(anonymous.calls).toEqual(['https://cdn.example.com/b.png']);
  });

  it('names a download by content hash', async () => {
    const { record, bytes } = await downloadAsset('https://cdn.example.com/b.png', {
      keap: recording(respond('')).fetcher,
      anonymous: recording(respond('hello')).fetcher,
    });
    expect(record).toMatchObject({
      status: 'downloaded',
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      file: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824.png',
      size: 5,
    });
    expect(bytes?.toString()).toBe('hello');
  });

  it('records HTTP failures without throwing', async () => {
    const { record } = await downloadAsset('https://cdn.example.com/x.png', {
      keap: recording(respond('')).fetcher,
      anonymous: recording(respond('', { status: 404 })).fetcher,
    });
    expect(record).toMatchObject({ status: 'failed', httpStatus: 404 });
  });

  it('refuses a declared size over the limit without reading the body', async () => {
    const { record, bytes } = await downloadAsset(
      'https://cdn.example.com/huge.mp4',
      {
        keap: recording(respond('')).fetcher,
        anonymous: recording(
          respond('', {
            contentLength: 100,
            body: async () => {
              throw new Error('body must not be read');
            },
          }),
        ).fetcher,
      },
      10,
    );
    expect(record.status).toBe('tooLarge');
    expect(bytes).toBeNull();
  });

  it('lets session expiry through so the run can stop', async () => {
    await expect(
      downloadAsset('https://se232.infusionsoft.com/a.png', {
        keap: recording(new SessionExpiredError('expired')).fetcher,
        anonymous: recording(respond('')).fetcher,
      }),
    ).rejects.toThrow(/expired/);
  });

  describe('redirects', () => {
    it('skips a redirect to a private address without following it', async () => {
      const anonymous = recording(redirect('http://127.0.0.1/x'));
      const keap = recording(respond(''));
      const { record } = await downloadAsset('https://cdn.example.com/a.png', {
        keap: keap.fetcher,
        anonymous: anonymous.fetcher,
      });
      expect(record.status).toBe('skipped');
      expect(record.reason).toMatch(/privateHost/);
      expect(anonymous.calls).toHaveLength(1);
      expect(keap.calls).toHaveLength(0);
    });

    it('routes a redirect from an anonymous host to a Keap host through the session fetcher', async () => {
      const anonymous = recording(redirect('https://se232.infusionsoft.com/f.png'));
      const keap = recording(respond('hello'));
      const { record } = await downloadAsset('https://cdn.example.com/a.png', {
        keap: keap.fetcher,
        anonymous: anonymous.fetcher,
      });
      expect(anonymous.calls).toEqual(['https://cdn.example.com/a.png']);
      expect(keap.calls).toEqual(['https://se232.infusionsoft.com/f.png']);
      expect(record).toMatchObject({
        status: 'downloaded',
        url: 'https://cdn.example.com/a.png',
        finalUrl: 'https://se232.infusionsoft.com/f.png',
      });
    });

    it('routes a redirect from a Keap host to a CDN through the anonymous fetcher, never the session', async () => {
      const keap = recording(redirect('https://cdn.example.com/x.png'));
      const anonymous = recording(respond('hi'));
      const { record } = await downloadAsset('https://se232.infusionsoft.com/a.png', {
        keap: keap.fetcher,
        anonymous: anonymous.fetcher,
      });
      expect(keap.calls).toEqual(['https://se232.infusionsoft.com/a.png']);
      expect(anonymous.calls).toEqual(['https://cdn.example.com/x.png']);
      expect(record).toMatchObject({
        status: 'downloaded',
        url: 'https://se232.infusionsoft.com/a.png',
        finalUrl: 'https://cdn.example.com/x.png',
      });
    });

    it('fails after too many redirect hops', async () => {
      const calls: string[] = [];
      const anonymous: AssetFetcher = async (url) => {
        calls.push(url);
        return redirect('https://cdn.example.com/next');
      };
      const { record } = await downloadAsset('https://cdn.example.com/start', {
        keap: recording(respond('')).fetcher,
        anonymous,
      });
      expect(record).toMatchObject({ status: 'failed', reason: 'too many redirects' });
      expect(calls).toHaveLength(6);
    });
  });
});

const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];

describe('anonymousFetcher', () => {
  it('stops reading once the body passes the limit', async () => {
    const fakeFetch = (async () =>
      new Response('0123456789abcdef', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })) as typeof fetch;
    const response = await anonymousFetcher(8, 1000, fakeFetch, publicResolve)(
      'https://cdn.example.com/a.txt',
    );
    await expect(response.body()).rejects.toThrow(/exceeds/);
  });

  it('sends no cookie or key headers, and follows no redirect itself', async () => {
    let seen: RequestInit | undefined;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response('x');
    }) as typeof fetch;
    await anonymousFetcher(8, 1000, fakeFetch, publicResolve)('https://cdn.example.com/a.txt');
    expect(seen?.headers).toBeUndefined();
    expect(seen?.method).toBe('GET');
    expect(seen?.redirect).toBe('manual');
  });

  it('refuses a hostname whose DNS resolves to a private address, without making the request', async () => {
    let fetchCalled = false;
    const fakeFetch = (async () => {
      fetchCalled = true;
      return new Response('x');
    }) as typeof fetch;
    const resolve = async () => [{ address: '10.0.0.5', family: 4 }];
    await expect(
      anonymousFetcher(8, 1000, fakeFetch, resolve)('https://cdn.example.com/a.txt'),
    ).rejects.toThrow(/refused: cdn\.example\.com resolves to a private address/);
    expect(fetchCalled).toBe(false);
  });

  it('makes the request with redirect: manual when DNS resolves to a public address', async () => {
    let seen: RequestInit | undefined;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response('x');
    }) as typeof fetch;
    await anonymousFetcher(8, 1000, fakeFetch, publicResolve)('https://cdn.example.com/a.txt');
    expect(seen?.redirect).toBe('manual');
  });
});

describe('extensionFor', () => {
  it('prefers the content type, then the path, then bin', () => {
    expect(extensionFor('https://x/a', 'image/jpeg; charset=binary')).toBe('jpg');
    expect(extensionFor('https://x/a.PDF', null)).toBe('pdf');
    expect(extensionFor('https://x/download', null)).toBe('bin');
  });
});

describe('asset ledger', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'asset-store-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores bytes once by hash and records every status', async () => {
    const ledger = createAssetLedger('jordan', { updatedAt: '', assets: {} }, root);
    const file = `${'a'.repeat(64)}.png`;
    await ledger.put(
      { url: 'https://cdn.example.com/a.png', status: 'downloaded', sha256: 'a'.repeat(64), file },
      Buffer.from('png'),
    );
    await ledger.put({ url: 'https://x/p?e=~Contact.Email~', status: 'skipped', reason: 'mergeField' }, null);

    expect(await readFile(assetFilePathFor('jordan', file, root), 'utf8')).toBe('png');
    expect(ledger.get('https://cdn.example.com/a.png')?.status).toBe('downloaded');
    expect((await ledger.read(ledger.get('https://cdn.example.com/a.png')!))?.toString()).toBe('png');
    expect(Object.keys(ledger.index().assets)).toHaveLength(2);
  });
});
