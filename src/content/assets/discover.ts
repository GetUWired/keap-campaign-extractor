import { load } from 'cheerio';
import { isIP } from 'node:net';

export type SkipReason =
  | 'mergeField'
  | 'trackingPixel'
  | 'inline'
  | 'unresolvable'
  | 'unsupportedScheme'
  | 'privateHost';

export interface SkippedUrl {
  url: string;
  reason: SkipReason;
}

export interface DiscoveredAssets {
  /** Resolved URLs to download. */
  download: string[];
  /** Ordinary links — recorded, never followed. */
  links: string[];
  skipped: SkippedUrl[];
}

/**
 * Hosts whose requests carry the Keap session. Everything else is fetched
 * anonymously. Phase 0 records any further Keap file host it sees.
 */
export const KEAP_HOST_SUFFIXES = ['infusionsoft.com', 'infusionsoft.app', 'keap.com', 'keap.app'];

/**
 * Keap-hosted link paths that serve a file rather than a page. Matched as a
 * whole path segment, so `/Download?Id=4` and `/files/brochure.pdf` download
 * while a page such as `/en/downloadable-report` stays a link.
 */
export const KEAP_FILE_PATHS: RegExp[] = [/^\/(?:.*\/)?(?:download|files?|storage)(?:\/|$)/i];

const FILE_EXTENSION =
  /\.(pdf|docx?|xlsx?|pptx?|csv|txt|rtf|zip|mp3|mp4|mov|png|jpe?g|gif|webp|svg)$/i;

/** `~Contact.Id~`, raw or percent-encoded. Such a URL is per-contact and cannot be fetched meaningfully. */
const MERGE_FIELD_IN_URL = /~[A-Za-z][\w.]*~|%7E[A-Za-z][\w.]*%7E/i;

export function isKeapHosted(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return KEAP_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isPrivateIPv4(ip: string): boolean {
  const octets = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!octets) return false;
  const a = Number(octets[1]);
  const b = Number(octets[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    a >= 224 // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved (incl. broadcast)
  );
}

const ipv4FromGroups = (high: number, low: number): string =>
  `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;

/**
 * Expands an IPv6 literal (already validated by `net.isIP`) into eight
 * numeric 16-bit groups, handling `::` compression and an embedded dotted
 * IPv4 tail (e.g. `::ffff:127.0.0.1`).
 */
function expandIPv6(ip: string): number[] | null {
  let address = ip;

  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      return null;
    }
    const [a, b, c, d] = octets as [number, number, number, number];
    const hex1 = ((a << 8) | b).toString(16);
    const hex2 = ((c << 8) | d).toString(16);
    address = `${address.slice(0, lastColon + 1)}${hex1}:${hex2}`;
  }

  const sections = address.split('::');
  if (sections.length > 2) return null;

  let groupStrings: string[];
  if (sections.length === 2) {
    const head = sections[0] === '' ? [] : (sections[0] ?? '').split(':');
    const tailGroups = sections[1] === '' ? [] : (sections[1] ?? '').split(':');
    const missing = 8 - head.length - tailGroups.length;
    if (missing < 0) return null;
    groupStrings = [...head, ...Array<string>(missing).fill('0'), ...tailGroups];
  } else {
    groupStrings = address.split(':');
  }
  if (groupStrings.length !== 8) return null;

  const groups = groupStrings.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  if (groups.some((g) => Number.isNaN(g))) return null;
  return groups;
}

/**
 * An allowlist, failing closed: only global unicast (2000::/3) can be public.
 * `::`, `::1`, IPv4-compatible `::/96`, NAT64 `64:ff9b::/96`, unique-local,
 * link-local, multicast and anything unparseable are all private.
 */
function isPrivateIPv6(ip: string): boolean {
  // A zone id (`fe80::1%eth0`) only ever names a local interface.
  if (ip.includes('%')) return true;
  const groups = expandIPv6(ip);
  if (!groups) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    // IPv4-mapped ::ffff:0:0/96 — the IPv4 rule decides.
    return isPrivateIPv4(ipv4FromGroups(g6, g7));
  }
  if ((g0 & 0xe000) !== 0x2000) return true; // outside 2000::/3
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g0 === 0x2002) return isPrivateIPv4(ipv4FromGroups(g1, g2)); // 6to4 wraps an IPv4
  return false;
}

/**
 * True when `ip` is a bare IP literal (no brackets) that routes to a private,
 * loopback, link-local or otherwise non-public destination. Anything that is
 * not an IP literal returns false — hostnames are handled by `isPrivateHost`
 * (the `.localhost` / `localhost` cases) and DNS resolution.
 */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip.toLowerCase());
  return false;
}

/**
 * URLs come from content someone else authored, and are fetched from the
 * operator's machine. A link to a private address is refused rather than
 * requested.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    return true;
  }
  return isPrivateAddress(host);
}

export function classifyUrl(raw: string, base: string | null): { url: string } | SkippedUrl {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith('data:')) {
    return { url: trimmed.slice(0, 40), reason: 'inline' };
  }
  if (MERGE_FIELD_IN_URL.test(trimmed)) return { url: trimmed, reason: 'mergeField' };

  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  let parsed: URL;
  try {
    parsed = base === null ? new URL(candidate) : new URL(candidate, base);
  } catch {
    return { url: trimmed, reason: 'unresolvable' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: trimmed, reason: 'unsupportedScheme' };
  }
  if (isPrivateHost(parsed.hostname ?? '')) return { url: parsed.href, reason: 'privateHost' };
  parsed.hash = '';
  return { url: parsed.href };
}

export function parseSrcset(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
    .filter((url) => url !== '');
}

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(['"])([^'"]+)\1/gi;

export function cssUrls(css: string): string[] {
  return [...css.matchAll(CSS_URL)].map((m) => m[2]?.trim() ?? '').filter((u) => u !== '');
}

const isTiny = (value: string | undefined): boolean =>
  value !== undefined && ['0', '1', '0px', '1px'].includes(value.trim());

export function discoverHtmlAssets(html: string, base: string | null): DiscoveredAssets {
  const $ = load(html);
  const download = new Set<string>();
  const links = new Set<string>();
  const skipped: SkippedUrl[] = [];

  const consider = (raw: string | undefined): void => {
    if (raw === undefined || raw.trim() === '') return;
    const result = classifyUrl(raw, base);
    if ('reason' in result) skipped.push(result);
    else download.add(result.url);
  };

  $('img').each((_, element) => {
    const img = $(element);
    const src = img.attr('src');
    if (src !== undefined && isTiny(img.attr('width')) && isTiny(img.attr('height'))) {
      skipped.push({ url: src, reason: 'trackingPixel' });
    } else {
      consider(src);
    }
    for (const url of parseSrcset(img.attr('srcset'))) consider(url);
  });
  $('source[srcset]').each((_, element) => {
    for (const url of parseSrcset($(element).attr('srcset'))) consider(url);
  });
  $('[background]').each((_, element) => consider($(element).attr('background')));
  $('link[href]').each((_, element) => {
    const rel = ($(element).attr('rel') ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('stylesheet') || rel.includes('icon')) consider($(element).attr('href'));
  });
  $('[style]').each((_, element) => {
    for (const url of cssUrls($(element).attr('style') ?? '')) consider(url);
  });
  $('style').each((_, element) => {
    for (const url of cssUrls($(element).text())) consider(url);
  });

  $('a[href]').each((_, element) => {
    const href = ($(element).attr('href') ?? '').trim();
    if (href === '' || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    const result = classifyUrl(href, base);
    if (!('reason' in result) && isKeapHosted(result.url)) {
      const path = new URL(result.url).pathname;
      if (FILE_EXTENSION.test(path) || KEAP_FILE_PATHS.some((p) => p.test(path))) {
        download.add(result.url);
        return;
      }
    }
    links.add(href);
  });

  return { download: [...download], links: [...links], skipped };
}

/** Assets a stylesheet pulls in. Followed one level only — see src/content/run.ts. */
export function discoverCssUrls(
  css: string,
  cssUrl: string,
): { download: string[]; skipped: SkippedUrl[] } {
  const download = new Set<string>();
  const skipped: SkippedUrl[] = [];
  const imports = [...css.matchAll(CSS_IMPORT)].map((m) => m[2] ?? '');
  for (const raw of [...cssUrls(css), ...imports]) {
    if (raw === '') continue;
    const result = classifyUrl(raw, cssUrl);
    if ('reason' in result) skipped.push(result);
    else download.add(result.url);
  }
  return { download: [...download], skipped };
}
