import { describe, expect, it } from 'vitest';
import { buildQueue, campaignRefs, contentRefsOf } from '../src/content/collect.js';
import { itemDirName, itemKey } from '../src/content/types.js';
import { makeNode } from './fixtures/graphFixtures.js';

const email = (cellId: string, id: string) =>
  makeNode({
    cellId,
    style: 'email',
    name: `Email ${id}`,
    references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
  });

describe('itemKey / itemDirName', () => {
  it('keys on kind, attribute and id', () => {
    expect(itemKey({ kind: 'form', attribute: 'webformId', id: '681' })).toBe('form:webformId:681');
  });

  it('uses the bare id for the primary attribute and prefixes the others', () => {
    expect(itemDirName({ kind: 'form', attribute: 'webformId', id: '681' })).toBe('681');
    expect(itemDirName({ kind: 'form', attribute: 'internalFormId', id: '681' })).toBe(
      'internalFormId-681',
    );
  });
});

describe('contentRefsOf', () => {
  it('lifts scalar references', () => {
    const refs = contentRefsOf([email('7', '2048')]);
    expect(refs.map((r) => r.key)).toEqual([
      { kind: 'email', attribute: 'marketingEmailId', id: '2048' },
    ]);
  });

  it('lifts array references, one per value', () => {
    const node = makeNode({
      style: 'landingPage',
      references: { tagIds: [], tagCategoryIds: [], landingPageId: ['11', '12'] },
    });
    expect(contentRefsOf([node]).map((r) => r.key.id)).toEqual(['11', '12']);
  });

  it('keeps two id spaces of the same kind apart', () => {
    const node = makeNode({
      style: 'newsletterRequest',
      references: { tagIds: [], tagCategoryIds: [], webformId: '681', internalFormId: '681' },
    });
    expect(contentRefsOf([node]).map((r) => itemKey(r.key))).toEqual([
      'form:webformId:681',
      'form:internalFormId:681',
    ]);
  });

  it('ignores ids that are not integers', () => {
    const node = makeNode({
      references: { tagIds: [], tagCategoryIds: [], marketingEmailId: '../../etc' },
    });
    expect(contentRefsOf([node])).toEqual([]);
  });
});

describe('campaignRefs', () => {
  it('marks draft-only, published-only and shared steps', () => {
    const refs = campaignRefs(
      '987',
      [email('7', '1'), email('8', '2')],
      [email('7', '1'), email('9', '3')],
    );
    expect(refs.map((r) => [r.use.cellId, r.use.version])).toEqual([
      ['7', 'both'],
      ['8', 'draft'],
      ['9', 'published'],
    ]);
    expect(refs[0]?.use).toMatchObject({ funnelId: '987', style: 'email', name: 'Email 1' });
  });
});

describe('buildQueue', () => {
  it('fetches shared content once and remembers every use', () => {
    const queue = buildQueue([
      ...campaignRefs('1', [email('7', '2048')], []),
      ...campaignRefs('2', [email('4', '2048')], []),
    ]);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.usedBy.map((u) => u.funnelId)).toEqual(['1', '2']);
  });

  it('orders by kind, then attribute, then numeric id', () => {
    const sms = makeNode({
      cellId: '3',
      style: 'sms',
      references: { tagIds: [], tagCategoryIds: [], marketingAutomatedSmsId: '5' },
    });
    const queue = buildQueue(campaignRefs('1', [sms, email('1', '100'), email('2', '9')], []));
    expect(queue.map((i) => itemKey(i))).toEqual([
      'email:marketingEmailId:9',
      'email:marketingEmailId:100',
      'sms:marketingAutomatedSmsId:5',
    ]);
  });
});
