import { describe, expect, it } from 'vitest';
import { STYLE_LABELS, typeLabel } from '../src/render/labels.js';
import { makeNode } from './fixtures/graphFixtures.js';

const node = (style: string, references: Record<string, string> = {}) =>
  makeNode({ style, references: { tagIds: [], tagCategoryIds: [], ...references } });

describe('typeLabel', () => {
  it('collapses every email builder generation to one label', () => {
    // Keap has shipped several email builders over the years. The generation
    // is an implementation detail; all three reference marketingEmailId.
    for (const style of ['email', 'bardEmail', 'unlayerEmail']) {
      expect(typeLabel(node(style, { marketingEmailId: '1200' })), style).toBe('Email');
    }
  });

  it('collapses both landing page builders to one label', () => {
    expect(typeLabel(node('landingPage', { landingPageId: '42' }))).toBe('Landing page submitted');
    expect(typeLabel(node('convrrtLandingPage'))).toBe('Landing page submitted');
  });

  it('resolves a submission style by what it actually references', () => {
    // newsletterRequest is a web form 106 times, a landing page 20 times and an
    // internal form 7 times. The style alone cannot say which.
    expect(typeLabel(node('newsletterRequest', { webformId: '681' }))).toBe('Web form submitted');
    expect(typeLabel(node('newsletterRequest', { landingPageId: '42' }))).toBe(
      'Landing page submitted',
    );
    expect(typeLabel(node('newsletterRequest', { internalFormId: '3' }))).toBe(
      'Internal form submitted',
    );
  });

  it('says so when a submission references nothing, rather than guessing', () => {
    // 69 of 205 newsletterRequest nodes carry no reference at all.
    expect(typeLabel(node('newsletterRequest'))).toBe('Form submitted (unconfigured)');
  });

  it('uses Keap own default wording for the plain cases', () => {
    expect(typeLabel(node('http'))).toBe('Send HTTP Post');
    expect(typeLabel(node('task'))).toBe('Create Task');
    expect(typeLabel(node('tag'))).toBe('Tag applied');
    expect(typeLabel(node('fulfillment'))).toBe('Fulfillment List');
  });

  it('falls back to the raw style for anything unknown, so it asks to be added', () => {
    expect(typeLabel(node('somethingKeapAddedLater'))).toBe('somethingKeapAddedLater');
  });

  it('never emits a legacy internal style name for a style it knows', () => {
    const forbidden = ['newsletterRequest', 'indicateInterest', 'bardEmail', 'unlayerEmail'];
    for (const style of forbidden) {
      expect(typeLabel(node(style, { webformId: '1' })), style).not.toContain(style);
    }
  });

  it('keeps the four stageId styles distinct until the UI question is settled', () => {
    // Most instances leave stageId unset — 7 of 82 for indicateInterest, 2 of
    // 13 for fileDownload — so calling them all "stage move" would misdescribe
    // the majority.
    const labels = ['stageMove', 'makeCall', 'indicateInterest', 'fileDownload'].map((s) =>
      typeLabel(node(s)),
    );
    expect(new Set(labels).size).toBe(4);
    expect(labels).not.toContain('indicateInterest');
  });
});

describe('STYLE_LABELS', () => {
  it('is a plain table anyone can correct without reading code', () => {
    expect(STYLE_LABELS.http).toBe('Send HTTP Post');
    expect(Object.values(STYLE_LABELS).every((v) => typeof v === 'string')).toBe(true);
  });
});
