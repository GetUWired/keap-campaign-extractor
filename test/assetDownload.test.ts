import type { LookupAddress } from 'node:dns';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import { type AddressInfo, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetFilePathFor, createAssetLedger } from '../src/content/assets/assetStore.js';
import {
  type AssetFetcher,
  type AssetResponse,
  AssetTooLargeError,
  type ConnectLookup,
  type DnsLookup,
  anonymousFetcher,
  anonymousGet,
  createGuardedLookup,
  downloadAsset,
  extensionFor,
  sessionFetcher,
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

  it('upgrades a plain-http Keap URL to https before sending the session', async () => {
    const keap = recording(respond('k'));
    const { record } = await downloadAsset('http://se232.infusionsoft.com/a.png', {
      keap: keap.fetcher,
      anonymous: recording(respond('')).fetcher,
    });
    expect(keap.calls).toEqual(['https://se232.infusionsoft.com/a.png']);
    expect(record.status).toBe('downloaded');
  });

  it('refuses to store an HTML page Keap returned in place of a file', async () => {
    const { record, bytes } = await downloadAsset('https://se232.infusionsoft.com/Download?Id=4', {
      keap: recording(respond('<html></html>', { contentType: 'text/html; charset=utf-8' })).fetcher,
      anonymous: recording(respond('')).fetcher,
    });
    expect(record).toMatchObject({ status: 'failed', reason: 'Keap returned an HTML page, not a file' });
    expect(record.file).toBeUndefined();
    expect(bytes).toBeNull();
  });

  it('still stores HTML fetched anonymously from a third-party host', async () => {
    const { record } = await downloadAsset('https://cdn.example.com/page.html', {
      keap: recording(respond('')).fetcher,
      anonymous: recording(respond('<html></html>', { contentType: 'text/html' })).fetcher,
    });
    expect(record.status).toBe('downloaded');
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

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** A dns.lookup stand-in that always answers with the given addresses. */
function stubLookup(...addresses: string[]): DnsLookup {
  return (_hostname, _options, callback) =>
    callback(
      null,
      addresses.map((address) => ({ address, family: isIP(address) })),
    );
}

/** Runs the guarded lookup and captures exactly what it hands the socket. */
function runGuarded(lookup: DnsLookup, all: boolean) {
  return new Promise<{ error: Error | null; address: unknown; family: unknown }>((resolve) => {
    const cb: LookupCallback = (error, address, family) => resolve({ error, address, family });
    createGuardedLookup(lookup)('cdn.example.com', { all }, cb);
  });
}

describe('createGuardedLookup', () => {
  it('passes a public answer through in the all: true form', async () => {
    const result = await runGuarded(stubLookup('93.184.216.34', '2606:4700::1111'), true);
    expect(result.error).toBeNull();
    expect(result.address).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);
  });

  it('passes a public answer through in the single-address form', async () => {
    const result = await runGuarded(stubLookup('93.184.216.34'), false);
    expect(result).toEqual({ error: null, address: '93.184.216.34', family: 4 });
  });

  it('refuses when any address is private', async () => {
    const result = await runGuarded(stubLookup('93.184.216.34', '10.0.0.5'), false);
    expect(result.error?.message).toBe(
      'refused: cdn.example.com resolves to a private address 10.0.0.5',
    );
  });

  it('refuses an empty answer', async () => {
    const result = await runGuarded(stubLookup(), true);
    expect(result.error?.message).toMatch(/^refused: cdn\.example\.com/);
  });

  it('passes a DNS error through', async () => {
    const failing: DnsLookup = (_h, _o, callback) =>
      callback(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), []);
    const result = await runGuarded(failing, true);
    expect(result.error?.message).toMatch(/ENOTFOUND/);
  });
});

describe('anonymous transport against a local server', () => {
  let server: Server;
  let port: number;
  let connections: number;
  let seenHeaders: IncomingHttpHeaders[];

  beforeEach(async () => {
    connections = 0;
    seenHeaders = [];
    server = createServer((req, res) => {
      seenHeaders.push(req.headers);
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('0123456789abcdef');
      } else if (req.url === '/moved') {
        res.writeHead(302, { location: 'http://127.0.0.1/elsewhere' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': '2' });
        res.end('ok');
      }
    });
    server.on('connection', () => connections++);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refuses a hostname that rebinds to 127.0.0.1, and never connects', async () => {
    await expect(
      anonymousFetcher(1024, 2000, stubLookup('127.0.0.1'))(`http://rebind.test:${port}/`),
    ).rejects.toThrow('refused: rebind.test resolves to a private address 127.0.0.1');
    expect(connections).toBe(0);
  });

  it('refuses a private IP literal without resolving or connecting', async () => {
    let looked = false;
    const lookup: DnsLookup = (_h, _o, callback) => {
      looked = true;
      callback(null, [{ address: '93.184.216.34', family: 4 }]);
    };
    await expect(anonymousFetcher(1024, 2000, lookup)(`http://127.0.0.1:${port}/`)).rejects.toThrow(
      /refused: 127\.0\.0\.1/,
    );
    expect(looked).toBe(false);
    expect(connections).toBe(0);
  });

  // The transport below has no address guard of its own (anonymousFetcher adds
  // it), which is what lets it reach 127.0.0.1 here.
  const direct: ConnectLookup = (_hostname, options, callback) =>
    options.all
      ? callback(null, [{ address: '127.0.0.1', family: 4 }])
      : callback(null, '127.0.0.1', 4);

  it('sends no cookie, authorization or key header', async () => {
    const response = await anonymousGet(`http://assets.test:${port}/a.png`, direct, 2000, 1024);
    expect((await response.body()).toString()).toBe('ok');
    expect(response).toMatchObject({ status: 200, contentType: 'image/png', contentLength: 2 });
    const headers = seenHeaders[0] ?? {};
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(Object.keys(headers).filter((name) => /key|token|auth/i.test(name))).toEqual([]);
  });

  it('stops reading once the body passes the limit', async () => {
    const response = await anonymousGet(`http://assets.test:${port}/big`, direct, 2000, 8);
    await expect(response.body()).rejects.toBeInstanceOf(AssetTooLargeError);
  });

  it('returns a redirect without following it', async () => {
    const response = await anonymousGet(`http://assets.test:${port}/moved`, direct, 2000, 1024);
    expect(response.status).toBe(302);
    expect(response.location).toBe('http://127.0.0.1/elsewhere');
    expect(seenHeaders).toHaveLength(1);
  });
});

/** A BrowserContext whose request.get answers every URL with one stub response. */
function fakeContext(stub: { status: number; url: string; headers?: Record<string, string>; body?: string }) {
  const requested: string[] = [];
  const context = {
    request: {
      get: async (url: string) => {
        requested.push(url);
        return {
          status: () => stub.status,
          url: () => stub.url,
          headers: () => stub.headers ?? {},
          body: async () => Buffer.from(stub.body ?? ''),
        };
      },
    },
  } as unknown as BrowserContext;
  return { context, requested };
}

describe('sessionFetcher', () => {
  it('treats a redirect to the sign-in page as session expiry', async () => {
    const { context } = fakeContext({
      status: 302,
      url: 'https://se232.infusionsoft.com/Download?Id=4',
      headers: { location: 'https://signin.infusionsoft.com/login?service=x' },
    });
    await expect(
      sessionFetcher(context)('https://se232.infusionsoft.com/Download?Id=4'),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('treats a relative redirect to /login as session expiry', async () => {
    const { context } = fakeContext({
      status: 302,
      url: 'https://se232.infusionsoft.com/Download?Id=4',
      headers: { location: '/app/login' },
    });
    await expect(
      sessionFetcher(context)('https://se232.infusionsoft.com/Download?Id=4'),
    ).rejects.toThrow(/redirected to https:\/\/se232\.infusionsoft\.com\/app\/login/);
  });

  it('returns an ordinary redirect for downloadAsset to route', async () => {
    const { context } = fakeContext({
      status: 302,
      url: 'https://se232.infusionsoft.com/Download?Id=4',
      headers: { location: 'https://cdn.example.com/guide.pdf' },
    });
    const response = await sessionFetcher(context)('https://se232.infusionsoft.com/Download?Id=4');
    expect(response).toMatchObject({ status: 302, location: 'https://cdn.example.com/guide.pdf' });
  });

  it('downloads an asset whose own path merely contains "login"', async () => {
    const url = 'https://se232.infusionsoft.com/images/login-button.png';
    const { context } = fakeContext({
      status: 200,
      url,
      headers: { 'content-type': 'image/png' },
      body: 'png',
    });
    const response = await sessionFetcher(context)(url);
    expect(response.status).toBe(200);
    expect((await response.body()).toString()).toBe('png');
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
