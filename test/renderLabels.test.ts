import { describe, expect, it } from 'vitest';
import { TOOL_LABELS, typeLabel } from '../src/render/labels.js';
import { makeNode } from './fixtures/graphFixtures.js';

const node = (style: string, references: Record<string, string | string[]> = {}) =>
  makeNode({ style, references: { tagIds: [], tagCategoryIds: [], ...references } });

describe('typeLabel — styles that are genuinely tools', () => {
  it('uses the toolbar wording', () => {
    expect(typeLabel(node('timerDelay'))).toBe('Delay Timer');
    expect(typeLabel(node('tag'))).toBe('Apply/Remove Tags');
    expect(typeLabel(node('http'))).toBe('Send HTTP Post');
    expect(typeLabel(node('fulfillment'))).toBe('Fulfillment List');
  });

  it('keeps the generations Keap itself distinguishes', () => {
    // The toolbar shows "Email message" with a NEW badge beside a separate
    // "Email (Legacy)". For a migration that difference is the work, so
    // collapsing them would hide it.
    expect(typeLabel(node('unlayerEmail'))).toBe('Email message');
    expect(typeLabel(node('email'))).toBe('Email (Legacy)');
    expect(typeLabel(node('bardEmail'))).toBe('Email (Legacy)');
    expect(typeLabel(node('http'))).toBe('Send HTTP Post');
    expect(typeLabel(node('httpRequest'))).toBe('Send HTTP Request');
    expect(typeLabel(node('actionSet'))).toBe('Action Set (Legacy)');
  });

  it('lets a tag step stay a tag step even though it references tags', () => {
    // Style must win here: the reference rule would otherwise call an
    // apply-tag STEP a "Tag applied" GOAL.
    const step = node('tag');
    step.references.tagIds = ['646'];
    expect(typeLabel(step)).toBe('Apply/Remove Tags');
  });
});

describe('typeLabel — legacy styles that are only labels', () => {
  it('reads an event-request goal as the landing page it actually uses', () => {
    // eventRequest carries a landingPageId 16 times across the two accounts.
    // It is a landing-page goal somebody labelled "Register for an event".
    expect(typeLabel(node('eventRequest', { landingPageId: '42' }))).toBe(
      'Landing Page submitted',
    );
  });

  it('reads a make-call goal as the opportunity stage move it actually is', () => {
    expect(typeLabel(node('makeCall', { stageId: '7' }))).toBe('Opportunity Stage moved');
  });

  it('reads request-info by whichever form it points at', () => {
    expect(typeLabel(node('requestInfo', { internalFormId: '3' }))).toBe(
      'Internal Form submitted',
    );
    expect(typeLabel(node('requestInfo', { webformId: '681' }))).toBe('Web Form submitted');
  });

  it('reads newsletterRequest the same way, by reference not by name', () => {
    expect(typeLabel(node('newsletterRequest', { webformId: '681' }))).toBe('Web Form submitted');
    expect(typeLabel(node('newsletterRequest', { landingPageId: '42' }))).toBe(
      'Landing Page submitted',
    );
  });

  it('reads a goal carrying only tags as a tag goal', () => {
    const goal = node('eventAttend');
    goal.references.tagIds = ['646'];
    expect(typeLabel(goal)).toBe('Tag applied');
  });

  it('says unconfigured rather than inventing a type for a retired label', () => {
    // facebook, blog, twitter, radioAd and liveEvent carry no reference at all.
    // There is no mechanism to name, and guessing one would be fiction.
    for (const style of ['facebook', 'blog', 'twitter', 'radioAd', 'liveEvent']) {
      expect(typeLabel(node(style)), style).toBe('Goal (unconfigured)');
    }
  });
});

describe('typeLabel — array-valued references', () => {
  it('reads a purchase goal whose products arrive as an array', () => {
    // 361 purchase goals in se232 carry <Array as="purchaseId"> and NONE carry
    // the scalar. Reading attributes alone mislabels every one of them.
    expect(typeLabel(node('purchaseSuccess', { purchaseId: ['1753'] }))).toBe('Product purchased');
  });

  it('still reads the scalar form, which is what jordan uses', () => {
    expect(typeLabel(node('purchaseSuccess', { purchaseId: '7' }))).toBe('Product purchased');
  });

  it('ignores an empty array rather than treating it as a reference', () => {
    expect(typeLabel(node('purchaseSuccess', { purchaseId: [] }))).toBe('Goal (unconfigured)');
  });
});

describe('typeLabel — the newer builders', () => {
  it('distinguishes the new landing page builder from the old', () => {
    expect(typeLabel(node('unlayerLandingPage', { unlayerLandingPageId: '9' }))).toBe(
      'Landing Page',
    );
    expect(typeLabel(node('landingPage', { landingPageId: '42' }))).toBe('Landing Page submitted');
  });

  it('names the SMS channel', () => {
    expect(typeLabel(node('automatedSms'))).toBe('Text message');
  });
});

describe('TOOL_LABELS', () => {
  it('never contains an internal style name as its own label', () => {
    for (const [style, label] of Object.entries(TOOL_LABELS)) {
      expect(label, style).not.toBe(style);
    }
  });
});

describe('typeLabel — generations confirmed against the builder', () => {
  it('names the older web-tracking goal as a legacy generation', () => {
    // `website` is the earlier form of `websiteTrigger`: tracking code on your
    // own pages detecting a contact visiting. All 16 instances are unconfigured.
    expect(typeLabel(node('website'))).toBe('Web Page automation (Legacy)');
    expect(typeLabel(node('websiteTrigger'))).toBe('Web Page automation');
  });

  it('reads a smart form as a web form, via the reference that was previously dead', () => {
    // smartFormInstanceId was in REFERENCE_TOOLS but never in FK_ATTRIBUTES, so
    // it was never lifted and the rule could never match.
    expect(typeLabel(node('smartForm', { smartFormInstanceId: '55' }))).toBe('Web Form submitted');
  });

  it('reads the new landing page builder, likewise', () => {
    expect(typeLabel(node('unlayerLandingPage', { unlayerLandingPageId: '9' }))).toBe(
      'Landing Page',
    );
  });
});
