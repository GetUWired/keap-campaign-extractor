import { describe, expect, it } from 'vitest';
import {
  classifyUrl,
  cssUrls,
  discoverCssUrls,
  discoverHtmlAssets,
  isKeapHosted,
  isPrivateAddress,
  isPrivateHost,
  parseSrcset,
} from '../src/content/assets/discover.js';

describe('classifyUrl', () => {
  it('accepts absolute http(s) and drops the fragment', () => {
    expect(classifyUrl('https://cdn.example.com/a.png#x', null)).toEqual({
      url: 'https://cdn.example.com/a.png',
    });
  });

  it('upgrades protocol-relative URLs to https', () => {
    expect(classifyUrl('//cdn.example.com/a.png', null)).toEqual({
      url: 'https://cdn.example.com/a.png',
    });
  });

  it('resolves relative URLs against a base', () => {
    expect(classifyUrl('img/a.png', 'https://x.example.com/css/site.css')).toEqual({
      url: 'https://x.example.com/css/img/a.png',
    });
  });

  it.each([
    ['https://x.com/p?id=~Contact.Id~', 'mergeField'],
    ['https://x.com/p?id=%7EContact.Id%7E', 'mergeField'],
    ['data:image/png;base64,AAAA', 'inline'],
    ['img/a.png', 'unresolvable'],
    ['ftp://x.com/a.png', 'unsupportedScheme'],
    ['http://192.168.1.4/a.png', 'privateHost'],
    ['http://localhost:3000/a.png', 'privateHost'],
    ['http://[::ffff:127.0.0.1]/a.png', 'privateHost'],
  ])('skips %s as %s', (url, reason) => {
    expect(classifyUrl(url, null)).toMatchObject({ reason });
  });
});

describe('isKeapHosted / isPrivateHost', () => {
  it('recognises Keap hosts and their subdomains only', () => {
    expect(isKeapHosted('https://se232.infusionsoft.com/Download?x=1')).toBe(true);
    expect(isKeapHosted('https://keap.com/a.png')).toBe(true);
    expect(isKeapHosted('https://notkeap.com/a.png')).toBe(false);
    expect(isKeapHosted('not a url')).toBe(false);
  });

  it.each([
    '10.0.0.1',
    '127.0.0.1',
    '172.20.1.1',
    '169.254.1.1',
    '[::1]',
    'localhost',
    '[::ffff:7f00:1]',
    '[::ffff:c0a8:0101]',
    '[fe80::1]',
    '[fc00::1]',
    '[fd12:3456::1]',
    '[::]',
  ])('treats %s as private', (host) => expect(isPrivateHost(host)).toBe(true));

  it('treats public hosts as public', () => {
    expect(isPrivateHost('172.32.0.1')).toBe(false);
    expect(isPrivateHost('cdn.example.com')).toBe(false);
    expect(isPrivateHost('[2606:4700::1111]')).toBe(false);
    expect(isPrivateHost('[::ffff:808:808]')).toBe(false);
  });
});

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '100.64.0.1',
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fe80::1',
    'febf::1',
    'fec0::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:c0a8:101',
  ])('treats %s as private', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '2606:4700::1111', '::ffff:808:808', 'fd::1', 'example.com'])(
    'treats %s as public or not an IP literal',
    (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe('parseSrcset / cssUrls', () => {
  it('takes the URL from each candidate', () => {
    expect(parseSrcset('a.png 1x, https://x.com/b.png 2x')).toEqual(['a.png', 'https://x.com/b.png']);
  });

  it('finds quoted and unquoted url()', () => {
    expect(cssUrls(`a{background:url("x.png")} b{background:url(y.png)} c{src:url('z.woff2')}`)).toEqual(
      ['x.png', 'y.png', 'z.woff2'],
    );
  });
});

describe('discoverHtmlAssets', () => {
  const html = `
    <html><head>
      <link rel="stylesheet" href="https://cdn.example.com/site.css">
      <style>.hero{background:url(https://cdn.example.com/hero.jpg)}</style>
    </head><body>
      <img src="https://cdn.example.com/logo.png" srcset="https://cdn.example.com/logo@2x.png 2x">
      <img src="https://track.example.com/open.gif" width="1" height="1">
      <table><tr><td background="https://cdn.example.com/bg.png"></td></tr></table>
      <div style="background-image:url('https://cdn.example.com/div.png')"></div>
      <a href="https://se232.infusionsoft.com/Download?Id=4">Guide</a>
      <a href="https://se232.infusionsoft.com/files/brochure.pdf">Brochure</a>
      <a href="https://example.com/pricing">Pricing</a>
      <a href="https://example.com/r?u=~Contact.Id~">Unsubscribe</a>
      <img src="https://cdn.example.com/p.png?e=~Contact.Email~">
    </body></html>`;

  const found = discoverHtmlAssets(html, null);

  it('collects images, backgrounds, stylesheets and inline CSS', () => {
    expect(found.download).toEqual(
      expect.arrayContaining([
        'https://cdn.example.com/site.css',
        'https://cdn.example.com/hero.jpg',
        'https://cdn.example.com/logo.png',
        'https://cdn.example.com/logo@2x.png',
        'https://cdn.example.com/bg.png',
        'https://cdn.example.com/div.png',
      ]),
    );
  });

  it('downloads Keap file links and leaves page links as links', () => {
    expect(found.download).toContain('https://se232.infusionsoft.com/Download?Id=4');
    expect(found.download).toContain('https://se232.infusionsoft.com/files/brochure.pdf');
    expect(found.links).toEqual(['https://example.com/pricing', 'https://example.com/r?u=~Contact.Id~']);
  });

  it('skips tracking pixels and merge-field images', () => {
    expect(found.skipped).toEqual(
      expect.arrayContaining([
        { url: 'https://track.example.com/open.gif', reason: 'trackingPixel' },
        { url: 'https://cdn.example.com/p.png?e=~Contact.Email~', reason: 'mergeField' },
      ]),
    );
    expect(found.download).not.toContain('https://track.example.com/open.gif');
  });
});

describe('discoverCssUrls', () => {
  it('resolves url() and @import against the stylesheet', () => {
    const css = `@import "fonts.css"; body{background:url(../img/bg.png)}`;
    expect(discoverCssUrls(css, 'https://cdn.example.com/css/site.css').download).toEqual([
      'https://cdn.example.com/img/bg.png',
      'https://cdn.example.com/css/fonts.css',
    ]);
  });
});
