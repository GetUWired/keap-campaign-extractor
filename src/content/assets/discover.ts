import { load } from 'cheerio';

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

/** Keap-hosted link paths that serve a file rather than a page. */
export const KEAP_FILE_PATHS: RegExp[] = [/\/download/i, /\/files?\//i, /\/storage\//i];

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

/**
 * URLs come from content someone else authored, and are fetched from the
 * operator's machine. A link to a private address is refused rather than
 * requested.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') {
    return true;
  }
  const octets = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!octets) return false;
  const a = Number(octets[1]);
  const b = Number(octets[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
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
  if (isPrivateHost(parsed.hostname)) return { url: parsed.href, reason: 'privateHost' };
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
