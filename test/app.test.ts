import { afterEach, describe, expect, it } from 'vitest';
import {
  baseUrlFor,
  campaignDirFor,
  normalizeAppName,
  normalizeFunnelId,
  sessionPathFor,
  verifyIdentity,
} from '../src/app.js';

afterEach(() => {
  delete process.env.KEAP_BASE_URL;
});

describe('normalizeAppName', () => {
  it('accepts real Keap subdomain shapes', () => {
    expect(normalizeAppName('jordan')).toBe('jordan');
    expect(normalizeAppName('ab123')).toBe('ab123');
    expect(normalizeAppName('abc12345')).toBe('abc12345');
  });

  it('lowercases so one app cannot become two directories', () => {
    expect(normalizeAppName('Jordan')).toBe('jordan');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeAppName('  jordan  ')).toBe('jordan');
  });

  it('rejects path traversal', () => {
    expect(() => normalizeAppName('../../../etc')).toThrow(/Invalid app name/);
  });

  it('rejects anything that would redirect us to another host', () => {
    expect(() => normalizeAppName('evil.com/x')).toThrow(/Invalid app name/);
    expect(() => normalizeAppName('evil.com')).toThrow(/Invalid app name/);
  });

  it('rejects empty, over-long and malformed names', () => {
    expect(() => normalizeAppName('')).toThrow(/Invalid app name/);
    expect(() => normalizeAppName('-lead')).toThrow(/Invalid app name/);
    expect(() => normalizeAppName('has space')).toThrow(/Invalid app name/);
    expect(() => normalizeAppName('a'.repeat(64))).toThrow(/Invalid app name/);
  });

  it('accepts a name at exactly the 63 character limit', () => {
    expect(normalizeAppName('a'.repeat(63))).toBe('a'.repeat(63));
  });
});

describe('normalizeFunnelId', () => {
  it('accepts an integer id', () => {
    expect(normalizeFunnelId('584')).toBe('584');
  });

  it('rejects path traversal through the funnel argument', () => {
    expect(() => normalizeFunnelId('../584')).toThrow(/Invalid funnel id/);
    expect(() => normalizeFunnelId('../../etc')).toThrow(/Invalid funnel id/);
  });

  it('rejects non-numeric ids', () => {
    expect(() => normalizeFunnelId('abc')).toThrow(/Invalid funnel id/);
    expect(() => normalizeFunnelId('')).toThrow(/Invalid funnel id/);
  });
});

describe('baseUrlFor', () => {
  it('derives the tenant URL from the app name', () => {
    expect(baseUrlFor('abc12345')).toBe('https://abc12345.infusionsoft.com');
  });

  it('lets KEAP_BASE_URL override the derived host', () => {
    process.env.KEAP_BASE_URL = 'https://staging.example.com/';
    expect(baseUrlFor('jordan')).toBe('https://staging.example.com');
  });

  it('validates the app name even when overridden', () => {
    process.env.KEAP_BASE_URL = 'https://staging.example.com';
    expect(() => baseUrlFor('../evil')).toThrow(/Invalid app name/);
  });
});

describe('path derivation', () => {
  it('puts sessions in a per-app file', () => {
    expect(sessionPathFor('jordan')).toBe('.sessions/jordan.json');
  });

  it('nests campaigns under the app', () => {
    expect(campaignDirFor('jordan', '584')).toBe('artifacts/jordan/campaigns/584');
  });

  it('refuses to build a path from an invalid funnel id', () => {
    expect(() => campaignDirFor('jordan', '../../etc')).toThrow(/Invalid funnel id/);
  });
});

describe('verifyIdentity', () => {
  const expected = { app: 'jordan', funnelId: '584' };

  it('accepts a matching identity', () => {
    const result = verifyIdentity(expected, { appName: 'jordan', funnelId: '584' });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts an identity differing only in case', () => {
    expect(verifyIdentity(expected, { appName: 'Jordan', funnelId: '584' }).ok).toBe(true);
  });

  it('rejects a contradictory app name and names both values', () => {
    const result = verifyIdentity(expected, { appName: 'abc12345', funnelId: '584' });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('jordan');
    expect(result.errors[0]).toContain('abc12345');
  });

  it('rejects a contradictory funnel id', () => {
    const result = verifyIdentity(expected, { appName: 'jordan', funnelId: '999' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /funnel/i.test(e))).toBe(true);
  });

  it('warns but passes when a marker is absent rather than contradictory', () => {
    const result = verifyIdentity(expected, { appName: null, funnelId: null });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });
});

describe('verifyIdentity and imported campaigns', () => {
  const expected = { app: 'se232', funnelId: '12789' };

  it('accepts a campaign imported from another Keap app', () => {
    // Campaign publishing bakes the originating app and its funnelId into
    // draftXml permanently. The importing account assigns its own id, so both
    // markers differ — se232's campaign 12789 says mrz166 / 18.
    const result = verifyIdentity(expected, { appName: 'mrz166', funnelId: '18' });
    expect(result.ok).toBe(true);
    expect(result.importedFrom).toEqual({ appName: 'mrz166', funnelId: '18' });
  });

  it('records the import as a warning rather than passing silently', () => {
    const result = verifyIdentity(expected, { appName: 'mrz166', funnelId: '18' });
    expect(result.warnings.some((w) => /imported from "mrz166"/.test(w))).toBe(true);
  });

  it('still refuses a wrong-host run, where the funnelId matches', () => {
    // The section 8 scenario: a session for one account pointed at another's
    // host. You ask for funnel 12789 and get funnel 12789 from the wrong app,
    // so the ids agree and only the app differs. That must keep failing.
    const result = verifyIdentity(expected, { appName: 'jordan', funnelId: '12789' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /app mismatch/.test(e))).toBe(true);
    expect(result.importedFrom).toBeUndefined();
  });

  it('still refuses a funnel mismatch within the right app', () => {
    // Same app, wrong campaign — a routing bug, not an import.
    const result = verifyIdentity(expected, { appName: 'se232', funnelId: '99' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /funnel mismatch/.test(e))).toBe(true);
  });

  it('reports no import when both markers agree', () => {
    const result = verifyIdentity(expected, { appName: 'se232', funnelId: '12789' });
    expect(result.ok).toBe(true);
    expect(result.importedFrom).toBeUndefined();
  });

  it('does not treat a missing appName as an import', () => {
    // Absent is weaker evidence, not contradictory evidence.
    const result = verifyIdentity(expected, { appName: null, funnelId: '18' });
    expect(result.ok).toBe(false);
    expect(result.importedFrom).toBeUndefined();
  });
});
