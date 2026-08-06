import { describe, expect, it } from 'vitest';
import type { EntityCatalog } from '../src/api/catalog.js';
import { describeNode, nameIndex } from '../src/render/prose.js';
import { makeNode } from './fixtures/graphFixtures.js';

const ctx = (pairs: [string, string][] = []) => ({ names: new Map(pairs) });
const node = (
  style: string,
  overrides: {
    name?: string | null;
    config?: Record<string, string>;
    refs?: Record<string, string | string[]>;
  } = {},
) =>
  makeNode({
    style,
    name: overrides.name ?? null,
    config: overrides.config ?? {},
    references: { tagIds: [], tagCategoryIds: [], ...(overrides.refs ?? {}) },
  });

describe('describeNode', () => {
  it('leads with the operator name, which is the why', () => {
    expect(
      describeNode(node('email', { name: 'Tip 1', refs: { marketingEmailId: '1200' } }), ctx()),
    ).toContain('Tip 1');
  });

  it('states what the node does alongside it', () => {
    expect(describeNode(node('http', { name: 'SMS Reminder' }), ctx())).toBe(
      'Send HTTP Post — "SMS Reminder"',
    );
  });

  it('renders a timer verbatim, doing no arithmetic', () => {
    // Keap already wrote the English. Recomputing it would risk contradicting
    // the builder over the unresolved timezone question in handoff Q2.
    const name = 'Wait at least 3 days and then run on a weekday at 8:00 AM';
    expect(describeNode(node('timerDelay', { name }), ctx())).toContain(name);
  });

  it('decodes entities in a name', () => {
    const out = describeNode(
      node('timerContact', { name: 'Wait until 3 days before the contact&#39;s next Birthday' }),
      ctx(),
    );
    expect(out).toContain("contact's next Birthday");
    expect(out).not.toContain('&#39;');
  });

  it('names the tag on an apply-tag step, which has no name of its own', () => {
    // 0 of 241 tag steps carry a name. Without the reference there is nothing.
    const step = node('tag', { config: { isApply: 'true' }, refs: { tagIds: ['646'] } });
    expect(describeNode(step, ctx([['tag:646', 'Bought']]))).toBe('Applies tag "Bought"');
  });

  it('distinguishes removing a tag from applying one', () => {
    const step = node('tag', { config: { isApply: 'false' }, refs: { tagIds: ['646'] } });
    expect(describeNode(step, ctx([['tag:646', 'Bought']]))).toBe('Removes tag "Bought"');
  });

  it('falls back to the tag id when no catalog name is known', () => {
    const step = node('tag', { config: { isApply: 'true' }, refs: { tagIds: ['646'] } });
    expect(describeNode(step, ctx())).toBe('Applies tag 646');
  });

  it('says a tag step is unconfigured when it references nothing', () => {
    expect(describeNode(node('tag', { config: { isApply: 'true' } }), ctx())).toBe(
      'Tag applied — not configured',
    );
  });

  it('renders a note body from config, decoded and stripped', () => {
    const body = 'I&#39;ve set the event date as <b>November 14th, 2012</b>.';
    expect(describeNode(node('notes', { config: { notes: body } }), ctx())).toBe(
      "Note: I've set the event date as November 14th, 2012.",
    );
  });

  it('prefers the catalog email name over "Untitled Email"', () => {
    // 98 email steps are literally named "Untitled Email".
    const step = node('email', { name: 'Untitled Email', refs: { marketingEmailId: '1200' } });
    expect(describeNode(step, ctx([['email:1200', 'Welcome 1']]))).toBe('Email — "Welcome 1"');
  });

  it('keeps a real email name when the operator set one', () => {
    const step = node('email', { name: 'Tip 1', refs: { marketingEmailId: '1200' } });
    expect(describeNode(step, ctx([['email:1200', 'Welcome 1']]))).toBe('Email — "Tip 1"');
  });

  it('describes a node with no name by its type alone', () => {
    expect(describeNode(node('fulfillment'), ctx())).toBe('Fulfillment List');
  });

  it('never emits a legacy style name', () => {
    const goal = node('newsletterRequest', { name: 'Request E-Book', refs: { webformId: '681' } });
    const out = describeNode(goal, ctx([['webform:681', 'E-Book form']]));
    expect(out).not.toContain('newsletterRequest');
    expect(out).toBe('Web form submitted — "Request E-Book" (E-Book form)');
  });
});

describe('nameIndex', () => {
  it('maps entity ids to names from the catalog', () => {
    const catalog = {
      appName: 'jordan',
      fetchedAt: '2026-08-06T00:00:00.000Z',
      sources: {},
      warnings: [],
      entities: [{ id: 'tag:646', kind: 'tag' as const, name: 'Bought', extra: {} }],
    } satisfies EntityCatalog;
    expect(nameIndex(catalog).get('tag:646')).toBe('Bought');
  });

  it('is empty when there is no catalog', () => {
    expect(nameIndex(undefined).size).toBe(0);
  });
});

describe('names arriving from the catalog', () => {
  it('cleans them, since API names carry newlines and entities too', () => {
    // A real webform name in this account is
    // 'Request our\nEmail Series\n&quot;How to generate\nleads online&quot;'.
    // Appending it raw put an entity and three line breaks into a page.
    const catalog = {
      appName: 'jordan',
      fetchedAt: '2026-08-06T00:00:00.000Z',
      sources: {},
      warnings: [],
      entities: [
        {
          id: 'webform:681',
          kind: 'webform' as const,
          name: 'Request our\nEmail Series\n&quot;How to sell&quot;',
          extra: {},
        },
      ],
    } satisfies EntityCatalog;
    expect(nameIndex(catalog).get('webform:681')).toBe('Request our Email Series "How to sell"');
  });

  it('does not wrap a name in quotes when it already contains one', () => {
    // Otherwise the line reads: — "Request our Series "How to sell"".
    const goal = node('newsletterRequest', {
      name: 'Request our Series "How to sell"',
      refs: { webformId: '681' },
    });
    const out = describeNode(goal, ctx());
    expect(out).toBe('Web form submitted — Request our Series "How to sell"');
  });
});

describe('tagApplied goals', () => {
  it('names the tag it waits for, which is the whole point of the goal', () => {
    // Campaign 987 has goals named "Approved" and "Declined" that BOTH listen
    // for tag 1019. Without naming the tag the page cannot show that they are
    // the same trigger.
    const goal = node('tagApplied', { name: 'Approved', refs: { tagIds: ['1019'] } });
    expect(describeNode(goal, ctx([['tag:1019', '0 - 50 New Contacts']]))).toBe(
      'Tag applied (goal) — "Approved" (waits for "0 - 50 New Contacts")',
    );
  });

  it('falls back to the tag id when the catalog cannot name it', () => {
    const goal = node('tagApplied', { name: 'Approved', refs: { tagIds: ['1019'] } });
    expect(describeNode(goal, ctx())).toBe('Tag applied (goal) — "Approved" (waits for tag 1019)');
  });

  it('says so when it waits for nothing', () => {
    expect(describeNode(node('tagApplied', { name: 'Approved' }), ctx())).toBe(
      'Tag applied (goal) — "Approved" (not configured)',
    );
  });
});

describe('redundant references', () => {
  it('omits the entity name when it just repeats the node name', () => {
    // A web form goal is usually named after its form, so both together read
    // as: Web form submitted — "Sign up" (Sign up).
    const goal = node('newsletterRequest', { name: 'Sign up', refs: { webformId: '681' } });
    expect(describeNode(goal, ctx([['webform:681', 'Sign up']]))).toBe(
      'Web form submitted — "Sign up"',
    );
  });

  it('still shows it when the two genuinely differ', () => {
    const goal = node('newsletterRequest', { name: 'Request E-Book', refs: { webformId: '681' } });
    expect(describeNode(goal, ctx([['webform:681', 'E-Book form']]))).toBe(
      'Web form submitted — "Request E-Book" (E-Book form)',
    );
  });
});
