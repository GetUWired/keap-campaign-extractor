import { describe, expect, it } from 'vitest';
import { ALLOWED_PATHS, assertAllowed, isAllowed } from '../src/api/guard.js';

describe('api guard', () => {
  it('permits every entity path the catalog needs', () => {
    for (const path of [
      '/crm/rest/v1/tags',
      '/crm/rest/v2/tags',
      '/crm/rest/v1/products',
      '/crm/rest/v2/products',
      '/crm/rest/v1/users',
      '/crm/rest/v2/users',
      '/crm/rest/v1/forms',
      '/crm/rest/v2/webforms',
      '/crm/rest/v2/emails/templates',
      '/crm/rest/v1/account/profile',
    ]) {
      expect(isAllowed('GET', path), path).toBe(true);
    }
  });

  it('refuses contacts, whatever the version or shape', () => {
    // The key is admin-scoped: it CAN read every contact in the account.
    // Nothing but this list stops it.
    for (const path of [
      '/crm/rest/v1/contacts',
      '/crm/rest/v2/contacts',
      '/crm/rest/v1/contacts/1234',
    ]) {
      expect(isAllowed('GET', path), path).toBe(false);
    }
  });

  it('permits /emails/templates while still refusing the /emails parent', () => {
    // The parent is sent-email history — a live run pulled 14,914 records of
    // what went to which contact. The templates sub-resource is the campaign
    // content marketingEmailId points at. Allowing the child must not open
    // the parent.
    expect(isAllowed('GET', '/crm/rest/v2/emails/templates')).toBe(true);
    expect(isAllowed('GET', '/crm/rest/v2/emails')).toBe(false);
    expect(isAllowed('GET', '/crm/rest/v1/emails')).toBe(false);
    expect(isAllowed('GET', '/crm/rest/v2/emails/1234')).toBe(false);
    expect(isAllowed('GET', '/crm/rest/v2/emails?limit=1000')).toBe(false);
  });

  it('refuses other resources holding personal data', () => {
    for (const path of [
      '/crm/rest/v1/companies',
      '/crm/rest/v1/opportunities',
      '/crm/rest/v1/orders',
      '/crm/rest/v1/appointments',
      '/crm/rest/v1/notes',
      '/crm/rest/v1/subscriptions',
    ]) {
      expect(isAllowed('GET', path), path).toBe(false);
    }
  });

  it('refuses every method except GET', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      expect(isAllowed(method, '/crm/rest/v1/tags'), method).toBe(false);
    }
  });

  it('is not fooled by a permitted resource appearing later in the path', () => {
    expect(isAllowed('GET', '/crm/rest/v1/contacts/1/tags')).toBe(false);
    expect(isAllowed('GET', '/evil.com/crm/rest/v1/tags')).toBe(false);
  });

  it('assertAllowed throws on a refused path and passes a permitted one', () => {
    expect(() => assertAllowed('GET', '/crm/rest/v1/contacts')).toThrow(/not on the allowlist/i);
    expect(() => assertAllowed('GET', '/crm/rest/v1/tags')).not.toThrow();
  });

  it('every allowlist entry is anchored at the start', () => {
    // An unanchored pattern is how "/evil.com/crm/rest/v1/tags" gets through.
    for (const pattern of ALLOWED_PATHS) {
      expect(pattern.source.startsWith('^'), pattern.source).toBe(true);
    }
  });
});
